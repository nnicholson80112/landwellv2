// Owner sign-in and the owner app's API: checkout → setup link → password → session → /api/me,
// sign in/out, limits, CSRF, bearer tokens, other owners' records, decisions with data,
// the setup checklist, messages (STOP respected) and admin sign-in links.
// Every outside service is mocked: global fetch only answers for api.stripe.com and this server.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { MemoryStore } from '../src/store/store.ts';
import { FakeClock, DAY, MIN } from '../src/engine/clock.ts';
import { createServices } from '../src/services.ts';
import { install } from '../src/workflows/index.ts';
import { seed, SAMPLE_LEASE } from '../src/sim/seed.ts';
import { createApp, LIMIT } from '../src/api/server.ts';
import { RateLimiter, limitsFromEnv } from '../src/api/guard.ts';
import { hashPassword, passwordProblem, resetLoginLimits, safeNext, verifyPassword } from '../src/api/auth.ts';
import type { OutboxMessaging } from '../src/adapters/mock.ts';

const PW = 'blue spruce porch light';

function resetLimits() {
  resetLoginLimits();
  const L = limitsFromEnv();
  Object.assign(LIMIT, { ip: new RateLimiter(L.ip), owner: new RateLimiter(L.owner), authFail: new RateLimiter(L.authFail), signup: new RateLimiter(L.signup), publicForm: new RateLimiter(L.publicForm) });
}

/** Set env vars for one test; returns a function that puts them back. */
function env(vars: Record<string, string | undefined>) {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) { prev[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  return () => { for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
}

/** Only this test server and a fake Stripe answer. Anything else is a test bug. */
function mockFetch(stripe: (url: string, init?: RequestInit) => Response) {
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: any, init?: any) => {
    const u = String(url);
    if (u.startsWith('http://127.0.0.1:')) return real(url, init);
    if (u.startsWith('https://api.stripe.com/')) return stripe(u, init);
    throw new Error(`blocked outside call in a test: ${u}`);
  }) as typeof fetch;
  return () => { globalThis.fetch = real; };
}

