import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDemo } from '../src/sim/demo.ts';
import { MemoryStore } from '../src/store/store.ts';
import { SystemClock } from '../src/engine/clock.ts';
import { createServices } from '../src/services.ts';
import { install } from '../src/workflows/index.ts';
import { seed } from '../src/sim/seed.ts';
import { createApp } from '../src/api/server.ts';
import type { AddressInfo } from 'node:net';

test('full demo: every workflow runs without failures', async () => {
  const { runs, store } = await runDemo({ quiet: true });
  assert.equal(runs.filter((r) => r.status === 'failed').length, 0);
  const wos = store.list('workOrders');
  assert.equal(wos.length, 2);
  assert.ok(wos.every((w) => w.status === 'paid'));
  assert.ok(store.list('expenses').length >= 2);
  assert.ok(store.list('leases', (l) => l.propertyId === store.list('properties')[1].id && l.status === 'active').length === 1, 'new lease active');
  assert.ok(store.list('charges', (c) => c.kind === 'late_fee').length === 1, 'late fee applied once, after the owner chose it');
  const sentAll = store.list('messages', (m) => m.direction === 'out').map((m) => m.body).join('\n');
  assert.doesNotMatch(sentAll, /pay here|pay\.example|checkout\.stripe|autopay here/i, 'Landwell never sends rent pay links');
  assert.ok(store.list('tasks', (t) => /Reply to/.test(t.title)).length >= 1, 'accommodation request routed to owner');
  assert.ok(store.list('audit', (a) => a.action === 'message.fyi').length >= 1, 'fair-housing question logged and sent to the owner as an FYI');
  const ownerPhone = store.list('owners')[0].phone;
  const sent = store.list('messages', (m) => m.direction === 'out' && m.to !== ownerPhone).map((m) => m.body).join('\n');
  assert.doesNotMatch(sent, /perfect for|family-friendly|safe neighborhood/i);
});

test('API: inbound text, owner dashboard, signing page', async () => {
  const store = new MemoryStore();
  const svc = createServices({ store, clock: new SystemClock(), env: {} });
  install(svc);
  const s = seed(store, {});
  store.kvSet('tokens', 'tok', s.owner.id);
  const server = createApp(svc).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(`${base}/api/dashboard`)).status, 401);
    const r = await fetch(`${base}/api/dev/inbound`, { method: 'POST', headers: { authorization: 'Bearer tok', 'content-type': 'application/json' }, body: JSON.stringify({ from: s.tenant.phone, body: 'The dishwasher is broken' }) });
    const out = await r.json();
    assert.match(out.sent[0].body, /photo/i);
    const dash = await (await fetch(`${base}/api/dashboard`, { headers: { authorization: 'Bearer tok' } })).json();
    assert.equal(dash.openWorkOrders.length, 1);
    assert.ok(dash.inProgress.some((x: any) => /photo/.test(x.waitingFor)));

    // Twilio-style webhook (no signature check without TWILIO_AUTH_TOKEN)
    const tw = await fetch(`${base}/webhooks/twilio/sms`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ From: '+13035550000', To: s.owner.lineNumber!, Body: 'Is 88 Aspen Ct available?', MessageSid: 'SM1', NumMedia: '0' }) });
    assert.equal(tw.status, 200);
    await svc.engine.drain();
    assert.ok(store.find('prospects', (p) => p.phone === '+13035550000'));

    // Voice agent turn
    const v = await (await fetch(`${base}/webhooks/voice`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from: '+13035550001', to: s.owner.lineNumber, transcript: 'Do you allow dogs?', callId: 'c1', turnId: '1' }) })).json();
    assert.match(v.reply, /dog/i);

    // Signing page round trip
    const env = await svc.adapters.esign.send({ documentTitle: 'Lease', body: 'TEXT', refId: s.lease.id, signers: [{ name: 'Lisa Chen', role: 'tenant' }] });
    const token = env.signUrl!.split('/').pop();
    assert.equal((await fetch(`${base}/sign/${token}`)).status, 200);
    const signed = await fetch(`${base}/sign/${token}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'name=Lisa+Chen&consent=yes' });
    assert.equal(signed.status, 200);
    assert.ok(store.list('audit', (a) => a.action === 'document.signed').length === 1);
  } finally {
    server.close();
  }
});

test('owner and vendor can share one phone (owner runs the vendor company)', async () => {
  const store = new MemoryStore();
  const svc = createServices({ store, clock: new SystemClock(), env: {} });
  install(svc);
  const shared = '+17209305782';
  const s = seed(store, { DEMO_OWNER_PHONE: shared, DEMO_VENDOR_PHONE: shared, DEMO_TENANT_PHONE: '+13037481671' });
  const text = async (from: string, body: string, media: string[] = []) => { svc.engine.emit('message.received', { from, channel: 'sms', body, media, ownerId: s.owner.id, providerMessageId: String(Math.random()) }); await svc.engine.drain(); };
  await text('+13037481671', 'The back bedroom window screen is torn', ['https://x/photo.jpg']);
  const wo = store.list('workOrders')[0];
  assert.equal(wo.vendorId, s.windowCo.id);
  await text(shared, 'YES Wed 10-12 $180'); // vendor reply from the shared phone
  const ap = store.list('approvals', (a) => a.status === 'pending')[0];
  assert.ok(ap, 'quote over limit created an approval');
  await text(shared, `YES ${ap.code}`); // owner approval from the same phone
  assert.equal(store.get('workOrders', wo.id)!.status, 'scheduled');
  await text(shared, 'Done $180');
  assert.equal(store.get('workOrders', wo.id)!.status, 'paid');
  assert.equal(s.home.rent, 275_000);
});
