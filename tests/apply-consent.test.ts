// The apply form: texting consent is optional and separate (Twilio toll-free and 10DLC rules).
// Unchecked means the applicant hears back by email only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { MemoryStore } from '../src/store/store.ts';
import { SystemClock } from '../src/engine/clock.ts';
import { createServices } from '../src/services.ts';
import { install } from '../src/workflows/index.ts';
import { seed } from '../src/sim/seed.ts';
import { createApp } from '../src/api/server.ts';

async function withApp(fn: (base: string, store: MemoryStore, vacantId: string) => Promise<void>) {
  const store = new MemoryStore();
  const svc = createServices({ store, clock: new SystemClock(), env: {} });
  install(svc);
  const s = seed(store, {});
  const server = createApp(svc).listen(0);
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, store, s.vacant.id);
  } finally {
    server.close();
  }
}
const apply = (base: string, id: string, body: Record<string, unknown>) =>
  fetch(`${base}/api/public/apply/${id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('apply form: the texting box is optional, unchecked, names KeyHelm and links Terms, Privacy and /sms', async () => {
  await withApp(async (base, _store, id) => {
    const html = await (await fetch(`${base}/apply/${id}`)).text();
    const box = /<input type="checkbox" name="sms"[^>]*>/.exec(html)?.[0] ?? '';
    assert.ok(box, 'there is a texting box');
    assert.doesNotMatch(box, /required|checked/, 'optional and unchecked');
    for (const s of ['KeyHelm', 'Not required to apply', 'Message frequency varies', 'Msg and data rates may apply', 'Reply HELP for help or STOP to opt out', 'href="/terms"', 'href="/privacy"', 'href="/sms"']) assert.ok(html.includes(s), s);
    assert.doesNotMatch(html, /name="phone"[^>]*required/, 'phone is optional');
  });
});

test('apply: unchecked box means email only; checked box texts; neither email nor texts is refused', async () => {
  await withApp(async (base, store, id) => {
    assert.equal((await apply(base, id, { name: 'Ann Lee', email: 'ann@example.com', phone: '+17205550161' })).status, 201);
    const ann = store.find('applications', (a) => a.applicantName === 'Ann Lee')!;
    assert.equal(ann.smsConsent, false);
    const toAnn = store.list('messages', (m) => m.direction === 'out' && (m.to === ann.phone || m.to === ann.email));
    assert.ok(toAnn.length && toAnn.every((m) => m.channel === 'email'), 'Ann only gets email');

    assert.equal((await apply(base, id, { name: 'Bo Diaz', phone: '+17205550162', sms: 'yes' })).status, 201);
    const bo = store.find('applications', (a) => a.applicantName === 'Bo Diaz')!;
    assert.equal(bo.smsConsent, true);
    assert.ok(store.list('messages', (m) => m.direction === 'out' && m.to === bo.phone && m.channel === 'sms').length, 'Bo gets texts');

    assert.equal((await apply(base, id, { name: 'Cy Ray', phone: '+17205550163' })).status, 400, 'a phone without the box and no email can\'t be reached');
  });
});
