// Running the live business: admin alerts (limits, channels, what triggers them), one shared
// texting number for every owner, the admin line endpoint, daily backups and /api/admin/status.
// Nothing real is contacted: messages go to the outbox and global fetch is mocked where used.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { MemoryStore } from '../src/store/store.ts';
import { FakeClock, MIN, DAY, addDays, localParts } from '../src/engine/clock.ts';
import { createServices, type Services } from '../src/services.ts';
import { install } from '../src/workflows/index.ts';
import { seed } from '../src/sim/seed.ts';
import { createApp } from '../src/api/server.ts';
import { alertAdmin, flushHeldAlerts, checkPastDue, type AlertRecord } from '../src/ops/alerts.ts';
import { configureOps, noteTick, opsCheck, opsSettled, runDailyBackup } from '../src/ops/index.ts';
import { ownerForLine, ownerByHome, lineCandidates } from '../src/ops/lines.ts';
import { backupDataFile, listBackups, BACKUP_KEEP } from '../src/ops/backup.ts';
import { opsStatus } from '../src/ops/status.ts';
import type { Owner } from '../src/domain/types.ts';

const ADMIN_PHONE = '+13035550900';
const ADMIN_EMAIL = 'ops@keyhelm.test';
const SHARED = '+17205550199'; // the seed owner's line; TWILIO_FROM in these tests
const TOKEN = 'admin-secret-token';

