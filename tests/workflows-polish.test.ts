// The everyday edges of the workflows: what tenants, owners, vendors and prospects
// actually text, at the times they actually text it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/store/store.ts';
import { FakeClock, MIN, HOUR, DAY } from '../src/engine/clock.ts';
import { createServices } from '../src/services.ts';
import { install } from '../src/workflows/index.ts';
import { seed } from '../src/sim/seed.ts';
import { looksLikeAddress, noteData, pickOption, textingKeyword, yesNo } from '../src/workflows/inbound-message.ts';
import { newApprovalCode } from '../src/workflows/owner.ts';
import { nextSlots, slotPrefs } from '../src/workflows/showings-listings.ts';
import { niceDate, quietUntil } from '../src/workflows/lib.ts';

function setup(start = '2026-10-12T16:00:00Z' /* Mon 10:00 AM Denver */) {
  const clock = new FakeClock(start);
  const store = new MemoryStore();
  const svc = createServices({ store, clock, env: {} });
  install(svc);
  const s = seed(store, {});
  const text = async (from: string, body: string, media: string[] = []) => {
    svc.engine.emit('message.received', { from, channel: 'sms', body, media, ownerId: s.owner.id, providerMessageId: String(Math.random()) });
    await svc.engine.drain();
  };
  const advance = async (ms: number) => {
    const end = clock.now().getTime() + ms;
    while (clock.now().getTime() < end) {
      clock.advance(Math.min(15 * MIN, end - clock.now().getTime()));
      svc.engine.tick();
      await svc.engine.drain();
    }
  };
  const sentTo = (to: string) => store.list('messages', (m) => m.direction === 'out' && m.to === to);
  const lastTo = (to: string) => sentTo(to).pop()?.body ?? '';
  const pending = (kind?: string) => store.list('approvals', (a) => a.status === 'pending' && (!kind || a.kind === kind));
  const decide = async (id: string, decision: string, data?: Record<string, unknown>) => { svc.engine.decide(id, decision, undefined, data); await svc.engine.drain(); };
  return { clock, store, svc, s, text, advance, sentTo, lastTo, pending, decide };
}

/* ---------------- small pure pieces ---------------- */

test('owner answers: YES/NO only for two choices, numbers for more', () => {
  assert.equal(pickOption(['approve', 'decline'], 'yes'), 'approve');
  assert.equal(pickOption(['approve', 'decline'], 'NO'), 'decline');
  assert.equal(pickOption(['send_demand_notice', 'offer_payment_plan', 'keep_waiting'], 'yes'), undefined, 'YES never picks a risky first option');
  assert.equal(pickOption(['send_demand_notice', 'offer_payment_plan', 'keep_waiting'], '3'), 'keep_waiting');
  assert.deepEqual(noteData('renewal_terms', 'offer_renewal', '$2,850 6 months'), { rent: 285_000, months: 6 });
  assert.deepEqual(noteData('deposit', 'deductions_entered', 'carpet cleaning $150, broken blinds $40'), { deductions: [{ reason: 'carpet cleaning', amount: 15_000 }, { reason: 'broken blinds', amount: 4_000 }] });
  assert.deepEqual(noteData('rent_check', 'received', '$1,500'), { amount: 150_000 });
});

test('texting words: STOP, yes/no, addresses', () => {
  assert.equal(textingKeyword('STOP'), 'stop');
  assert.equal(textingKeyword('Stop.'), 'stop');
  assert.equal(textingKeyword('stop the leak please'), undefined);
  assert.equal(textingKeyword('START'), 'start');
  assert.equal(yesNo('Yes! We would love to renew.'), 'yes');
  assert.equal(yesNo('No, we are moving to Denver'), 'no');
  assert.equal(yesNo('Can we do 6 months instead?'), undefined);
  assert.equal(yesNo('No hot water in the shower'), undefined, 'a repair is not a "no"');
  assert.equal(yesNo('Yes the sink is leaking again'), undefined);
  assert.ok(looksLikeAddress('1420 Elm St, Denver CO 80203'));
  assert.ok(looksLikeAddress('PO Box 55, Golden'));
  assert.ok(!looksLikeAddress('Thanks for everything!'));
});