function boot(start = '2026-10-12T16:00:00Z' /* Mon 10:00 AM Denver */) {
  resetLimits();
  const clock = new FakeClock(start);
  const store = new MemoryStore();
  const svc = createServices({ store, clock, env: {} });
  install(svc);
  const s = seed(store, {});
  store.kvSet('tokens', 'tok', s.owner.id);
  const server = createApp(svc).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const outbox = svc.adapters.messaging as OutboxMessaging;
  /** A request signed in with the session cookie (plus the X-KeyHelm header unless told otherwise). */
  const call = (cookie: string, method: string, path: string, body?: unknown, headers: Record<string, string> = { 'x-keyhelm': '1' }) =>
    fetch(base + path, { method, redirect: 'manual', headers: { cookie, 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const bearer = (method: string, path: string, body?: unknown) => fetch(base + path, { method, headers: { authorization: 'Bearer tok', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const form = (path: string, fields: Record<string, string>, headers: Record<string, string> = {}) =>
    fetch(base + path, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(fields) });
  const login = async (email: string, password = PW) => {
    const r = await form('/login', { email, password });
    assert.equal(r.status, 303, `sign in as ${email}`);
    return cookieOf(r)!;
  };
  /** Give an owner a password and sign them in. */
  const signInAs = async (ownerId: string) => {
    store.update('owners', ownerId, { passwordHash: await hashPassword(PW) });
    return login(store.get('owners', ownerId)!.email);
  };
  const text = async (from: string, body: string) => {
    svc.engine.emit('message.received', { from, channel: 'sms', body, media: [], ownerId: s.owner.id, providerMessageId: String(Math.random()) });
    await svc.engine.drain();
  };
  return { clock, store, svc, s, server, base, outbox, call, bearer, form, login, signInAs, text, close: () => server.close() };
}

const cookieOf = (r: Response) => r.headers.getSetCookie().map((c) => c.split(';')[0]).find((c) => c.startsWith('kh_session='));
const rawCookie = (r: Response) => r.headers.getSetCookie().find((c) => c.startsWith('kh_session=')) ?? '';

/* ---------------- passwords ---------------- */

test('passwords: salted scrypt, checked in constant time, plain rules; next links stay on this site', async () => {
  const a = await hashPassword(PW), b = await hashPassword(PW);
  assert.match(a, /^scrypt\$16384\$8\$1\$[\w-]+\$[\w-]+$/);
  assert.notEqual(a, b, 'every hash has its own salt');
  assert.equal(await verifyPassword(PW, a), true);
  assert.equal(await verifyPassword(PW + '!', a), false);
  assert.equal(await verifyPassword(PW, undefined), false, 'no password set: never signs in');
  assert.equal(await verifyPassword(PW, 'scrypt$3$8$1$xx$yy'), false, 'a damaged hash never signs in');
  assert.match(passwordProblem('short')!, /at least 10/);
  assert.match(passwordProblem('pat@example.com', 'pat@example.com')!, /email/);
  assert.equal(passwordProblem(PW, 'pat@example.com'), undefined);
  assert.equal(safeNext('/app/approvals'), '/app/approvals');
  for (const bad of ['//evil.example', 'https://evil.example', '/\\evil', '/login', undefined]) assert.equal(safeNext(bad), '/app', String(bad));
});

/* ---------------- after checkout ---------------- */

test('checkout → one-time setup link → password → session → /api/me (with the Calendly link)', async () => {
  const t = boot();
  const restoreEnv = env({ STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_test', CALENDLY_URL: 'https://calendly.com/keyhelm/onboarding' });
  let stripeSays = { status: 'open', payment_status: 'unpaid' };
  const restoreFetch = mockFetch((u, init) => {
    if (u.includes('/prices')) return Response.json({ data: [{ id: 'price_x', unit_amount: 1500 }] });
    if (u.includes('/coupons')) return Response.json({ id: 'coupon_1' });
    if (init?.method === 'POST' && u.endsWith('/checkout/sessions')) return Response.json({ id: 'cs_test_pat_1', url: 'https://checkout.stripe.com/c/cs_test_pat_1' });
    if (u.includes('/checkout/sessions/cs_test_pat_1')) return Response.json({ id: 'cs_test_pat_1', mode: 'subscription', ...stripeSays, client_reference_id: 'someone-else' });
    return Response.json({ error: { message: 'unexpected' } }, { status: 404 });
  });
  try {
    const signup = await fetch(`${t.base}/api/public/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Pat Lee', email: 'pat@example.com', phone: '720-555-0142', doors: 2, plan: 'autopilot', term: 'monthly', agree: true, smsConsent: true }) });
    assert.equal(signup.status, 200);
    const pat = t.store.find('owners', (o) => o.email === 'pat@example.com')!;

    // The browser can arrive before Stripe's webhook: wait (the page refreshes itself), never hand out a link.
    const early = await fetch(`${t.base}/billing/done?session=cs_test_pat_1`, { redirect: 'manual' });
    assert.equal(early.status, 200);
    const earlyHtml = await early.text();
    assert.match(earlyHtml, /Finishing up your payment/);
    assert.match(earlyHtml, /http-equiv="refresh" content="3;url=\/billing\/done\?session=cs_test_pat_1&amp;n=1"/);
    assert.equal(t.store.kvList('loginLinks').length, 0);
    stripeSays = { status: 'complete', payment_status: 'paid' };
    assert.equal((await fetch(`${t.base}/billing/done?session=cs_test_pat_1`, { redirect: 'manual' })).status, 200, "Stripe's answer must be for this owner");

    // Stripe's signed webhook marks the subscription paid and starts onboarding (six setup to-dos).
    const body = JSON.stringify({ type: 'checkout.session.completed', data: { object: { mode: 'subscription', client_reference_id: pat.id, customer: 'cus_pat', subscription: 'sub_pat', payment_status: 'paid' } } });
    const ts = Math.floor(Date.now() / 1000);
    const sig = createHmac('sha256', 'whsec_test').update(`${ts}.${body}`).digest('hex');
    assert.equal((await fetch(`${t.base}/webhooks/stripe`, { method: 'POST', headers: { 'stripe-signature': `t=${ts},v1=${sig}`, 'content-type': 'application/json' }, body })).status, 200);
    assert.equal(t.store.get('owners', pat.id)!.billing!.status, 'active');
    assert.equal(t.store.list('tasks', (x) => x.ownerId === pat.id && x.detail === 'Setup step').length, 6);

    const done = await fetch(`${t.base}/billing/done?session=cs_test_pat_1`, { redirect: 'manual' });
    assert.equal(done.status, 303);
    const linkPath = done.headers.get('location')!;
    assert.match(linkPath, /^\/login\/link\/[\w-]{40,}$/);
    assert.ok(!JSON.stringify(t.store.kvList('loginLinks')).includes(linkPath.split('/').pop()!), 'only a hash of the link is stored');

    const page = await fetch(t.base + linkPath);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
    const pageHtml = await page.text();
    assert.match(pageHtml, /Create your password/);
    assert.match(pageHtml, /pat@example\.com/);
    assert.doesNotMatch(pageHtml, /—|<script/, 'no em dashes, no scripts');

    assert.equal((await t.form(linkPath, { password: 'short', confirm: 'short' })).status, 400);
    const mismatch = await t.form(linkPath, { password: PW, confirm: PW + 'x' });
    assert.equal(mismatch.status, 400);
    assert.match(await mismatch.text(), /don&#39;t match/);
    const set = await t.form(linkPath, { password: PW, confirm: PW });
    assert.equal(set.status, 303);
    assert.equal(set.headers.get('location'), '/app');
    assert.match(rawCookie(set), /^kh_session=[\w-]{40,}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000$/);
    const cookie = cookieOf(set)!;
    assert.equal((await fetch(t.base + linkPath)).status, 410, 'the link works once');

    const me = await t.call(cookie, 'GET', '/api/me', undefined, {});
    assert.equal(me.status, 200);
    const meText = await me.text();
    assert.doesNotMatch(meText, /passwordHash|scrypt\$/, 'no password hash ever leaves the server');
    const m = JSON.parse(meText);
    assert.equal(m.owner.email, 'pat@example.com');
    assert.equal(m.owner.hasPassword, true);
    assert.deepEqual(m.plan, { id: 'autopilot', name: 'Autopilot' });
    assert.equal(m.billing.status, 'active');
    assert.equal(m.signedInWith, 'session');
    const cal = new URL(m.onboarding.calendlyUrl);
    assert.equal(cal.origin + cal.pathname, 'https://calendly.com/keyhelm/onboarding');
    assert.equal(cal.searchParams.get('email'), 'pat@example.com');
    assert.equal(cal.searchParams.get('utm_content'), pat.id);
    assert.equal(m.onboarding.total, 6);
    assert.equal(m.onboarding.done, 0, 'nothing set up yet (default rules are not "saved rules")');

    // The app: signed in → served; signed out → sign in first. Dashboard never shows the hash either.
    const app = await t.call(cookie, 'GET', '/app', undefined, {});
    assert.equal(app.status, 200);
    assert.match(await app.text(), /href="https:\/\/calendly\.com\/keyhelm\/onboarding\?[^"]*utm_content=[^"]*">Book your onboarding call</);
    assert.match((await fetch(t.base + '/login')).headers.get('content-security-policy') ?? '', /script-src 'none'/);
    const out = await fetch(t.base + '/app', { redirect: 'manual' });
    assert.equal(out.status, 302);
    assert.equal(out.headers.get('location'), '/login?next=%2Fapp');
    assert.doesNotMatch(await (await t.call(cookie, 'GET', '/api/dashboard', undefined, {})).text(), /passwordHash/);
    // Coming back to the checkout page later goes to the app, not a new link.
    assert.equal((await fetch(`${t.base}/billing/done?session=cs_test_pat_1`, { redirect: 'manual' })).headers.get('location'), '/app');
  } finally {
    restoreFetch(); restoreEnv(); t.close();
  }
});

test('after checkout: Stripe confirms when the webhook is late; accounts with data get the link by email only', async () => {
  const t = boot();
  const restoreEnv = env({ STRIPE_SECRET_KEY: 'sk_test_x', POSTMARK_TOKEN: undefined, EMAIL_FROM: undefined });
  const fresh = t.store.insert('owners', { name: 'Robin Diaz', email: 'robin@example.com', phone: '+17205550170', plan: 'essentials', timezone: 'America/Denver', createdAt: '2026-10-12T15:00:00Z', billing: { status: 'checkout_started', checkoutSessionId: 'cs_test_robin_1', updatedAt: '2026-10-12T15:00:00Z' } });
  t.store.update('owners', t.s.owner.id, { billing: { status: 'checkout_started', checkoutSessionId: 'cs_test_nate_1', updatedAt: '2026-10-12T15:00:00Z' } });
  const restoreFetch = mockFetch((u) => {
    const id = u.split('/').pop()!;
    const owner = id === 'cs_test_robin_1' ? fresh.id : t.s.owner.id;
    return Response.json({ id, mode: 'subscription', status: 'complete', payment_status: 'paid', client_reference_id: owner });
  });
  try {
    const r = await fetch(`${t.base}/billing/done?session=cs_test_robin_1`, { redirect: 'manual' });
    assert.equal(r.status, 303, 'paid per Stripe: setup link right away');
    assert.match(r.headers.get('location')!, /^\/login\/link\//);

    // Nate's account already has homes and tenants: a checkout URL alone must never open it.
    const n = await fetch(`${t.base}/billing/done?session=cs_test_nate_1`, { redirect: 'manual' });
    assert.equal(n.status, 200);
    assert.match(await n.text(), /email/i);
    assert.equal(t.store.kvList<{ ownerId: string }>('loginLinks').filter((l) => l.ownerId === t.s.owner.id).length, 0, 'no email set up: no link made');
    const restoreMail = env({ POSTMARK_TOKEN: 'pm_test', EMAIL_FROM: 'help@keyhelm.test' });
    try {
      const before = t.outbox.sent.length;
      assert.equal((await fetch(`${t.base}/billing/done?session=cs_test_nate_1`, { redirect: 'manual' })).status, 200);
      await new Promise((ok) => setTimeout(ok, 20));
      const mail = t.outbox.sent.slice(before);
      assert.equal(mail.length, 1);
      assert.equal(mail[0].channel, 'email');
      assert.equal(mail[0].to, 'nate@example.com');
      assert.match(mail[0].body, /\/login\/link\/[\w-]{40,}/);
      assert.ok(!t.store.list('messages').some((m) => m.body.includes('/login/link/')), 'sign-in links are not kept in the message history');
    } finally { restoreMail(); }
  } finally {
    restoreFetch(); restoreEnv(); t.close();
  }
});

/* ---------------- sign in, out, limits ---------------- */

test('sign in: success, the same answer for a wrong password or unknown email, rate limits', async () => {
  const t = boot();
  const restoreEnv = env({ RL_LOGIN_EMAIL_PER_HOUR: '3', RL_LOGIN_IP_PER_HOUR: '8' });
  resetLoginLimits();
  try {
    t.store.update('owners', t.s.owner.id, { passwordHash: await hashPassword(PW) });
    assert.match(await (await fetch(t.base + '/login')).text(), /Welcome back/);
    const wrong = await t.form('/login', { email: 'nate@example.com', password: 'not the password' });
    const nobody = await t.form('/login', { email: 'nobody@example.com', password: 'not the password' });
    assert.equal(wrong.status, 401);
    assert.equal(nobody.status, 401);
    const msg = (h: string) => h.match(/class="msg error"[^>]*>([^<]+)</)![1];
    assert.equal(msg(await wrong.text()), msg(await nobody.text()), "no hint about which emails have accounts");
    const json = await fetch(t.base + '/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'nobody@example.com', password: 'x' }) });
    assert.equal(json.status, 401);
    assert.match((await json.json()).error, /don't match/);

    const ok = await t.form('/login', { email: ' Nate@Example.com ', password: PW, next: '//evil.example/x' });
    assert.equal(ok.status, 303);
    assert.equal(ok.headers.get('location'), '/app', 'never redirects off this site');
    const cookie = cookieOf(ok)!;
    assert.equal((await t.call(cookie, 'GET', '/api/me', undefined, {})).status, 200);
    assert.ok(t.store.get('owners', t.s.owner.id)!.lastLoginAt);
    assert.equal((await fetch(t.base + '/login', { redirect: 'manual', headers: { cookie } })).status, 303, 'already signed in → the app');

    // Per email: 3 tries an hour (the right password doesn't get through once the limit is hit).
    await t.form('/login', { email: 'nate@example.com', password: 'nope nope nope' });
    const limited = await t.form('/login', { email: 'nate@example.com', password: PW });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    // Per IP: 8 tries an hour across any emails.
    for (let i = 0; i < 2; i++) assert.equal((await t.form('/login', { email: `x${i}@example.com`, password: 'x' })).status, 401);
    assert.equal((await t.form('/login', { email: 'x9@example.com', password: 'x' })).status, 429);
    // Sign-ins from another website are refused.
    resetLoginLimits();
    assert.equal((await t.form('/login', { email: 'nate@example.com', password: PW }, { origin: 'https://evil.example' })).status, 403);
  } finally {
    restoreEnv(); resetLoginLimits(); t.close();
  }
});

test('sign out: this device, or every device', async () => {
  const t = boot();
  try {
    const c1 = await t.signInAs(t.s.owner.id);
    const c2 = await t.login('nate@example.com');
    assert.equal((await t.form('/logout', {}, { cookie: c1, origin: 'https://evil.example' })).status, 403);
    const out = await t.form('/logout', {}, { cookie: c1 });
    assert.equal(out.status, 303);
    assert.equal(out.headers.get('location'), '/login?signed_out=1');
    assert.match(rawCookie(out), /Max-Age=0/);
    const dead = await t.call(c1, 'GET', '/api/me', undefined, {});
    assert.equal(dead.status, 401);
    assert.match(rawCookie(dead), /Max-Age=0/, 'a dead cookie is cleared');
    assert.equal((await t.call(c2, 'GET', '/api/me', undefined, {})).status, 200, 'other devices stay signed in');
    const c3 = await t.login('nate@example.com');
    const all = await t.call(c3, 'POST', '/logout', { all: true });
    assert.equal(all.status, 200);
    assert.equal((await t.call(c2, 'GET', '/api/me', undefined, {})).status, 401);
    assert.equal((await t.call(c3, 'GET', '/api/me', undefined, {})).status, 401);
  } finally { t.close(); }
});

test('sessions last 30 days and slide with use; CSRF header on cookie changes; bearer tokens work as before', async () => {
  const t = boot();
  try {
    const cookie = await t.signInAs(t.s.owner.id);
    const vendor = { name: 'Peak Electric', trades: ['electrical'], phone: '303-555-0188' };
    const noHeader = await t.call(cookie, 'POST', '/api/vendors', vendor, {});
    assert.equal(noHeader.status, 403);
    assert.match((await noHeader.json()).error, /X-KeyHelm/);
    assert.equal((await t.call(cookie, 'POST', '/api/vendors', vendor, { 'x-keyhelm': '1', origin: 'https://evil.example' })).status, 403);
    assert.equal((await t.call(cookie, 'POST', '/api/vendors', vendor, { 'x-keyhelm': '1', referer: 'https://evil.example/page' })).status, 403);
    assert.equal((await t.call(cookie, 'POST', '/api/vendors', vendor, { 'x-keyhelm': '1', origin: t.base })).status, 201);
    assert.equal((await t.call(cookie, 'PATCH', '/api/vendors/' + t.s.plumber.id, { emergency: false })).status, 200, 'header, no Origin: fine');
    assert.equal((await t.call(cookie, 'GET', '/api/vendors', undefined, {})).status, 200, 'reading needs no header');
    assert.equal(t.store.list('vendors', (v) => v.name === 'Peak Electric').length, 1, 'refused requests changed nothing');

    // Bearer tokens (the /play console, scripts) don't need the header.
    assert.equal((await t.bearer('POST', '/api/vendors', { name: 'Front Range Roofing', trades: ['roofing'], phone: '303-555-0177' })).status, 201);
    assert.equal((await fetch(t.base + '/api/me', { headers: { authorization: 'Bearer nope' } })).status, 401);
    assert.equal((await fetch(t.base + '/api/me')).status, 401);

    // Sliding 30 days: used on day 20 → good until day 50.
    t.clock.advance(20 * DAY);
    const used = await t.call(cookie, 'GET', '/api/me', undefined, {});
    assert.equal(used.status, 200);
    assert.match(rawCookie(used), /Max-Age=2592000/, 'cookie re-sent with a fresh 30 days');
    t.clock.advance(20 * DAY);
    assert.equal((await t.call(cookie, 'GET', '/api/me', undefined, {})).status, 200);
    t.clock.advance(31 * DAY);
    assert.equal((await t.call(cookie, 'GET', '/api/me', undefined, {})).status, 401, 'unused for 30+ days: signed out');
  } finally { t.close(); }
});

/* ---------------- scoping ---------------- */

test("another owner's records are a 404, everywhere", async () => {
  const t = boot();
  try {
    const nate = t.s;
    const c = t.store.insert('charges', { ownerId: nate.owner.id, leaseId: nate.lease.id, kind: 'rent', amount: 275_000, dueDate: '2026-11-01', paid: 0, status: 'open', period: '2026-11', notices: [] });
    const task = t.store.insert('tasks', { ownerId: nate.owner.id, title: 'Change furnace filter', detail: '', status: 'open' });
    const ap = t.store.insert('approvals', { ownerId: nate.owner.id, runId: 'run_x', kind: 'repair_over_limit', title: 'Repair $400', body: '', options: ['approve', 'decline'], data: {}, status: 'pending', createdAt: '2026-10-12T15:00:00Z' });
    await t.text(nate.tenant.phone!, 'Is trash day Tuesday?');
    const other = t.store.insert('owners', { name: 'Sam Ortiz', email: 'sam@example.com', phone: '+17205550160', plan: 'essentials', timezone: 'America/Denver', createdAt: '2026-10-12T15:00:00Z' });
    const sam = await t.signInAs(other.id);
    const no = async (method: string, path: string, body?: unknown) => assert.equal((await t.call(sam, method, path, body)).status, 404, `${method} ${path}`);
    await no('PATCH', `/api/properties/${nate.home.id}`, { rent: 1 });
    await no('DELETE', `/api/properties/${nate.vacant.id}`);
    await no('PATCH', `/api/tenants/${nate.tenant.id}`, { name: 'X' });
    await no('POST', `/api/tenants/${nate.tenant.id}/former`, {});
    await no('PATCH', `/api/vendors/${nate.plumber.id}`, { name: 'X' });
    await no('DELETE', `/api/vendors/${nate.plumber.id}`);
    await no('POST', `/api/approvals/${ap.id}`, { decision: 'approve' });
    await no('POST', `/api/charges/${c.id}/received`, {});
    await no('POST', `/api/tasks/${task.id}/done`, {});
    await no('GET', `/api/messages/threads/${encodeURIComponent(nate.tenant.phone!)}`);
    await no('POST', '/api/messages/send', { to: nate.tenant.phone, body: 'hi' });
    await no('POST', '/api/tenants', { propertyId: nate.home.id, name: 'X', phone: '303-555-0101' });
    await no('POST', '/api/work-orders', { propertyId: nate.home.id, summary: 'Leaky faucet' });
    for (const path of ['/api/properties', '/api/tenants', '/api/vendors', '/api/approvals', '/api/charges', '/api/tasks', '/api/work-orders', '/api/messages/threads', '/api/lease-templates', '/api/activity']) {
      assert.deepEqual(await (await t.call(sam, 'GET', path, undefined, {})).json(), [], path);
    }
    assert.equal(t.store.get('approvals', ap.id)!.status, 'pending');
    assert.equal(t.store.get('tasks', task.id)!.status, 'open');
  } finally { t.close(); }
});

/* ---------------- decisions ---------------- */

test('decisions from the app: renewal rent in dollars becomes cents; deposit deductions; bad data is a plain 400', async () => {
  const t = boot();
  try {
    const cookie = await t.signInAs(t.s.owner.id);
    t.svc.engine.emit('renewal.due', { leaseId: t.s.lease.id, ownerId: t.s.owner.id });
    await t.svc.engine.drain();
    const list = await (await t.call(cookie, 'GET', '/api/approvals?status=pending', undefined, {})).json();
    const renewal = list.find((a: any) => a.kind === 'renewal_terms');
    assert.deepEqual(renewal.choices, [{ value: 'offer_renewal', label: 'Offer the renewal' }, { value: 'do_not_renew', label: "Don't renew" }]);
    assert.deepEqual(renewal.fields.map((f: any) => [f.name, f.type, f.value]), [['rent', 'dollars', 2750], ['months', 'months', 12]]);
    const bad = await t.call(cookie, 'POST', `/api/approvals/${renewal.id}`, { decision: 'offer_renewal', data: { rent: 'lots' } });
    assert.equal(bad.status, 400);
    assert.deepEqual(await bad.json(), { error: 'The renewal rent should be a dollar amount, like 2750 or 2,750.50.', field: 'rent' });
    assert.equal((await t.call(cookie, 'POST', `/api/approvals/${renewal.id}`, { decision: 'maybe' })).status, 400);
    const ok = await t.call(cookie, 'POST', `/api/approvals/${renewal.id}`, { decision: 'offer_renewal', data: { rent: '2,850', months: 12, sneaky: 'ignored' } });
    assert.equal(ok.status, 200);
    const decided = await ok.json();
    assert.equal(decided.data.rent, 285_000);
    assert.equal(decided.data.months, 12);
    assert.equal(decided.data.sneaky, undefined, 'only checked fields reach the workflow');
    assert.equal(decided.decisionLabel, 'Offer the renewal');
    assert.match(t.outbox.sent.filter((m) => m.to === t.s.tenant.phone).pop()!.body, /rent \$2,850\/month/);
    assert.equal((await t.call(cookie, 'POST', `/api/approvals/${renewal.id}`, { decision: 'offer_renewal' })).status, 409, 'already decided');

    // Move-out: after the move-out day, the owner itemizes the deposit.
    t.svc.engine.emit('moveout.notice', { ownerId: t.s.owner.id, tenantId: t.s.tenant.id, leaseId: t.s.lease.id, date: '2026-10-14', fromOwner: true });
    await t.svc.engine.drain();
    t.clock.set('2026-10-15T16:00:00Z');
    t.svc.engine.tick();
    await t.svc.engine.drain();
    const dep = (await (await t.call(cookie, 'GET', '/api/approvals?status=pending', undefined, {})).json()).find((a: any) => a.kind === 'deposit');
    assert.ok(dep, 'deposit decision is waiting');
    assert.deepEqual(dep.fields.map((f: any) => [f.name, f.type, f.forOption]), [['deductions', 'deductions', 'deductions_entered']]);
    assert.equal((await t.call(cookie, 'POST', `/api/approvals/${dep.id}`, { decision: 'deductions_entered', data: { deductions: [] } })).status, 400);
    assert.equal((await t.call(cookie, 'POST', `/api/approvals/${dep.id}`, { decision: 'deductions_entered', data: { deductions: [{ reason: 'Carpet cleaning', amount: -5 }] } })).status, 400);
    const r = await t.call(cookie, 'POST', `/api/approvals/${dep.id}`, { decision: 'deductions_entered', data: { deductions: [{ reason: 'Carpet cleaning', amount: '150' }, { reason: 'Broken blinds', amount: 40.5 }] } });
    assert.equal(r.status, 200);
    assert.deepEqual((await r.json()).data.deductions, [{ reason: 'Carpet cleaning', amount: 15_000 }, { reason: 'Broken blinds', amount: 4_050 }]);
    assert.ok(t.store.find('tasks', (x) => x.title.startsWith('Send deposit refund of $2,559.50')), 'refund to-do for the right amount');
  } finally { t.close(); }
});

/* ---------------- setup checklist ---------------- */

test('setup checklist closes itself as homes, lease, tenants, vendors and rules are added', async () => {
  const t = boot();
  try {
    const pat = t.store.insert('owners', { name: 'Pat Lee', email: 'pat@example.com', phone: '+17205550142', plan: 'autopilot', timezone: 'America/Denver', createdAt: '2026-10-12T15:00:00Z', billing: { status: 'active', updatedAt: '2026-10-12T15:00:00Z' } });
    t.svc.engine.emit('owner.signed_up', { ownerId: pat.id });
    await t.svc.engine.drain();
    const cookie = await t.signInAs(pat.id);
    const post = async (path: string, body: unknown, want = 201) => { const r = await t.call(cookie, 'POST', path, body); const j = await r.json(); assert.equal(r.status, want, `${path}: ${JSON.stringify(j)}`); return j; };
    const openSteps = async () => (await (await t.call(cookie, 'GET', '/api/tasks?status=open', undefined, {})).json()).filter((x: any) => x.setupStep).map((x: any) => x.setupStep).sort();
    assert.deepEqual(await openSteps(), ['homes', 'howToPay', 'lease', 'rules', 'tenants', 'vendors']);

    assert.equal((await post('/api/properties', { address: '12 Elm St', beds: 2, baths: 1, rent: 2100 }, 400)).field, 'city');
    assert.match((await post('/api/properties', { address: '12 Elm St', city: 'Denver', zip: '90210', beds: 2, baths: 1, rent: 2100 }, 400)).error, /Colorado ZIP/);
    const home = await post('/api/properties', { address: '12 Elm St', city: 'Denver', zip: '80203', beds: 2, baths: 1.5, rent: '2,100', facts: { Parking: 'Driveway' } });
    assert.equal(home.rent, 210_000);
    assert.equal(home.deposit, 210_000);
    assert.equal(home.canDelete, true);
    assert.equal((await post('/api/properties', { address: '12  elm st', city: 'Denver', zip: '80203', beds: 2, baths: 1, rent: 2100 }, 409)).field, 'address');
    assert.match((await post('/api/properties', { address: '9 Oak St', city: 'Denver', zip: '80203', beds: 2, baths: 1, rent: 2100, facts: { Note: 'Perfect for singles' } }, 400)).error, /fair housing/);

    await post('/api/lease-templates', { name: 'My Colorado lease', text: SAMPLE_LEASE });
    const tenant = await post('/api/tenants', { propertyId: home.id, name: 'Jordan Park', phone: '(303) 555-0123', email: 'jordan@example.com', lease: { startDate: '2026-06-01', endDate: '2027-05-31', rent: 2100, deposit: 2100 } });
    assert.equal(tenant.phone, '+13035550123');
    assert.equal(tenant.lease.rent, 210_000);
    assert.equal(tenant.propertyAddress, '12 Elm St');
    assert.match(t.outbox.sent.filter((m) => m.to === '+13035550123').pop()!.body, /Hi Jordan! Your landlord now uses KeyHelm/, 'welcome text');
    assert.equal((await post('/api/tenants', { propertyId: home.id, name: 'Dup', phone: '303-555-0123' }, 409)).field, 'phone');
    assert.equal((await post('/api/tenants', { propertyId: home.id, name: 'Me', phone: '720-555-0142' }, 400)).field, 'phone', "the owner's own number");
    await post('/api/vendors', { name: 'Denver Plumbing Co', trades: ['Plumbing'], phone: '303-555-0199', emergency: true });
    assert.deepEqual(await openSteps(), ['howToPay', 'rules']);

    const rulesBefore = await (await t.call(cookie, 'GET', '/api/rules', undefined, {})).json();
    assert.equal(rulesBefore.saved, false);
    assert.equal(rulesBefore.lateFee, 0, 'safe defaults until the owner chooses');
    const badRule = await t.call(cookie, 'PUT', '/api/rules', { petPolicy: 'Adults only, no kids' });
    assert.equal(badRule.status, 400);
    assert.match((await badRule.json()).error, /fair housing/);
    assert.equal((await t.call(cookie, 'PUT', '/api/rules', { rentDueDay: 31 })).status, 400);
    const saved = await t.call(cookie, 'PUT', '/api/rules', { repairSpendLimit: 250, lateFee: '50', petPolicy: 'Cats welcome', howToPay: 'Zelle to pat@example.com', quietHours: { start: '21:00', end: '07:30' }, screeningCriteria: [{ key: 'income_multiple', label: 'Monthly income at least 3x rent', value: 3 }] });
    assert.equal(saved.status, 200);
    const r = await saved.json();
    assert.equal(r.repairSpendLimit, 25_000);
    assert.equal(r.lateFee, 5_000);
    assert.equal(r.saved, true);
    assert.deepEqual(await openSteps(), []);
    const me = await (await t.call(cookie, 'GET', '/api/me', undefined, {})).json();
    assert.equal(me.onboarding.complete, true);
    assert.equal(me.counts.homes, 1);
    assert.ok((await (await t.call(cookie, 'GET', '/api/activity', undefined, {})).json()).some((a: any) => a.action === 'onboarding.step_done'));
  } finally { t.close(); }
});

/* ---------------- everyday owner API ---------------- */

test('rent received in dollars, repairs with vendor names, to-dos, homes and former tenants', async () => {
  const t = boot();
  try {
    const cookie = await t.signInAs(t.s.owner.id);
    const c = t.store.insert('charges', { ownerId: t.s.owner.id, leaseId: t.s.lease.id, kind: 'rent', amount: 275_000, dueDate: '2026-11-01', paid: 0, status: 'open', period: '2026-11', notices: [] });
    const open = await (await t.call(cookie, 'GET', '/api/charges?status=open', undefined, {})).json();
    assert.equal(open[0].label, 'Rent for November 2026');
    assert.equal(open[0].propertyAddress, t.s.home.address);
    assert.deepEqual(open[0].tenantNames, ['Lisa Chen']);
    assert.equal((await t.call(cookie, 'POST', `/api/charges/${c.id}/received`, { amount: 5000 })).status, 400, 'more than is owed');
    const part = await (await t.call(cookie, 'POST', `/api/charges/${c.id}/received`, { amount: '1,000' })).json();
    assert.equal(part.paid, 100_000);
    assert.equal(part.balance, 175_000);
    const rest = await (await t.call(cookie, 'POST', `/api/charges/${c.id}/received`, {})).json();
    assert.equal(rest.status, 'paid');
    assert.equal((await t.call(cookie, 'POST', `/api/charges/${c.id}/received`, {})).status, 409);
    assert.ok(t.store.list('payments').every((p) => p.method === 'owner_recorded'), 'KeyHelm only records what the owner says arrived');
    assert.equal((await t.call(cookie, 'GET', '/api/charges?status=nope', undefined, {})).status, 400);

    const made = await t.call(cookie, 'POST', '/api/work-orders', { propertyId: t.s.home.id, tenantId: t.s.tenant.id, summary: 'Kitchen faucet drips', trade: 'plumbing' });
    assert.equal(made.status, 202);
    assert.equal((await made.json()).workOrder.propertyAddress, t.s.home.address);
    assert.equal((await t.call(cookie, 'POST', '/api/work-orders', { propertyId: t.s.home.id, summary: 'x', urgency: 'whenever' })).status, 400);
    t.store.insert('workOrders', { ownerId: t.s.owner.id, propertyId: t.s.home.id, summary: 'Torn screen', trade: 'windows', urgency: 'routine', photos: [], vendorId: t.s.windowCo.id, respondBy: '2026-10-15T16:00:00Z', status: 'scheduled', createdAt: '2026-10-12T17:00:00Z' });
    const wos = await (await t.call(cookie, 'GET', '/api/work-orders?status=open', undefined, {})).json();
    assert.equal(wos.find((w: any) => w.summary === 'Torn screen').vendorName, 'GlassHouse Exteriors');
    assert.equal((await t.call(cookie, 'DELETE', `/api/vendors/${t.s.windowCo.id}`)).status, 409, 'vendor with an open job stays');

    const task = t.store.insert('tasks', { ownerId: t.s.owner.id, title: 'Change furnace filter', detail: '', status: 'open' });
    assert.equal((await (await t.call(cookie, 'POST', `/api/tasks/${task.id}/done`, {})).json()).status, 'done');

    assert.equal((await t.call(cookie, 'DELETE', `/api/properties/${t.s.home.id}`)).status, 409, 'home with an active lease stays');
    assert.equal((await t.call(cookie, 'PATCH', `/api/properties/${t.s.vacant.id}`, { status: 'listed' })).status, 400);
    assert.equal((await (await t.call(cookie, 'PATCH', `/api/properties/${t.s.vacant.id}`, { rent: 1900 })).json()).rent, 190_000);
    assert.equal((await t.call(cookie, 'DELETE', `/api/properties/${t.s.vacant.id}`)).status, 200);

    const former = await (await t.call(cookie, 'POST', `/api/tenants/${t.s.tenant.id}/former`, { forwardingAddress: '1420 Elm St, Denver CO 80203' })).json();
    assert.equal(former.status, 'former');
    assert.equal(t.store.get('leases', t.s.lease.id)!.status, 'ended', 'everyone moved out: lease over, rent reminders stop');
    assert.equal(t.store.get('properties', t.s.home.id)!.status, 'turnover');
    assert.equal((await t.call(cookie, 'PATCH', `/api/tenants/${t.s.tenant.id}`, { status: 'active' })).status, 400);

    const me = await t.call(cookie, 'PATCH', '/api/me', { name: 'Nate N.', phone: '720 555 0100', smsConsent: false });
    assert.equal(me.status, 200);
    const mj = await me.json();
    assert.equal(mj.owner.name, 'Nate N.');
    assert.equal(mj.owner.smsConsent, false);
    assert.equal((await t.call(cookie, 'PATCH', '/api/me', { email: 'new@example.com' })).status, 400, 'changing email needs the current password');
    assert.equal((await (await t.call(cookie, 'PATCH', '/api/me', { email: 'new@example.com', password: PW })).json()).owner.email, 'new@example.com');
    const activity = await (await t.call(cookie, 'GET', '/api/activity?limit=3', undefined, {})).json();
    assert.equal(activity.length, 3);
    assert.ok(activity[0].at >= activity[1].at && activity[1].at >= activity[2].at, 'newest first');
  } finally { t.close(); }
});

/* ---------------- messages ---------------- */

test('messages: threads by contact, owner replies, STOP is respected', async () => {
  const t = boot();
  try {
    const cookie = await t.signInAs(t.s.owner.id);
    await t.text(t.s.tenant.phone!, 'Hi! Is trash day still Tuesday?');
    const list = await (await t.call(cookie, 'GET', '/api/messages/threads', undefined, {})).json();
    const lisa = list.find((x: any) => x.key === t.s.tenant.phone);
    assert.equal(lisa.contact.role, 'tenant');
    assert.equal(lisa.contact.name, 'Lisa Chen');
    assert.equal(lisa.contact.propertyAddress, t.s.home.address);
    assert.ok(!list.some((x: any) => x.contact.role === 'owner'), "KeyHelm's own texts to the owner aren't a conversation");

    const sent = await t.call(cookie, 'POST', '/api/messages/send', { to: t.s.tenant.phone, body: 'Yes, bins out Monday night.' });
    assert.equal(sent.status, 201);
    const last = t.outbox.sent.pop()!;
    assert.deepEqual([last.channel, last.to, last.body], ['sms', t.s.tenant.phone, 'Nate: Yes, bins out Monday night.']);
    const thread = await (await t.call(cookie, 'GET', `/api/messages/threads/${encodeURIComponent(t.s.tenant.phone!)}`, undefined, {})).json();
    assert.equal(thread.messages.at(-1).sentBy, 'owner');
    assert.equal(thread.messages[0].sentBy, 'contact');

    await t.text(t.s.tenant.phone!, 'STOP');
    const stopped = await t.call(cookie, 'POST', '/api/messages/send', { to: t.s.tenant.phone, body: 'Are you there?' });
    assert.equal(stopped.status, 409);
    assert.match((await stopped.json()).error, /replied STOP/);
    assert.ok(!t.outbox.sent.some((m) => m.body.includes('Are you there?')), 'nothing texted after STOP');
    const email = await t.call(cookie, 'POST', '/api/messages/send', { to: t.s.tenant.phone, channel: 'email', body: 'Are you there?' });
    assert.equal(email.status, 201);
    assert.deepEqual([t.outbox.sent.at(-1)!.channel, t.outbox.sent.at(-1)!.to], ['email', 'lisa@example.com']);

    assert.equal((await t.call(cookie, 'POST', '/api/messages/send', { to: '+13035559999', body: 'Hello stranger' })).status, 404, 'only people on the account');
    assert.equal((await t.call(cookie, 'POST', '/api/messages/send', { to: t.s.plumber.phone, body: '   ' })).status, 400);
    assert.equal((await t.call(cookie, 'POST', '/api/messages/send', { to: t.s.plumber.phone, body: 'Can you look at a water heater Friday?' })).status, 201, 'vendors too');
  } finally { t.close(); }
});

/* ---------------- admin and forgot password ---------------- */

test('admin one-time sign-in link; forgot password emails a 1-hour link without revealing accounts', async () => {
  const t = boot();
  const restoreEnv = env({ ADMIN_API_TOKEN: 'admin-secret', POSTMARK_TOKEN: undefined, EMAIL_FROM: undefined });
  try {
    const path = `/api/admin/owners/${t.s.owner.id}/login-link`;
    assert.equal((await fetch(t.base + path, { method: 'POST' })).status, 401);
    assert.equal((await fetch(t.base + path, { method: 'POST', headers: { authorization: 'Bearer nope' } })).status, 401);
    assert.equal((await fetch(t.base + '/api/admin/owners/own_missing/login-link', { method: 'POST', headers: { authorization: 'Bearer admin-secret' } })).status, 404);
    const made = await fetch(t.base + path, { method: 'POST', headers: { authorization: 'Bearer admin-secret' } });
    assert.equal(made.status, 201);
    const link = await made.json();
    assert.equal(link.purpose, 'setup');
    const linkPath = new URL(link.url).pathname;
    assert.equal((await fetch(t.base + linkPath)).status, 200);
    const set = await t.form(linkPath, { password: PW, confirm: PW });
    assert.equal(set.status, 303);
    const first = cookieOf(set)!;
    assert.equal((await t.form(linkPath, { password: PW, confirm: PW })).status, 410, 'used up');
    assert.ok(t.store.list('audit').some((a) => a.action === 'owner.login_link'));

    // A second link for an owner with a password resets it and signs out other devices.
    const reset = await (await fetch(t.base + path, { method: 'POST', headers: { authorization: 'Bearer admin-secret' } })).json();
    assert.equal(reset.purpose, 'reset');
    assert.match(await (await fetch(t.base + new URL(reset.url).pathname)).text(), /Choose a new password/);
    assert.equal((await t.form(new URL(reset.url).pathname, { password: PW + ' two', confirm: PW + ' two' })).status, 303);
    assert.equal((await t.call(first, 'GET', '/api/me', undefined, {})).status, 401);

    // Forgot password, no email service yet: the same "contact us" answer for everyone, nothing sent.
    const before = t.outbox.sent.length;
    const noMail = await t.form('/forgot', { email: 'nate@example.com' });
    assert.equal(noMail.status, 200);
    assert.match(await noMail.text(), /Email us at/);
    // With email set up (Postmark keys present; the test's messaging is still the fake outbox).
    const restoreMail = env({ POSTMARK_TOKEN: 'pm_test', EMAIL_FROM: 'help@keyhelm.test' });
    try {
      const known = await (await t.form('/forgot', { email: 'nate@example.com' })).text();
      const unknown = await (await t.form('/forgot', { email: 'nobody@example.com' })).text();
      assert.equal(known, unknown, 'same page either way');
      await new Promise((ok) => setTimeout(ok, 20));
      const mail = t.outbox.sent.slice(before);
      assert.equal(mail.length, 1);
      assert.equal(mail[0].to, 'nate@example.com');
      const resetPath = mail[0].body.match(/\/login\/link\/[\w-]+/)![0];
      t.clock.advance(61 * MIN);
      assert.equal((await fetch(t.base + resetPath)).status, 410, 'reset links last 1 hour');
      const j = await fetch(t.base + '/forgot', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'nobody@example.com' }) });
      assert.deepEqual(await j.json(), { ok: true, emailSent: true });
    } finally { restoreMail(); }
  } finally {
    restoreEnv(); t.close();
  }
});
