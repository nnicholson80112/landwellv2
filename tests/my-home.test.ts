// My Home: the tenant's private page and the home guide behind it. No outside service is called.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { MemoryStore } from '../src/store/store.ts';
import { FakeClock } from '../src/engine/clock.ts';
import { createServices } from '../src/services.ts';
import { install } from '../src/workflows/index.ts';
import { seed } from '../src/sim/seed.ts';
import { createApp, LIMIT } from '../src/api/server.ts';
import { RateLimiter, limitsFromEnv } from '../src/api/guard.ts';
import type { AIInput, AIResult, CommunicationAI } from '../src/ai/types.ts';

/** Stands in for Claude and keeps what it was told. */
class Recorder implements CommunicationAI {
  name = 'stub';
  seen: AIInput[] = [];
  async respond(input: AIInput): Promise<AIResult> {
    this.seen.push(input);
    return { intent: 'general', confidence: 0.9, reply: 'Happy to help.', handoff: false, entities: {}, provider: 'stub' };
  }
}

function boot() {
  const L = limitsFromEnv();
  Object.assign(LIMIT, { ip: new RateLimiter(L.ip), owner: new RateLimiter(L.owner), publicForm: new RateLimiter(L.publicForm) });
  const store = new MemoryStore();
  const ai = new Recorder();
  const svc = createServices({ store, clock: new FakeClock('2026-10-12T16:00:00Z'), env: {}, ai });
  install(svc);
  const s = seed(store, {});
  store.kvSet('tokens', 'tok', s.owner.id);
  const { id: _id, ...rest } = s.owner;
  const other = store.insert('owners', { ...rest, email: 'other@example.com', phone: '+17205550999' });
  store.kvSet('tokens', 'tok2', other.id);
  const server = createApp(svc).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (method: string, path: string, body?: unknown, token = 'tok') =>
    fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { store, svc, ai, s, base, call, close: () => server.close() };
}

const GUIDE = {
  welcome: 'Welcome home! <b>Keys</b> are with the manager.',
  contacts: { 'HOA office': '303-555-0100' },
  rules: 'Quiet after 10 PM.',
  tips: { 'Water shut-off': 'Basement, behind the furnace', 'Gate code': '4417' },
};

test('the home guide saves, drops empty parts and follows fair housing rules', async () => {
  const t = boot();
  try {
    const saved = await (await t.call('PATCH', `/api/properties/${t.s.home.id}`, { homeGuide: { ...GUIDE, rules: '  ', contacts: {} } })).json();
    assert.equal(saved.homeGuide.welcome, GUIDE.welcome);
    assert.equal(saved.homeGuide.rules, undefined);
    assert.equal(saved.homeGuide.contacts, undefined);
    assert.equal(saved.address, t.s.home.address, 'the rest of the home is untouched');

    const bad = await t.call('PATCH', `/api/properties/${t.s.home.id}`, { homeGuide: { rules: 'Perfect for singles' } });
    assert.equal(bad.status, 400);
    const err = await bad.json();
    assert.equal(err.field, 'rules');
    assert.match(err.error, /fair housing/);
    assert.equal((await t.call('PATCH', `/api/properties/${t.s.home.id}`, { homeGuide: 'nope' })).status, 400);
  } finally { t.close(); }
});