test('approval codes look like K4P and never repeat among open decisions', () => {
  const { store } = setup();
  const codes = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const c = newApprovalCode(store);
    assert.match(c, /^[A-Z][2-9][A-Z]$/);
    store.insert('approvals', { ownerId: 'o', runId: 'r', kind: 'k', title: 't', body: '', options: ['a', 'b'], data: {}, status: 'pending', createdAt: '', code: c });
    assert.ok(!codes.has(c));
    codes.add(c);
  }
});

test('tour times follow what the prospect asked for', () => {
  const now = '2026-10-14T14:15:00Z'; // Wed 8:15 AM Denver
  const tz = 'America/Denver';
  const hours = { start: '09:00', end: '19:00' };
  const show = (q: string) => nextSlots(now, tz, hours, 3, slotPrefs(q, now, tz)).map((x) => new Date(x).toLocaleString('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric' }));
  assert.deepEqual(show('Can I see it this weekend?'), ['Sat, 9 AM', 'Sat, 12 PM', 'Sat, 3 PM']);
  assert.deepEqual(show('saturday morning'), ['Sat, 9 AM', 'Sat, 10 AM', 'Sat, 11 AM']);
  assert.equal(show('anytime').length, 3);
  // A slot already booked by someone else isn't offered again.
  const taken = nextSlots(now, tz, hours, 1, slotPrefs('saturday morning', now, tz));
  assert.ok(!nextSlots(now, tz, hours, 3, slotPrefs('saturday morning', now, tz), taken).includes(taken[0]));
});

test('quiet hours and friendly dates', () => {
  const { svc, s } = setup();
  assert.equal(quietUntil(svc, s.owner.id, new Date('2026-10-13T05:30:00Z')), '2026-10-13T14:00:00.000Z', '11:30 PM waits until 8:00 AM Denver');
  assert.equal(quietUntil(svc, s.owner.id, new Date('2026-10-13T18:00:00Z')), null);
  assert.equal(niceDate('2026-11-01', '2026-10-12'), 'Sun, Nov 1');
  assert.equal(niceDate('2027-02-15', '2026-10-12'), 'Mon, Feb 15, 2027');
});

/* ---------------- owner texting ---------------- */

test('owner can answer with a bare YES when one decision is open, and gets choices listed otherwise', async () => {
  const { s, text, lastTo, pending, store } = setup();
  await text(s.tenant.phone!, 'The back bedroom window screen is torn', ['https://x/p.jpg']);
  await text(s.windowCo.phone!, 'YES Wed 10-12 $180');
  const ap = pending('repair_over_limit')[0];
  assert.match(lastTo(s.owner.phone), new RegExp(`Reply YES ${ap.code} \\(Approve\\) or NO ${ap.code} \\(Decline\\)`));
  await text(s.owner.phone, 'yes');
  assert.equal(store.get('approvals', ap.id)!.decision, 'approve');
  assert.match(lastTo(s.owner.phone), /^Got it: Approve\./);
  await text(s.owner.phone, 'how are things?');
  assert.match(lastTo(s.owner.phone), /Nothing needs you right now/);
});

