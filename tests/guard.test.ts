import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { RateLimiter, safeEqual } from '../src/api/guard.ts';
import { BudgetAI, trimInput } from '../src/ai/providers.ts';
import type { AIInput, AIResult, CommunicationAI } from '../src/ai/types.ts';
import { MemoryStore } from '../src/store/store.ts';
import { SystemClock } from '../src/engine/clock.ts';
import { createServices } from '../src/services.ts';
import { install } from '../src/workflows/index.ts';
import { seed } from '../src/sim/seed.ts';
import { createApp, LIMIT } from '../src/api/server.ts';

test('rate limiter: allows a burst, then refills over time', () => {
  let now = 0;
  const rl = new RateLimiter({ capacity: 3, perMs: 3000 }, () => now);
  assert.equal(rl.take('a'), 0); assert.equal(rl.take('a'), 0); assert.equal(rl.take('a'), 0);
  assert.ok(rl.take('a') > 0, 'fourth request waits');
  assert.equal(rl.take('b'), 0, 'other keys are separate');
  now = 1000;
  assert.equal(rl.take('a'), 0, 'one token back after a third of the window');
  assert.ok(rl.blocked('a'));
});

test('secrets compare safely', () => {
  assert.ok(safeEqual('abc', 'abc'));
  assert.ok(!safeEqual('abc', 'abd'));
  assert.ok(!safeEqual('abc', 'abcd'));
});

const input = (ownerId: string): AIInput => ({ ownerId, channel: 'sms', senderRole: 'tenant', message: 'x'.repeat(5000), mediaCount: 0, history: [], facts: [], allowedIntents: ['general'], ownerFirstName: 'Nate', brandName: 'KeyHelm' });

test('AI budget: per-owner and service-wide daily caps, long messages trimmed', async () => {
  let seen = 0;
  const model: CommunicationAI = { name: 'paid', async respond(i: AIInput): Promise<AIResult> { seen = i.message.length; return { intent: 'general', confidence: 1, reply: 'ok', entities: {}, handoff: false, provider: 'paid' }; } };
  const b = new BudgetAI(model, { perOwnerPerDay: 2, totalPerDay: 3 });
  await b.respond(input('o1'));
  assert.ok(seen < 1600, 'message trimmed before the model sees it');
  await b.respond(input('o1'));
  await assert.rejects(b.respond(input('o1')), /owner AI daily limit/);
  await b.respond(input('o2'));
  await assert.rejects(b.respond(input('o3')), /AI daily limit/);
  assert.equal(trimInput(input('x')).message.endsWith('[trimmed]'), true);
});

test('server: legal pages, favicon, cached and compressed site, request limits', async () => {
  const store = new MemoryStore();
  const svc = createServices({ store, clock: new SystemClock(), env: {} });
  install(svc);
  const s = seed(store, {});
  store.kvSet('tokens', 'tok', s.owner.id);
  const server = createApp(svc).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    for (const p of ['/privacy', '/terms', '/cookies', '/refunds', '/accessibility']) {
      const r = await fetch(base + p);
      assert.equal(r.status, 200, p);
      const t = await r.text();
      assert.doesNotMatch(t, /Draft\./, `${p} is owner-approved: no draft notice`);
      assert.doesNotMatch(t, /—/, `${p} has no em dashes`);
    }
    const fav = await fetch(base + '/favicon.svg');
    assert.equal(fav.headers.get('content-type'), 'image/svg+xml');
    const home = await fetch(base + '/', { headers: { 'accept-encoding': 'br' } });
    assert.equal(home.headers.get('content-encoding'), 'br');
    const etag = home.headers.get('etag')!;
    assert.equal((await fetch(base + '/', { headers: { 'if-none-match': etag } })).status, 304, 'unchanged page is not re-sent');
    const html = await (await fetch(base + '/')).text();
    assert.doesNotMatch(html, /\{\{[A-Z_]+\}\}/, 'footer placeholders are filled in');
    assert.doesNotMatch(html, /fonts\.googleapis|fonts\.gstatic/, 'no third-party font requests');
    assert.equal(home.headers.get('x-content-type-options'), 'nosniff');

    // Too-large bodies are refused before they are read.
    const big = await fetch(base + '/api/public/apply/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x'.repeat(300_000) }) });
    assert.equal(big.status, 413);

    // A flood of texts from one number is cut off (each one could cost an AI reply).
    const flood = '+13035550999';
    for (let i = 0; i < 40; i++) await fetch(base + '/webhooks/twilio/sms', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ From: flood, To: s.owner.lineNumber!, Body: `hello ${i}`, MessageSid: `SMf${i}` }) });
    await svc.engine.drain();
    const got = store.list('messages', (m) => m.direction === 'in' && m.from === flood).length;
    assert.ok(got <= 30 && got > 0, `only the first 30 per hour are processed (got ${got})`);

    // Repeated bad tokens from one IP get locked out.
    for (let i = 0; i < 20; i++) await fetch(base + '/api/dashboard', { headers: { authorization: 'Bearer wrong' } });
    assert.equal((await fetch(base + '/api/dashboard', { headers: { authorization: 'Bearer tok' } })).status, 429);
  } finally {
    server.close();
    LIMIT.authFail = new RateLimiter({ capacity: 20, perMs: 3_600_000 });
  }
});