/** Set process env vars for one test; returns a function that puts them back. */
function env(vars: Record<string, string | undefined>) {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) { prev[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  return () => { for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
}

function setup(o: { start?: string; env?: Record<string, string | undefined>; svcEnv?: Record<string, string | undefined> } = {}) {
  const clock = new FakeClock(o.start ?? '2026-10-12T16:00:00Z'); // Mon 10:00 AM Denver
  const store = new MemoryStore();
  const svc = createServices({ store, clock, env: o.svcEnv ?? {} });
  install(svc);
  const logs: string[] = [];
  configureOps(svc, { env: { ADMIN_ALERT_PHONE: ADMIN_PHONE, ADMIN_ALERT_EMAIL: ADMIN_EMAIL, ADMIN_API_TOKEN: TOKEN, TWILIO_FROM: SHARED, ...o.env }, log: (l) => logs.push(l) });
  const s = seed(store, {});
  const outbox = svc.outbox!;
  const alertTexts = () => outbox.sent.filter((m) => m.to === ADMIN_PHONE);
  const alertEmails = () => outbox.sent.filter((m) => m.to === ADMIN_EMAIL);
  const text = async (from: string, body: string, to?: string) => {
    svc.engine.emit('message.received', { from, to, channel: 'sms', body, media: [], ownerId: s.owner.id, providerMessageId: String(Math.random()) });
    await svc.engine.drain(); await opsSettled(svc);
  };
  return { clock, store, svc, s, logs, outbox, alertTexts, alertEmails, text };
}

/** A second owner on the shared number, with a listed home and a tenant in another home. */
function addOwner(svc: Services, a: Owner, o: { name?: string; billing?: Owner['billing'] } = {}) {
  const store = svc.store;
  const pat = store.insert('owners', { name: o.name ?? 'Pat Lee', email: 'pat@example.com', phone: '+13035550170', plan: 'autopilot', timezone: 'America/Denver', createdAt: '2026-10-01T15:00:00.000Z', billing: o.billing ?? { status: 'active', plan: 'autopilot', term: 'monthly', doors: 2, updatedAt: '2026-10-01T15:00:00.000Z' } });
  store.insert('rules', { ...store.get('rules', a.id)!, id: pat.id, ownerId: pat.id });
  const juniper = store.insert('properties', { ownerId: pat.id, address: '15 Juniper Way', city: 'Denver', state: 'CO', zip: '80205', beds: 3, baths: 2, rent: 240_000, deposit: 240_000, status: 'listed', facts: {} });
  const elm = store.insert('properties', { ownerId: pat.id, address: '402 Elm St', city: 'Denver', state: 'CO', zip: '80206', beds: 2, baths: 1, rent: 195_000, deposit: 195_000, status: 'occupied', facts: {} });
  const sam = store.insert('tenants', { ownerId: pat.id, propertyId: elm.id, name: 'Sam Ortiz', phone: '+13035550161', preferredChannel: 'sms', autopay: false, status: 'active' });
  return { pat, juniper, elm, sam };
}

function boom(svc: Services) {
  svc.engine.register({ name: 'boom', title: 'Boom test', description: 'always fails', trigger: { manual: true }, run: async () => { throw new Error('kaboom: the vendor list is empty\n    at fake (file.ts:1:1)'); } });
}

/* ---------------- alerts: limits and channels ---------------- */

test('admin alerts: a text and an email, at most one per kind every 10 minutes, then the held-back count', async () => {
  const t = setup();
  const r1 = await alertAdmin(t.svc, 'run_failed', 'Workflow failed: Repair request', 'It stopped.');
  assert.equal(r1.sent, true);
  assert.deepEqual(r1.channels, ['sms', 'email']);
  assert.match(t.alertTexts()[0].body, /^KeyHelm alert: Workflow failed: Repair request\nIt stopped\./);
  assert.equal(t.alertEmails()[0].subject, 'KeyHelm alert: Workflow failed: Repair request');

  // Same kind within 10 minutes: held, not sent. Same subject twice is folded together.
  t.clock.advance(3 * MIN);
  assert.deepEqual(await alertAdmin(t.svc, 'run_failed', 'Workflow failed: Late rent', 'x'), { sent: false, held: true, channels: [] });
  assert.equal((await alertAdmin(t.svc, 'run_failed', 'Workflow failed: Late rent', 'x')).held, true);
  assert.equal(t.alertTexts().length, 1);
  // Another kind is not held back by it.
  assert.equal((await alertAdmin(t.svc, 'new_customer', 'New KeyHelm customer: Pat', 'y')).sent, true);
  assert.equal(t.alertTexts().length, 2);

  // After 10 minutes the next one goes out and reports what was held back.
  t.clock.advance(8 * MIN);
  const r2 = await alertAdmin(t.svc, 'run_failed', 'Workflow failed: Showing', 'z');
  assert.equal(r2.sent, true);
  assert.equal(r2.reported, 2);
  assert.match(t.alertTexts().pop()!.body, /Also 2 more workflow failure alerts since 10:03 AM .*Workflow failed: Late rent \(x2\)/s);

  // Held alerts with nothing after them still go out, as one summary, once the 10 minutes are up.
  t.clock.advance(1 * MIN);
  await alertAdmin(t.svc, 'run_failed', 'Workflow failed: Renewal', 'w');
  assert.equal(await flushHeldAlerts(t.svc), 0, 'not yet: still inside the 10 minutes');
  t.clock.advance(10 * MIN);
  assert.equal(await flushHeldAlerts(t.svc), 1);
  assert.match(t.alertTexts().pop()!.body, /^KeyHelm alert: 1 more workflow failure alert\n1 more workflow failure alert since .*Workflow failed: Renewal/);
  assert.equal(await flushHeldAlerts(t.svc), 0, 'nothing left to send');
  const rec = t.store.kvGet<AlertRecord>('opsAlerts', 'run_failed')!;
  assert.equal(rec.heldCount, 0);
  assert.equal(rec.sent, 3);
});

test('admin alerts: console only when no phone or email is set; STOP and a broken adapter never throw', async () => {
  const t = setup({ env: { ADMIN_ALERT_PHONE: undefined, ADMIN_ALERT_EMAIL: undefined } });
  const r = await alertAdmin(t.svc, 'past_due', 'Payment past due: Pat', 'Card declined.');
  assert.deepEqual(r.channels, ['console']);
  assert.equal(t.outbox.sent.length, 0, 'nothing texted or emailed');
  assert.ok(t.logs.some((l) => l.includes('Payment past due: Pat') && l.includes('Card declined.')));

  // Phone only → text only.
  configureOps(t.svc, { env: { ADMIN_ALERT_PHONE: '(303) 555-0900' } });
  assert.deepEqual((await alertAdmin(t.svc, 'ai_fallback', 'AI down', 'x')).channels, ['sms']);
  assert.equal(t.alertTexts().length, 1, 'the number is normalized to +1');

  // The admin phone replied STOP: the email still goes.
  configureOps(t.svc, { env: { ADMIN_ALERT_PHONE: ADMIN_PHONE, ADMIN_ALERT_EMAIL: ADMIN_EMAIL } });
  t.store.kvSet('optOut', ADMIN_PHONE, t.clock.now().toISOString());
  assert.deepEqual((await alertAdmin(t.svc, 'backup_failed', 'Backup failed', 'disk full')).channels, ['email']);

  // Twilio and Postmark both down: logged, and the app carries on.
  t.svc.adapters.messaging = { name: 'broken', send: async () => { throw new Error('provider is down'); } };
  t.store.kvDelete('optOut', ADMIN_PHONE);
  const down = await alertAdmin(t.svc, 'unrouted_message', 'No owner matched', 'hello');
  assert.deepEqual(down, { sent: false, channels: [], reported: 0 });
  assert.ok(t.logs.some((l) => /text failed: provider is down/.test(l)));
  assert.ok(t.logs.some((l) => /not delivered: No owner matched/.test(l)));
});

/* ---------------- what triggers alerts ---------------- */

test('a failed workflow still gives the owner a to-do, and alerts the admin with the first error line', async () => {
  const t = setup();
  boom(t.svc);
  t.svc.engine.start('boom', { ownerId: t.s.owner.id });
  await t.svc.engine.drain(); await opsSettled(t.svc);
  assert.equal(t.svc.engine.runs((r) => r.workflow === 'boom')[0].status, 'failed');
  assert.ok(t.store.find('tasks', (x) => x.ownerId === t.s.owner.id && x.title === 'Something needs a look: boom'), 'owner to-do kept');
  const sms = t.alertTexts().pop()!.body;
  assert.match(sms, /^KeyHelm alert: Workflow failed: Boom test\n/);
  assert.match(sms, /for Nate, nate@example\.com stopped with: kaboom: the vendor list is empty/);
  assert.doesNotMatch(sms, /at fake/, 'no stack trace in a text');

  // A run with no owner: no to-do, and a second failure in 10 minutes is held back.
  t.svc.engine.start('boom', {});
  await t.svc.engine.drain(); await opsSettled(t.svc);
  assert.equal(t.store.list('tasks', (x) => x.title === 'Something needs a look: boom').length, 1);
  assert.equal(t.alertTexts().length, 1);
  assert.equal(t.store.kvGet<AlertRecord>('opsAlerts', 'run_failed')!.heldCount, 1);
});

test('a new paying customer (owner.signed_up) alerts the admin once, and onboarding still starts', async () => {
  const t = setup();
  const pat = t.store.insert('owners', { name: 'Pat Lee', email: 'pat@example.com', phone: '+13035550170', plan: 'pro', timezone: 'America/Denver', createdAt: '2026-10-12T15:00:00.000Z', billing: { status: 'active', plan: 'pro', term: 'contract12', doors: 5, updatedAt: '2026-10-12T15:00:00.000Z' } });
  t.svc.engine.emit('owner.signed_up', { ownerId: pat.id });
  await t.svc.engine.drain();
  await opsSettled(t.svc);
  const sms = t.alertTexts();
  assert.equal(sms.length, 1);
  assert.match(sms[0].body, /^KeyHelm alert: New KeyHelm customer: Pat Lee, pat@example\.com, Autopilot Pro, 5 doors\n12-month agreement\. Phone \+13035550170\./);
  assert.ok(t.store.list('messages', (m) => m.to === pat.phone && /Welcome to KeyHelm/.test(m.body)).length === 1, 'onboarding welcome text');

  // The same owner again (a repeated webhook): no second alert. Another owner: their own alert (held if within 10 minutes).
  t.svc.engine.emit('owner.signed_up', { ownerId: pat.id });
  await t.svc.engine.drain();
  await opsSettled(t.svc);
  assert.equal(t.alertTexts().length, 1);
  const old = t.store.insert('owners', { name: 'Old Plan', email: 'old@example.com', phone: '+13035550171', plan: 'plus' as any, timezone: 'America/Denver', createdAt: '2026-10-12T15:00:00.000Z', billing: { status: 'active', plan: 'plus' as any, term: 'monthly', doors: 1, updatedAt: '2026-10-12T15:00:00.000Z' } });
  t.clock.advance(11 * MIN);
  t.svc.engine.emit('owner.signed_up', { ownerId: old.id });
  await t.svc.engine.drain();
  await opsSettled(t.svc);
  assert.match(t.alertTexts().pop()!.body, /Old Plan, old@example\.com, Autopilot Pro, 1 door\n/, "the old 'plus' id reads as Autopilot Pro");
});

test('an emergency no vendor accepted alerts the admin; a routine one does not', async () => {
  const t = setup();
  for (const v of t.store.list('vendors')) t.store.remove('vendors', v.id);
  await t.text(t.s.tenant.phone!, 'Water is pouring from the ceiling, burst pipe!');
  const a = t.store.find('approvals', (x) => x.kind === 'vendor_needed')!;
  assert.ok(a, 'the owner is asked to arrange it');
  assert.ok(t.store.list('messages', (m) => m.to === t.s.owner.phone && m.body.includes('No vendor available')).length >= 1, 'the owner still gets the decision text');
  const sms = t.alertTexts().pop()!.body;
  assert.match(sms, /^KeyHelm alert: Emergency with no vendor: 7610 S Rosemary Cir\n/);
  assert.ok(sms.includes(`(code ${t.store.get('approvals', a.id)!.code})`));
  assert.match(sms, /Owner Nate: \+17205550100\. Tenant Lisa Chen: \+17205550111\./);

  t.svc.engine.emit('maintenance.requested', { ownerId: t.s.owner.id, propertyId: t.s.home.id, tenantId: t.s.tenant.id, summary: 'Closet door is off its track', trade: 'general', urgency: 'routine', photos: ['https://example.test/door.jpg'] });
  await t.svc.engine.drain(); await opsSettled(t.svc);
  assert.equal(t.store.list('approvals', (x) => x.kind === 'vendor_needed').length, 2);
  assert.equal(t.store.kvGet<AlertRecord>('opsAlerts', 'emergency_no_vendor')!.heldCount, 0, 'routine: no alert, not even a held one');
});

test('the AI falling back to rules 3 times in 15 minutes alerts the admin', async () => {
  const realFetch = globalThis.fetch;
  const realError = console.error;
  globalThis.fetch = (async (url: any) => { throw new Error(`blocked in a test: ${String(url)} (connect ECONNREFUSED)`); }) as typeof fetch;
  console.error = () => {};
  try {
    const t = setup({ svcEnv: { AI_PROVIDER: 'http', AI_HTTP_URL: 'http://ai.internal.test/respond' } });
    const ask = () => t.svc.ai.respond({ ownerId: t.s.owner.id, channel: 'sms', senderRole: 'tenant', message: 'When is rent due?', mediaCount: 0, history: [], facts: [], allowedIntents: ['rent_question', 'general'], ownerFirstName: 'Nate', brandName: 'KeyHelm' });
    assert.match((await ask()).provider, /rules\(fallback/);
    t.clock.advance(5 * MIN);
    await ask();
    await opsSettled(t.svc);
    assert.equal(t.alertTexts().length, 0, 'two fallbacks: not yet');
    t.clock.advance(5 * MIN);
    await ask();
    await opsSettled(t.svc);
    const sms = t.alertTexts();
    assert.equal(sms.length, 1);
    assert.match(sms[0].body, /The AI keeps falling back to built-in rules\n3 replies in the last 15 minutes .*ECONNREFUSED/s);
    assert.equal(opsStatus(t.svc).ai.lastError?.message.includes('ECONNREFUSED'), true);
    // Spread out (over 15 minutes apart): no alert.
    t.clock.advance(20 * MIN);
    await ask();
    t.clock.advance(20 * MIN);
    await ask();
    await opsSettled(t.svc);
    assert.equal(t.alertTexts().length, 1);
  } finally {
    globalThis.fetch = realFetch;
    console.error = realError;
  }
});

test('past-due owners: one alert each time an owner falls past due', async () => {
  const t = setup();
  const { pat } = addOwner(t.svc, t.s.owner);
  t.store.update('owners', pat.id, { billing: { ...pat.billing!, status: 'past_due', updatedAt: '2026-10-11T12:00:00.000Z' } });
  assert.deepEqual(await checkPastDue(t.svc), [pat.id]);
  assert.match(t.alertTexts().pop()!.body, /^KeyHelm alert: Payment past due: Pat Lee\nPat Lee, pat@example\.com, \+13035550170: Autopilot, 2 doors, past due since 2026-10-11/);
  assert.deepEqual(await checkPastDue(t.svc), [], 'once per owner');
  t.store.update('owners', pat.id, { billing: { ...pat.billing!, status: 'active' } });
  await checkPastDue(t.svc);
  t.store.update('owners', pat.id, { billing: { ...pat.billing!, status: 'past_due' } });
  t.clock.advance(11 * MIN);
  assert.deepEqual(await checkPastDue(t.svc), [pat.id], 'past due again after paying: alert again');
  assert.equal(t.alertTexts().length, 2);
});

/* ---------------- one shared texting number ---------------- */

test('shared number: tenants route by sender, new people by the home they name, otherwise one question then an admin alert', async () => {
  const restore = env({ TWILIO_AUTH_TOKEN: undefined });
  const t = setup();
  const { pat, juniper, sam } = addOwner(t.svc, t.s.owner);
  const server = createApp(t.svc).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let n = 0;
  const sms = async (from: string, body: string, to = SHARED) => {
    const r = await fetch(`${base}/webhooks/twilio/sms`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ From: from, To: to, Body: body, MessageSid: `SMops${n++}`, NumMedia: '0' }) });
    assert.equal(r.status, 200);
    await t.svc.engine.drain();
    await opsSettled(t.svc);
  };
  const outTo = (to: string) => t.store.list('messages', (m) => m.direction === 'out' && m.to === to);
  try {
    // Two active owners share the number: the door can't pick one.
    const shareEnv = { TWILIO_FROM: SHARED };
    assert.equal(ownerForLine(t.store, SHARED, shareEnv), undefined);
    assert.deepEqual(lineCandidates(t.store, SHARED, shareEnv).map((o) => o.id).sort(), [t.s.owner.id, pat.id].sort());

    // A known tenant of the second owner: routed by who they are.
    await sms(sam.phone!, 'When is rent due?');
    const samIn = t.store.find('messages', (m) => m.direction === 'in' && m.from === sam.phone)!;
    assert.equal(samIn.ownerId, pat.id);
    assert.equal(outTo(sam.phone!).pop()?.ownerId, pat.id, 'answered for the right owner');

    // A new number naming the second owner's listed home.
    await sms('+13035550123', 'Is the Juniper Way house still available?');
    const p1 = t.store.find('prospects', (p) => p.phone === '+13035550123')!;
    assert.equal(p1.ownerId, pat.id);
    assert.equal(p1.interestedIn, juniper.id);
    assert.equal(t.store.find('messages', (m) => m.from === '+13035550123')!.ownerId, pat.id);
    assert.ok(t.store.find('audit', (a) => a.ownerId === pat.id && a.action === 'message.routed'));

    // A new number that names no home: one question (no owner names), nothing created, no alert yet.
    await sms('+13035550124', 'Hi, is it still for rent?');
    const ask = outTo('+13035550124');
    assert.equal(ask.length, 1);
    assert.match(ask[0].body, /^Hi! This is the KeyHelm automated assistant\. This number answers for several rental homes\. Which home address are you asking about\?$/);
    assert.doesNotMatch(ask[0].body, /Nate|Pat/);
    assert.equal(t.store.find('prospects', (p) => p.phone === '+13035550124'), undefined);
    assert.equal(t.alertTexts().length, 0);

    // Still nothing to go on: no second question, and the admin hears about it (once).
    await sms('+13035550124', 'hello??');
    assert.equal(outTo('+13035550124').length, 1, 'asked only once');
    const alert = t.alertTexts().pop()!.body;
    assert.match(alert, /^KeyHelm alert: No owner matched: \+13035550124\n/);
    assert.match(alert, /"hello\?\?"/);
    await sms('+13035550124', 'anyone there');
    assert.equal(t.alertTexts().length, 1, 'one alert per sender');

    // They answer with an address: the whole conversation moves to that owner.
    await sms('+13035550124', '88 Aspen Ct');
    const p2 = t.store.find('prospects', (p) => p.phone === '+13035550124')!;
    assert.equal(p2.ownerId, t.s.owner.id);
    assert.equal(p2.interestedIn, t.s.vacant.id);
    const thread = t.store.list('messages', (m) => m.threadKey === '+13035550124');
    assert.ok(thread.length >= 5);
    assert.ok(thread.every((m) => m.ownerId === t.s.owner.id), 'earlier messages and our question now show in the owner\'s inbox');
    assert.equal(t.store.kvGet('lineAsk', '+13035550124'), undefined);
    assert.match(outTo('+13035550124').pop()!.body, /available.*88 Aspen Ct/, 'their first question ("is it still for rent?") is what gets answered');

    // An emergency from an unknown number: safety words first, the question, and an alert right away.
    t.clock.advance(11 * MIN);
    await sms('+13035550125', 'I smell gas in the kitchen!');
    const gas = outTo('+13035550125').pop()!.body;
    assert.match(gas, /^Please leave the home right away and, once you're outside, call 911 or the gas company's emergency line\. .*Which home address is this about, so I can reach the right person right away\?$/);
    assert.match(t.alertTexts().pop()!.body, /^KeyHelm alert: Possible EMERGENCY, no owner matched: \+13035550125\n.*"I smell gas in the kitchen!"/s);

    // A known tenant calls the shared number with an emergency: the call is put through to their own owner.
    const form = (f: Record<string, string>) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(f) });
    const greet = await (await fetch(`${base}/webhooks/twilio/voice`, form({ From: sam.phone!, To: SHARED, CallSid: 'CAops1' }))).text();
    assert.doesNotMatch(greet, /Nate|Pat/, 'the shared line greets without an owner name');
    const call = await (await fetch(`${base}/webhooks/twilio/voice/turn`, form({ From: sam.phone!, To: SHARED, CallSid: 'CAops1', SpeechResult: 'There is water pouring from the ceiling, burst pipe' }))).text();
    assert.match(call, /<Dial timeout="25">\+13035550170<\/Dial>/, "put through to Pat, Sam's owner");

    // Only one active owner left on the number: straight to them.
    t.store.update('owners', pat.id, { billing: { ...pat.billing!, status: 'canceled' } });
    assert.equal(ownerForLine(t.store, SHARED, shareEnv), t.s.owner.id);
    await sms('+13035550126', 'Do you allow cats?');
    assert.equal(t.store.find('prospects', (p) => p.phone === '+13035550126')?.ownerId, t.s.owner.id);

    // Unanswered "which home?" questions are forgotten after 7 days by the minute-by-minute ops check.
    assert.equal(t.store.kvList('lineAsk').length, 1, 'the gas caller never answered');
    t.clock.advance(8 * DAY);
    await opsCheck(t.svc);
    assert.equal(t.store.kvList('lineAsk').length, 0);
  } finally {
    server.close();
    restore();
  }
});