test('three-choice decisions take a number; YES gets a gentle "which one"', async () => {
  const { svc, s, text, lastTo, pending, store, decide, advance } = setup('2026-11-07T16:00:00Z');
  const charge = store.insert('charges', { ownerId: s.owner.id, leaseId: s.lease.id, kind: 'rent', amount: 275_000, dueDate: '2026-11-01', paid: 0, status: 'open', period: '2026-11', notices: ['late'] });
  svc.engine.emit('rent.late', { ownerId: s.owner.id, chargeId: charge.id });
  await svc.engine.drain();
  await decide(pending('rent_check')[0].id, 'not_received');
  await advance(DAY);
  await decide(pending('late_fee')[0].id, 'skip_fee');
  await advance(6 * DAY);
  const next = pending('late_rent_next_step')[0];
  assert.ok(next);
  assert.match(lastTo(s.owner.phone), new RegExp(`1 ${next.code} = Send the 10-day demand, 2 ${next.code} = Offer a payment plan, 3 ${next.code} = Keep waiting`));
  await text(s.owner.phone, `YES ${next.code}`);
  assert.match(lastTo(s.owner.phone), /I didn't catch that/);
  await text(s.owner.phone, `2 ${next.code}`);
  assert.equal(store.get('approvals', next.id)!.decision, 'offer_payment_plan');
  // The tenant's answer goes straight to the owner.
  await advance(HOUR);
  assert.match(lastTo(s.tenant.phone!), /open to a payment plan/);
  await text(s.tenant.phone!, 'I can pay $1,000 now and the rest on the 20th');
  assert.match(lastTo(s.tenant.phone!), /sent this to Nate/);
  assert.match(lastTo(s.owner.phone), /payment plan you offered/);
});

/* ---------------- rent ---------------- */

test('rent marked received in the app closes the "Did rent arrive?" question', async () => {
  const { svc, s, pending, store } = setup('2026-11-07T16:00:00Z');
  const charge = store.insert('charges', { ownerId: s.owner.id, leaseId: s.lease.id, kind: 'rent', amount: 275_000, dueDate: '2026-11-01', paid: 0, status: 'open', period: '2026-11', notices: ['late'] });
  svc.engine.emit('rent.late', { ownerId: s.owner.id, chargeId: charge.id });
  await svc.engine.drain();
  assert.equal(pending('rent_check').length, 1);
  svc.engine.emit('payment.received', { chargeId: charge.id, amount: 275_000, method: 'owner_recorded', providerRef: 'app-1' });
  await svc.engine.drain();
  assert.equal(pending().length, 0, 'nothing left waiting on the owner');
  assert.equal(svc.engine.runs((r) => r.workflow === 'late-rent')[0].status, 'completed');
});

test('owner can record a partial payment by text; the late note asks only for the rest', async () => {
  const { svc, s, text, sentTo, pending, store, advance } = setup('2026-11-07T16:00:00Z');
  const charge = store.insert('charges', { ownerId: s.owner.id, leaseId: s.lease.id, kind: 'rent', amount: 275_000, dueDate: '2026-11-01', paid: 0, status: 'open', period: '2026-11', notices: ['late'] });
  svc.engine.emit('rent.late', { ownerId: s.owner.id, chargeId: charge.id });
  await svc.engine.drain();
  await text(s.owner.phone, `YES ${pending('rent_check')[0].code} $1,500`);
  await advance(MIN);
  assert.equal(store.get('charges', charge.id)!.paid, 150_000);
  assert.match(sentTo(s.tenant.phone!).map((m) => m.body).join('\n'), /hasn't received the rest of the rent \(\$1,250\)/);
});

test('owner who never answers "Did rent arrive?" is asked once more after 2 days', async () => {
  const { svc, s, pending, store, advance } = setup('2026-11-07T16:00:00Z');
  const charge = store.insert('charges', { ownerId: s.owner.id, leaseId: s.lease.id, kind: 'rent', amount: 275_000, dueDate: '2026-11-01', paid: 0, status: 'open', period: '2026-11', notices: ['late'] });
  svc.engine.emit('rent.late', { ownerId: s.owner.id, chargeId: charge.id });
  await svc.engine.drain();
  await advance(2 * DAY + HOUR);
  const again = pending('rent_check');
  assert.equal(again.length, 1);
  assert.match(again[0].title, /^Reminder: did rent arrive\?/);
});

/* ---------------- tenants ---------------- */

test('STOP: no more texts to that tenant, owner is told, notices fall back to email', async () => {
  const { s, text, sentTo, lastTo, store, advance } = setup('2026-10-25T16:00:00Z');
  await text(s.tenant.phone!, 'STOP');
  assert.equal(sentTo(s.tenant.phone!).length, 0, 'no reply to STOP (the carrier confirms it)');
  assert.match(lastTo(s.owner.phone), /Lisa Chen replied STOP.*lisa@example\.com/);
  await advance(2 * DAY); // the Nov 1 heads-up goes out on Oct 27
  assert.equal(sentTo(s.tenant.phone!).length, 0);
  assert.match(lastTo(s.tenant.email!), /rent of \$2,750.*due Sun, Nov 1/);
  await text(s.tenant.phone!, 'START');
  assert.ok(!store.kvGet('optOut', s.tenant.phone!));
});

test('renewal: a plain "YES" from the tenant is understood; owner can set the new rent by text', async () => {
  const { svc, s, text, lastTo, pending, store } = setup();
  svc.engine.emit('renewal.due', { leaseId: s.lease.id, ownerId: s.owner.id });
  await svc.engine.drain();
  const ap = pending('renewal_terms')[0];
  await text(s.owner.phone, `YES ${ap.code} $2,850`);
  assert.match(lastTo(s.tenant.phone!), /rent \$2,850\/month/);
  await text(s.tenant.phone!, 'yes');
  assert.match(store.list('messages', (m) => m.direction === 'out' && m.to === s.tenant.phone!).map((m) => m.body).join('\n'), /Wonderful, Lisa/);
  assert.match(lastTo(s.tenant.phone!), /ready\. Please review and sign/);
  assert.equal(store.list('leases', (l) => l.renewalOf === s.lease.id)[0].rent, 285_000);
  assert.match(store.list('messages', (m) => m.to === s.owner.phone).map((m) => m.body).join('\n'), /accepted the renewal/);
});

test('renewal: a question goes to the owner and the offer stays open', async () => {
  const { svc, s, text, lastTo, pending, store } = setup();
  svc.engine.emit('renewal.due', { leaseId: s.lease.id, ownerId: s.owner.id });
  await svc.engine.drain();
  await text(s.owner.phone, `YES ${pending('renewal_terms')[0].code}`);
  svc.engine.emit('renewal.response', { leaseId: s.lease.id, tenantId: s.tenant.id, answer: 'question', body: 'Could we do 6 months instead?' });
  await svc.engine.drain();
  assert.match(lastTo(s.owner.phone), /asked about the renewal.*6 months/);
  await text(s.tenant.phone!, 'No, we are moving closer to work');
  assert.ok(svc.engine.runs((r) => r.workflow === 'move-out').length === 1);
  assert.equal(store.list('leases', (l) => l.renewalOf === s.lease.id).length, 0);
});

test('a tenant saying they want to renew before any offer gets no promise; the owner hears about it', async () => {
  const { s, text, lastTo, store } = setup();
  await text(s.tenant.phone!, "We'd like to renew our lease");
  assert.match(lastTo(s.tenant.phone!), /let Nate know you'd like to stay/);
  assert.equal(store.list('leases', (l) => l.renewalOf === s.lease.id).length, 0);
  assert.ok(store.list('tasks', (t) => /Reply to Lisa/.test(t.title)).length === 1);
});

test('move-out: forwarding address saved, "deductions" without a list asks for one, statement and refund to-do', async () => {
  const { svc, s, text, lastTo, pending, store, advance, clock } = setup('2027-01-20T16:00:00Z');
  svc.engine.emit('moveout.notice', { ownerId: s.owner.id, tenantId: s.tenant.id, leaseId: s.lease.id, date: '2027-02-14' });
  await svc.engine.drain();
  assert.match(lastTo(s.tenant.phone!), /move-out from 7610 S Rosemary Cir is Sun, Feb 14/);
  await text(s.tenant.phone!, 'My new address is 1420 Elm St, Denver CO 80203');
  assert.equal(store.get('tenants', s.tenant.id)!.forwardingAddress, '1420 Elm St, Denver CO 80203');
  clock.set('2027-02-15T17:00:00Z');
  await advance(HOUR);
  assert.equal(store.get('tenants', s.tenant.id)!.status, 'former');
  // A former tenant's text goes to the owner, not the leasing desk.
  await text(s.tenant.phone!, 'When will I get my deposit back?');
  assert.match(lastTo(s.tenant.phone!), /passed this to Nate/);
  assert.equal(store.list('prospects', (p) => p.phone === s.tenant.phone).length, 0);
  // Owner says "deductions" without listing any → asked for the list, nothing sent to the tenant yet.
  await text(s.owner.phone, `NO ${pending('deposit')[0].code}`);
  assert.ok(pending('deposit-list').length === 1);
  assert.doesNotMatch(lastTo(s.tenant.phone!), /Deposit statement/);
  await text(s.owner.phone, `NO ${pending('deposit-list')[0].code} carpet cleaning $150, broken blinds $40`);
  await advance(MIN);
  assert.match(lastTo(s.tenant.phone!), /carpet cleaning: \$150[\s\S]*broken blinds: \$40[\s\S]*Refund: \$2,560/);
  const task = store.list('tasks', (t) => /Send deposit refund/.test(t.title))[0];
  assert.match(task.detail, /1420 Elm St/);
});

test('renewal decided late at night: the tenant gets the offer in the morning', async () => {
  const { svc, s, sentTo, pending, decide, advance } = setup('2026-10-13T05:00:00Z'); // 11 PM Denver
  svc.engine.emit('renewal.due', { leaseId: s.lease.id, ownerId: s.owner.id });
  await svc.engine.drain();
  await decide(pending('renewal_terms')[0].id, 'offer_renewal');
  assert.equal(sentTo(s.tenant.phone!).length, 0, 'held during quiet hours');
  await advance(10 * HOUR);
  const offer = sentTo(s.tenant.phone!).find((m) => /renew your lease/.test(m.body))!;
  assert.ok(offer);
  assert.equal(offer.at, '2026-10-13T14:00:00.000Z', 'sent at 8:00 AM Denver');
});

/* ---------------- repairs ---------------- */

test('vendor "not available" moves on to the next vendor; the tenant hears who is coming and how to reach them', async () => {
  const { s, store, text, lastTo } = setup();
  store.insert('vendors', { ownerId: s.owner.id, name: 'Second Plumbing', trades: ['plumbing'], phone: '+17205550155', emergency: false, preferred: false });
  await text(s.tenant.phone!, 'The toilet is leaking at the base', ['https://x/p.jpg']);
  await text(s.plumber.phone!, 'Sorry, not available this week');
  assert.match(lastTo('+17205550155'), /New job for Nate's rental/);
  await text('+17205550155', 'Yes, 2pm tomorrow $120');
  assert.match(lastTo(s.tenant.phone!), /booked with Second Plumbing \(2pm tomorrow\)\. If you need to reach them: \+17205550155/);
});

test('the same problem texted twice joins the open repair; a later photo is forwarded to the vendor', async () => {
  const { s, store, text, lastTo } = setup();
  await text(s.tenant.phone!, 'The kitchen sink is leaking', ['https://x/1.jpg']);
  await text(s.plumber.phone!, 'YES Thu 9-11 $120');
  await text(s.tenant.phone!, 'The kitchen sink is still leaking');
  assert.equal(store.list('workOrders').length, 1);
  assert.match(lastTo(s.tenant.phone!), /already in progress.*Front Range Plumbing/);
  await text(s.tenant.phone!, 'here', ['https://x/2.jpg']);
  assert.match(lastTo(s.plumber.phone!), /Photo from the resident.*https:\/\/x\/2\.jpg/);
  assert.equal(store.list('workOrders')[0].photos.length, 2);
});

test('a routine repair reported at night texts the vendor in the morning; emergencies go right away', async () => {
  const { s, text, sentTo, advance } = setup('2026-10-13T05:00:00Z'); // 11 PM Denver
  await text(s.tenant.phone!, 'The bedroom window screen is torn', ['https://x/p.jpg']);
  assert.equal(sentTo(s.windowCo.phone!).length, 0);
  await advance(10 * HOUR);
  assert.equal(sentTo(s.windowCo.phone!)[0].at, '2026-10-13T14:00:00.000Z');
  await text(s.tenant.phone!, 'Water is pouring out from under the dishwasher');
  assert.match(sentTo(s.plumber.phone!).pop()!.body, /^EMERGENCY job/);
});

/* ---------------- prospects ---------------- */

test('showings: the street name picks the home, "this weekend" offers Saturday, "Sunday instead" re-offers', async () => {
  const { svc, s, store, text, lastTo } = setup('2026-10-14T14:15:00Z');
  const p = '+17205550188';
  await text(p, 'Is Aspen still available?');
  assert.equal(store.list('prospects', (x) => x.phone === p)[0].interestedIn, s.vacant.id);
  await text(p, 'Can I tour it this weekend?');
  const sh = store.list('showings').pop()!;
  svc.engine.emit('identity.verified', { refId: sh.id });
  await svc.engine.drain();
  assert.match(lastTo(p), /1\) Sat, Oct 17/);
  await text(p, 'Sunday afternoon instead?');
  assert.match(lastTo(p), /other times[\s\S]*1\) Sun, Oct 18, 12:00 PM/);
  await text(p, '1');
  assert.match(lastTo(p), /You're booked for Sun, Oct 18, 12:00 PM/);
  await text(p, 'Can I see it?');
  assert.match(lastTo(p), /You're booked for Sun, Oct 18/, 'no second ID check or tour');
  assert.equal(store.list('showings').length, 1);
});

test('a home that is still occupied is never self-toured', async () => {
  const { svc, s, store, lastTo, pending } = setup();
  store.update('properties', s.home.id, { status: 'listed' });
  const pr = store.insert('prospects', { ownerId: s.owner.id, phone: '+17205550199', interestedIn: s.home.id, optInUpdates: false, createdAt: '' });
  svc.engine.emit('showing.requested', { ownerId: s.owner.id, propertyId: s.home.id, prospectId: pr.id, preferredTimes: [], request: 'Saturday?' });
  await svc.engine.drain();
  assert.match(lastTo('+17205550199'), /Someone still lives at 7610 S Rosemary Cir/);
  assert.ok(pending('showing_request')[0].body.includes('give them proper notice'));
  assert.equal(store.list('showings').length, 0, 'no door code');
});

/* ---------------- owner follow-up ---------------- */

test('an unanswered decision is re-sent once: 2 hours for urgent repairs, a day for the rest', async () => {
  const { s, text, sentTo, advance } = setup();
  await text(s.tenant.phone!, 'No hot water, the water heater stopped working');
  await text(s.plumber.phone!, 'YES today 3-5pm $400');
  const reminders = () => sentTo(s.owner.phone).filter((m) => /^(Still waiting|Reminder):/.test(m.body));
  await advance(HOUR);
  assert.equal(reminders().length, 0);
  await advance(2 * HOUR);
  assert.equal(reminders().length, 1);
  assert.match(reminders()[0].body, /^Still waiting: Repair \$400/);
  await advance(2 * DAY);
  assert.equal(reminders().length, 1, 'only once');
});

test('the front desk knows what rent the owner has marked received', async () => {
  const { svc, s, store, text } = setup('2026-11-03T16:00:00Z');
  const charge = store.insert('charges', { ownerId: s.owner.id, leaseId: s.lease.id, kind: 'rent', amount: 275_000, dueDate: '2026-11-01', paid: 0, status: 'open', period: '2026-11', notices: [] });
  let seen: { label: string; value: string }[] = [];
  svc.ai = { name: 'spy', respond: async (input) => { seen = input.facts; return { intent: 'rent_question', confidence: 0.9, reply: 'Checking.', entities: {}, handoff: false, provider: 'spy' }; } };
  await text(s.tenant.phone!, 'Did my landlord get my rent?');
  assert.ok(seen.some((f) => f.label === 'Rent due 2026-11-01' && /not marked received/.test(f.value)));
  svc.engine.emit('payment.received', { chargeId: charge.id, amount: 275_000, method: 'owner_recorded', providerRef: 'x' });
  await svc.engine.drain();
  await text(s.tenant.phone!, 'Did my landlord get my rent?');
  assert.ok(seen.some((f) => f.label === 'Rent due 2026-11-01' && /marked received by your landlord$/.test(f.value)));
});

test('with a renewal offer out, "No hot water" is a repair, not a "no"', async () => {
  const { svc, s, text, pending, store } = setup();
  svc.engine.emit('renewal.due', { leaseId: s.lease.id, ownerId: s.owner.id });
  await svc.engine.drain();
  await text(s.owner.phone, `YES ${pending('renewal_terms')[0].code}`);
  await text(s.tenant.phone!, 'No hot water in the shower');
  assert.equal(svc.engine.runs((r) => r.workflow === 'move-out').length, 0);
  assert.equal(store.list('workOrders').length, 1);
  assert.equal(svc.engine.runs((r) => r.workflow === 'renewal')[0].status, 'waiting');
});

test('a photo of a different problem starts a new repair instead of joining the open one', async () => {
  const { s, store, text } = setup();
  await text(s.tenant.phone!, 'The bedroom window screen is torn', ['https://x/1.jpg']);
  await text(s.tenant.phone!, 'The dryer is broken too', ['https://x/2.jpg']);
  assert.equal(store.list('workOrders').length, 2);
});