test('My Home shows the guide privately, and the link can be replaced', async () => {
  const t = boot();
  try {
    await t.call('PATCH', `/api/properties/${t.s.home.id}`, { homeGuide: GUIDE, lock: { kind: 'lockbox', lockboxCode: '9931' } });
    const link = `/api/tenants/${t.s.tenant.id}/my-home`;
    assert.equal((await t.call('POST', link, {}, 'tok2')).status, 404, "another owner can't get the link");

    const { url } = await (await t.call('POST', link, {})).json();
    const path = new URL(url).pathname;
    assert.match(path, /^\/my-home\/[\w-]{32}$/);
    assert.equal((await (await t.call('POST', link, {})).json()).url, url, 'the link stays the same');

    const r = await fetch(t.base + path);
    const html = await r.text();
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(r.headers.get('x-robots-tag'), 'noindex');
    assert.ok(html.includes(t.s.home.address));
    assert.ok(html.includes('&lt;b&gt;Keys&lt;/b&gt;'), 'owner text is escaped');
    for (const part of ['HOA office', 'Quiet after 10 PM.', 'Water shut-off', 'Call 911 first', 'December 15, 2025 to February 14, 2027']) assert.ok(html.includes(part), part);
    assert.ok(!html.includes('9931'), 'never the lockbox code');
    assert.ok(!/<form|<button/.test(html), 'read-only: nothing to pay or submit');
    assert.match(html, /Ask your landlord/, 'no lease signed here yet');

    const fresh = await (await t.call('POST', link, { fresh: true })).json();
    assert.notEqual(fresh.url, url);
    assert.equal((await fetch(t.base + path)).status, 404, 'the old link stops working');
    assert.equal((await fetch(fresh.url.replace(/^.*\/my-home/, t.base + '/my-home'))).status, 200);
    for (const bad of ['nope', '__proto__', 'a'.repeat(32)]) assert.equal((await fetch(`${t.base}/my-home/${bad}`)).status, 404, bad);

    assert.equal((await t.call('POST', `/api/tenants/${t.s.tenant.id}/former`, {})).status < 300, true);
    assert.equal((await fetch(fresh.url.replace(/^.*\/my-home/, t.base + '/my-home'))).status, 404, 'ends when they move out');
    assert.equal((await t.call('POST', link, {})).status, 400);
  } finally { t.close(); }
});

test('the signed lease is on My Home only for the tenant who signed it', async () => {
  const t = boot();
  try {
    const { url } = await (await t.call('POST', `/api/tenants/${t.s.tenant.id}/my-home`, {})).json();
    const path = new URL(url).pathname;
    assert.equal((await fetch(`${t.base}${path}/lease`)).status, 404);

    const sig = (token: string, name: string, role: string, status: string) => t.store.kvSet('sign', token, {
      token, refId: t.s.lease.id, envelopeId: 'env_1', title: 'Residential Lease', body: 'The whole <lease> text', bodyHash: 'x',
      signer: { name, role }, status, signedName: name, signedAt: '2026-01-05T18:00:00Z', ip: '203.0.113.9',
    });
    sig('s1', 'Lisa Chen', 'tenant', 'pending');
    assert.equal((await fetch(`${t.base}${path}/lease`)).status, 404, 'not until they sign');
    sig('s1', 'Lisa Chen', 'tenant', 'signed');
    sig('s2', 'Nate', 'owner', 'signed');

    assert.match(await (await fetch(t.base + path)).text(), /Read your signed lease/);
    const doc = await (await fetch(`${t.base}${path}/lease`)).text();
    assert.ok(doc.includes('The whole &lt;lease&gt; text'));
    assert.ok(doc.includes('Lisa Chen') && doc.includes('January 5, 2026'));
    assert.ok(!doc.includes('203.0.113.9'), 'never the signing IP');
  } finally { t.close(); }
});

test('the AI gets the home guide for tenants of that home, never for prospects', async () => {
  const t = boot();
  try {
    await t.call('PATCH', `/api/properties/${t.s.home.id}`, { homeGuide: GUIDE });
    const ask = async (from: string) => {
      t.ai.seen.length = 0;
      t.svc.engine.emit('message.received', { from, channel: 'sms', body: 'Is the Aspen place available and what are the rules?', media: [], ownerId: t.s.owner.id, providerMessageId: from });
      await t.svc.engine.drain();
      return t.ai.seen.flatMap((i) => i.facts);
    };
    const mine = await ask(t.s.tenant.phone!);
    assert.ok(mine.some((f) => f.label === 'House rules' && f.value === GUIDE.rules));
    assert.ok(mine.some((f) => f.label === 'Gate code'));
    assert.ok(mine.some((f) => f.label === 'Contact: HOA office'));

    const theirs = await ask('+17205550777');
    assert.ok(theirs.length > 0, 'the prospect reached the AI');
    assert.ok(!theirs.some((f) => f.value === GUIDE.rules || f.value === '4417'), 'prospects never get the guide');
  } finally { t.close(); }
});