test('shared number: the home named picks the owner, house numbers break ties, two matches mean ask', () => {
  const t = setup();
  const { pat } = addOwner(t.svc, t.s.owner);
  const owners = t.store.list('owners');
  const twin = t.store.insert('properties', { ownerId: pat.id, address: '12 Aspen Ct', city: 'Aurora', state: 'CO', zip: '80012', beds: 2, baths: 1, rent: 180_000, deposit: 180_000, status: 'listed', facts: {} });
  assert.equal(ownerByHome(t.store, owners, 'Is Aspen Ct open?'), undefined, 'two owners have an Aspen Ct home');
  assert.deepEqual(ownerByHome(t.store, owners, 'Is 12 Aspen still open?'), { ownerId: pat.id, propertyId: twin.id });
  assert.deepEqual(ownerByHome(t.store, owners, 'about 88 aspen ct'), { ownerId: t.s.owner.id, propertyId: t.s.vacant.id });
  assert.deepEqual(ownerByHome(t.store, owners, 'is the rosemary house for rent'), { ownerId: t.s.owner.id, propertyId: t.s.home.id }, 'an occupied home still names its owner');
  assert.equal(ownerByHome(t.store, owners, 'Is the court house nearby? 88'), undefined, 'street words like "court" alone match nothing');
  // Owners without a number of their own get TWILIO_FROM; a number nobody has counts as shared.
  assert.equal(ownerForLine(t.store, '+17205550000', { TWILIO_FROM: SHARED }), undefined);
  assert.equal(ownerForLine(t.store, undefined, { TWILIO_FROM: SHARED }), undefined);
  // A Messaging Service id in TWILIO_FROM (the seed copies it into the demo owner's line): still the shared number.
  t.store.update('owners', t.s.owner.id, { lineNumber: 'MG0123456789abcdef' });
  assert.equal(lineCandidates(t.store, '+17205550199', { TWILIO_FROM: 'MG0123456789abcdef' }).length, 2);
  // The demo owner was seeded before Twilio existed (placeholder line), and a test signup has no homes:
  // the real number still reaches the demo owner, not the empty account.
  t.store.update('owners', t.s.owner.id, { lineNumber: '+17205550199' });
  t.store.update('owners', pat.id, { billing: { ...pat.billing!, status: 'checkout_started' } });
  for (const p of t.store.list('properties', (x) => x.ownerId === pat.id)) t.store.remove('properties', p.id);
  assert.equal(ownerForLine(t.store, '+17205559999', { TWILIO_FROM: '+17205559999' }), t.s.owner.id);
  assert.equal(ownerForLine(t.store, undefined, {}), t.s.owner.id, 'no number given: the one active owner');
});

