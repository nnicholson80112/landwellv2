// End-to-end demo: runs every workflow on sample data with a simulated clock,
// printing every text that would go out. No real messages are sent.
//   npm run demo
// To demo on a real home, set DEMO_ADDRESS, DEMO_VENDOR_NAME, phone numbers etc.

import { MemoryStore } from '../store/store.ts';
import { FakeClock, MIN, HOUR, DAY } from '../engine/clock.ts';
import { createServices, type Services } from '../services.ts';
import { install } from '../workflows/index.ts';
import { seed } from './seed.ts';

const C = { dim: '\x1b[2m', b: '\x1b[1m', blue: '\x1b[34m', green: '\x1b[32m', yellow: '\x1b[33m', mag: '\x1b[35m', r: '\x1b[0m' };

export async function runDemo(opts: { quiet?: boolean } = {}) {
  const say = (s: string) => { if (!opts.quiet) console.log(s); };
  const clock = new FakeClock('2026-10-12T14:00:00Z'); // Mon Oct 12, 8:00 AM Denver
  const store = new MemoryStore();
  const svc: Services = createServices({ store, clock, env: {}, logMessages: false });
  install(svc);
  const s = seed(store, {});
  const outbox = svc.outbox!;
  let shown = 0;
  const names: Record<string, string> = {
    [s.owner.phone]: `OWNER ${s.owner.name}`, [s.tenant.phone!]: `TENANT ${s.tenant.name}`, [s.windowCo.phone!]: `VENDOR ${s.windowCo.name}`,
    [s.plumber.phone!]: `VENDOR ${s.plumber.name}`, [s.handy.phone!]: `VENDOR ${s.handy.name}`,
  };
  const flush = () => {
    for (const m of outbox.sent.slice(shown)) say(`   ${C.green}→ ${names[m.to] ?? m.to}${C.r} ${C.dim}(${m.channel})${C.r}\n     ${m.body.replace(/\n/g, '\n     ')}`);
    shown = outbox.sent.length;
  };
  const scene = (t: string) => say(`\n${C.b}${C.blue}━━ ${t} ━━${C.r}  ${C.dim}${clock.now().toLocaleString('en-US', { timeZone: 'America/Denver', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}${C.r}`);
  const text = async (from: string, body: string, media: string[] = []) => {
    say(`   ${C.yellow}← ${names[from] ?? from}:${C.r} "${body}"${media.length ? ' [photo]' : ''}`);
    svc.engine.emit('message.received', { from, channel: 'sms', body, media, ownerId: s.owner.id, providerMessageId: `sim_${Math.random()}` });
    await svc.engine.drain();
    flush();
  };
  const advance = async (ms: number) => {
    const end = clock.now().getTime() + ms;
    while (clock.now().getTime() < end) {
      clock.advance(Math.min(15 * MIN, end - clock.now().getTime()));
      svc.engine.tick();
      await svc.engine.drain();
    }
    flush();
  };
  const code = (kind: string) => {
    const a = store.list('approvals', (x) => x.kind === kind && x.status === 'pending').pop();
    return a ? a.id.slice(-3).toUpperCase() : '???';
  };
  const owner = s.owner.phone;
  const tenant = s.tenant.phone!;
  const prospect = '+17205550177';

  /* 1 */ scene('1. Tenant reports a repair (no photo yet)');
  await text(tenant, 'Hi! The window screen in the back bedroom is torn and the windows are filthy after the storm.');
  await advance(10 * MIN);
  await text(tenant, 'Here you go', ['https://example.test/photo-screen.jpg']);
  await advance(5 * MIN);

  /* 2 */ scene('2. Your window company accepts, quote is over the $150 limit');
  await text(s.windowCo.phone!, 'YES Wed 10-12 $180');
  say(`   ${C.mag}(owner replies to the approval text)${C.r}`);
  await text(owner, `YES ${code('repair_over_limit')}`);

  /* 3 */ await advance(2 * DAY);
  scene('3. Job finished, invoice matches, books updated');
  await text(s.windowCo.phone!, 'Done, all set. $180');

  /* 4 */ scene('4. Prospect asks about the vacant home');
  await text(prospect, 'Hi, is the Aspen Ct place still available? Do you allow dogs?');
  await text(prospect, 'Is it a safe neighborhood for kids?');
  await text(prospect, 'Can I tour it this weekend?');
  const sh = store.list('showings').pop()!;
  say(`   ${C.mag}(prospect completes the ID check)${C.r}`);
  svc.engine.emit('identity.verified', { refId: sh.id });
  await svc.engine.drain();
  flush();
  await text(prospect, '2');
  await advance(2 * DAY);

  /* 5 */ scene('5. Accommodation request goes straight to the owner');
  await text(tenant, 'Could I install grab bars in the bathroom? I have a disability.');

  /* 6 */ scene('6. Application → screening → owner decides → lease → signatures');
  const app = store.insert('applications', { ownerId: s.owner.id, propertyId: s.vacant.id, applicantName: 'Jordan Morales', phone: prospect, email: 'jordan@example.com', submittedAt: clock.now().toISOString(), status: 'submitted' });
  svc.engine.emit('application.submitted', { applicationId: app.id });
  await svc.engine.drain();
  flush();
  say(`   ${C.mag}(screening partner returns the report)${C.r}`);
  svc.engine.emit('screening.completed', { applicationId: app.id, report: { provider: 'Sample Screening Co', monthlyIncome: 680_000, evictionsLast: { years: 5, count: 0 }, collectionsLast: { years: 2, count: 0 }, referencesConfirmed: 2, pets: 'One 30 lb dog', agencyContact: 'Sample Screening Co, PO Box 1, Denver CO, 800-555-0100' } });
  await svc.engine.drain();
  flush();
  const appApproval = store.list('approvals', (a) => a.kind === 'application').pop()!;
  say(`   ${C.mag}(owner approves in the app with a Nov 1 start)${C.r}`);
  svc.engine.decide(appApproval.id, 'approve', undefined, { startDate: '2026-11-01', months: 12 });
  await svc.engine.drain();
  flush();
  const newLease = store.list('leases', (l) => l.propertyId === s.vacant.id).pop()!;
  say(`   ${C.mag}(Jordan signs on the signing page, then the owner)${C.r}`);
  svc.engine.emit('document.signed', { refId: newLease.id, role: 'tenant', name: 'Jordan Morales' });
  await svc.engine.drain();
  flush();
  svc.engine.emit('document.signed', { refId: newLease.id, role: 'owner', name: s.owner.name });
  await svc.engine.drain();
  flush();

  /* 7 */ clock.set('2026-10-17T05:30:00Z'); // 11:30 PM Denver
  scene('7. Emergency at night (under the $1,000 emergency limit, so no waiting)');
  await text(tenant, 'I smell gas in the kitchen!!');
  await text(s.plumber.phone!, 'YES on my way, 30 min. $250');
  await advance(3 * HOUR);
  await text(s.plumber.phone!, 'Done. Loose fitting on the stove line, tightened and tested. $250');

  /* 8 */ scene('8. Rent: reminders, one payment, late notice with Colorado-capped fee');
  await advance(15 * DAY); // through Nov 1
  const jordanRent = store.list('charges', (c) => c.leaseId === newLease.id && c.kind === 'rent').pop();
  if (jordanRent) {
    say(`   ${C.mag}(Stripe webhook: Jordan's first month settles)${C.r}`);
    svc.engine.emit('payment.received', { chargeId: jordanRent.id, amount: jordanRent.amount, method: 'ach', providerRef: 'pi_demo_1' });
    await svc.engine.drain();
    flush();
  }
  say(`   ${C.dim}(Lisa hasn't paid November rent yet…)${C.r}`);
  await advance(8 * DAY); // late notice after the 5-day grace, fee once 7 days late

  /* 9 */ scene('9. Renewal season for Lisa (lease ends Feb 14; the owner was asked on Oct 17)');
  const ren = store.list('approvals', (a) => a.kind === 'renewal_terms' && a.status === 'pending').pop();
  if (ren) {
    say(`   ${C.mag}(owner offers renewal at the same rent)${C.r}`);
    svc.engine.decide(ren.id, 'offer_renewal', undefined, { rent: s.lease.rent, months: 12 });
    await svc.engine.drain();
    flush();
    await text(tenant, 'Yes! We would love to renew.');
  }

  scene('Summary');
  const runs = svc.engine.runs();
  const by = (st: string) => runs.filter((r) => r.status === st).length;
  say(`   Workflow runs: ${runs.length} (${by('completed')} completed, ${by('waiting')} waiting, ${by('failed')} failed)`);
  for (const r of runs.filter((x) => x.status === 'waiting')) say(`   ${C.dim}• ${r.workflow}: ${r.waitLabel}${C.r}`);
  for (const r of runs.filter((x) => x.status === 'failed')) say(`   ✗ ${r.workflow}: ${r.error?.split('\n')[0]}`);
  say(`   Messages sent: ${outbox.sent.length} · Approvals: ${store.list('approvals').length} · Work orders: ${store.list('workOrders').length} · Owner to-dos: ${store.list('tasks', (t) => t.status === 'open').length}`);
  return { svc, store, runs, outbox, seedData: s };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runDemo().catch((e) => { console.error(e); process.exit(1); });
}