test('admin line endpoint: give an owner their own number, refuse duplicates, put them back on the shared number', async () => {
  const restore = env({ TWILIO_AUTH_TOKEN: undefined });
  const t = setup();
  const { pat } = addOwner(t.svc, t.s.owner);
  const server = createApp(t.svc).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (id: string, body: unknown, token: string | null = TOKEN) => fetch(`${base}/api/admin/owners/${id}/line`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  try {
    assert.equal((await post(pat.id, { lineNumber: '+17205550777' }, null)).status, 401);
    assert.equal((await post(pat.id, { lineNumber: '+17205550777' }, 'wrong-token-wrong-token')).status, 401);
    assert.equal((await post('own_missing', { lineNumber: '+17205550777' })).status, 404);
    assert.equal((await post(pat.id, {})).status, 400);
    assert.equal((await post(pat.id, { lineNumber: 'call me' })).status, 400);

    const ok = await post(pat.id, { lineNumber: '(720) 555-0777' });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { owner: { id: pat.id, name: 'Pat Lee' }, lineNumber: '+17205550777', shared: false, sharedNumber: SHARED });
    assert.equal(t.store.get('owners', pat.id)!.lineNumber, '+17205550777');
    assert.ok(t.store.find('audit', (a) => a.ownerId === pat.id && a.action === 'owner.line'));
    assert.equal((await post(t.s.owner.id, { lineNumber: '+17205550777' })).status, 409, 'one owner per number');

    // Their own number goes straight to them, even from a new person who names no home.
    assert.equal(ownerForLine(t.store, '+17205550777', { TWILIO_FROM: SHARED }), pat.id);
    const r = await fetch(`${base}/webhooks/twilio/sms`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ From: '+13035550140', To: '+17205550777', Body: 'Hi there, what homes do you have?', MessageSid: 'SMline1', NumMedia: '0' }) });
    assert.equal(r.status, 200);
    await t.svc.engine.drain(); await opsSettled(t.svc);
    assert.equal(t.store.find('prospects', (p) => p.phone === '+13035550140')?.ownerId, pat.id);
    // The shared number is now only the first owner's.
    assert.equal(ownerForLine(t.store, SHARED, { TWILIO_FROM: SHARED }), t.s.owner.id);

    const back = await (await post(pat.id, { lineNumber: SHARED })).json();
    assert.equal(back.shared, true);
    assert.equal(back.lineNumber, null);
    assert.equal(t.store.get('owners', pat.id)!.lineNumber, undefined);
    await post(pat.id, { lineNumber: '+17205550777' });
    assert.equal((await (await post(pat.id, { lineNumber: '' })).json()).shared, true);
    assert.equal(t.store.get('owners', pat.id)!.lineNumber, undefined);
  } finally {
    server.close();
    restore();
  }
});

/* ---------------- backups ---------------- */

test('backups: one atomic copy per day, newest 14 kept, skipped for Postgres, never over a good one with a bad file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kh-ops-backup-'));
  try {
    const dataFile = join(dir, 'keyhelm.json');
    assert.deepEqual(backupDataFile({ dataFile, date: '2026-10-01', env: {} }), { status: 'skipped', reason: 'no data file yet' });
    writeFileSync(dataFile, JSON.stringify({ tables: { owners: {} }, kv: {} }));
    for (let i = 0; i < 16; i++) {
      const r = backupDataFile({ dataFile, date: addDays('2026-10-01', i), env: {} });
      assert.equal(r.status, 'saved');
    }
    const kept = listBackups(dataFile);
    assert.equal(kept.length, BACKUP_KEEP);
    assert.equal(kept[0].date, '2026-10-16');
    assert.equal(kept.at(-1)!.date, '2026-10-03');
    assert.ok(!existsSync(join(dir, 'backups', 'keyhelm-2026-10-01.json')));
    assert.deepEqual(readdirSync(join(dir, 'backups')).filter((f) => f.endsWith('.tmp')), [], 'no temp files left');

    const again = backupDataFile({ dataFile, date: '2026-10-16', env: {} });
    assert.equal(again.status, 'skipped');
    assert.deepEqual(backupDataFile({ dataFile, date: '2026-10-17', env: { DATABASE_URL: 'postgres://db.internal/keyhelm' } }), { status: 'skipped', reason: 'Postgres is in use (DATABASE_URL)' });

    // A damaged data file never replaces a good backup.
    writeFileSync(dataFile, '{"tables": {"owners": ');
    const bad = backupDataFile({ dataFile, date: '2026-10-16', env: {}, force: true });
    assert.equal(bad.status, 'failed');
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'backups', 'keyhelm-2026-10-16.json'), 'utf8')), { tables: { owners: {} }, kv: {} });
    assert.deepEqual(readdirSync(join(dir, 'backups')).filter((f) => f.endsWith('.tmp')), []);

    // From the server: saves the store first, names the file by the local date, alerts on failure.
    const clock = new FakeClock('2026-10-20T05:30:00Z'); // Oct 19, 11:30 PM in Denver
    const store = new MemoryStore({ file: dataFile.replace('keyhelm.json', 'live.json') });
    const svc = createServices({ store, clock, env: {} });
    install(svc);
    const logs: string[] = [];
    configureOps(svc, { env: { ADMIN_ALERT_PHONE: ADMIN_PHONE }, log: (l) => logs.push(l), dataFile: dataFile.replace('keyhelm.json', 'live.json'), storeKind: 'file' });
    seed(store, {});
    const saved = await runDailyBackup(svc);
    assert.equal(saved?.status, 'saved');
    const day = localParts(clock.now(), 'America/Denver').date;
    assert.equal(day, '2026-10-19');
    const copy = JSON.parse(readFileSync(join(dir, 'backups', `keyhelm-${day}.json`), 'utf8'));
    assert.equal(Object.keys(copy.tables.owners).length, 1, 'the copy has the latest data');
    const st = opsStatus(svc);
    assert.equal(st.backup.enabled, true);
    assert.equal(st.backup.last?.date, '2026-10-19');
    assert.ok((st.store.dataFileBytes ?? 0) > 100);
    configureOps(svc, { storeKind: 'postgres' });
    assert.equal(await runDailyBackup(svc), undefined, 'nothing to back up with Postgres');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('backups: a failed backup is logged and alerts the admin', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kh-ops-backup-fail-'));
  try {
    const dataFile = join(dir, 'keyhelm.json');
    writeFileSync(dataFile, 'not json at all');
    const t = setup();
    configureOps(t.svc, { dataFile, storeKind: 'file' });
    const r = await runDailyBackup(t.svc);
    assert.equal(r?.status, 'failed');
    assert.match(t.alertTexts().pop()!.body, /^KeyHelm alert: The daily backup failed\n/);
    assert.ok(t.logs.some((l) => l.startsWith('[backup] FAILED')));
    assert.match(opsStatus(t.svc).backup.lastError?.error ?? '', /doesn't read back as KeyHelm data/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------------- /api/admin/status ---------------- */

test('/api/admin/status: admin token only, and one look at the whole business', async () => {
  const t = setup();
  const { pat } = addOwner(t.svc, t.s.owner);
  t.store.update('owners', pat.id, { billing: { ...pat.billing!, doors: 4 } });
  // A text answered, a repair waiting for the tenant's photo, a failed run, an old decision, a message no owner matched.
  await t.text(t.s.tenant.phone!, 'When is rent due?');
  t.svc.engine.emit('maintenance.requested', { ownerId: t.s.owner.id, propertyId: t.s.home.id, tenantId: t.s.tenant.id, summary: 'Dishwasher will not drain', trade: 'appliance', urgency: 'routine', photos: [] });
  await t.svc.engine.drain(); await opsSettled(t.svc);
  boom(t.svc);
  t.svc.engine.start('boom', { ownerId: t.s.owner.id });
  await t.svc.engine.drain(); await opsSettled(t.svc);
  t.store.insert('approvals', { ownerId: t.s.owner.id, runId: 'run_old', kind: 'application', title: 'Approve applicant', body: '...', options: ['approve', 'deny'], data: {}, status: 'pending', createdAt: new Date(t.clock.now().getTime() - 2 * DAY).toISOString(), code: 'K4P' });
  t.store.insert('messages', { threadKey: '+13035550199', direction: 'in', channel: 'sms', from: '+13035550199', to: SHARED, body: 'who is this?', media: [], at: t.clock.now().toISOString() });
  noteTick(t.svc);
  t.clock.advance(30_000);

  const server = createApp(t.svc).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(`${base}/api/admin/status`)).status, 401);
    assert.equal((await fetch(`${base}/api/admin/status`, { headers: { authorization: 'Bearer nope' } })).status, 401);
    assert.equal((await fetch(`${base}/api/admin/status`, { headers: { authorization: 'Bearer tok' } })).status, 401, 'an owner token is not an admin token');
    const r = await fetch(`${base}/api/admin/status`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(r.status, 200);
    const raw = await r.text();
    assert.ok(!raw.includes(TOKEN), 'no secrets in the answer');
    const s = JSON.parse(raw);
    assert.equal(s.ok, true);
    assert.deepEqual(s.owners, { total: 2, byBilling: { none: 1, active: 1 } });
    assert.deepEqual(s.subscriptions, { active: 1, doors: 4, pastDue: 0 });
    assert.equal(s.runs.waitingByWorkflow.maintenance, 1);
    assert.equal(s.runs.failedLast7Days, 1);
    assert.equal(s.runs.failed[0].workflow, 'boom');
    assert.equal(s.runs.failed[0].error, 'kaboom: the vendor list is empty', 'first error line only');
    assert.equal(s.approvals.pendingOver24h, 1);
    assert.equal(s.approvals.oldest[0].code, 'K4P');
    assert.deepEqual(s.messages.last24h, { in: 2, out: 1 });
    assert.equal(s.messages.unroutedLast7Days, 1);
    assert.equal(s.messages.unrouted[0].body, 'who is this?');
    assert.equal(s.ai.provider, 'rules');
    assert.equal(s.messaging, 'outbox');
    assert.equal(s.engine.secondsSinceTick, 30);
    assert.equal(s.store.kind, 'memory');
    assert.equal(s.backup.enabled, false);
    assert.equal(s.alerts.phoneSet, true);
    assert.equal(s.alerts.recent[0].kind, 'run_failed');
    assert.equal(s.lines.sharedNumber, SHARED);
    assert.equal(s.lines.ownersOnShared, 2);
    for (const k of ['startedAt', 'commit', 'runs', 'approvals', 'messages', 'ai', 'engine', 'store', 'backup', 'alerts', 'lines']) assert.ok(k in s, k);
  } finally {
    server.close();
  }
});
