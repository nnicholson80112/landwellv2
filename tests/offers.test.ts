import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { MemoryStore } from '../src/store/store.ts';
import { SystemClock } from '../src/engine/clock.ts';
import { createServices } from '../src/services.ts';
import { install } from '../src/workflows/index.ts';
import { seed } from '../src/sim/seed.ts';
import { createApp } from '../src/api/server.ts';
import { checkOfferRules, issueOffer, pickOffer, canUse, offerPrice, LIST_PRICE, BASE_PRICE, PRESETS } from '../src/billing/offers.ts';
import { applyBillingEvent } from '../src/billing/stripe.ts';

const now = new Date('2026-10-10T18:00:00Z');

test('offers: guardrails keep every discount above the price floor and inside its type limits', () => {
  for (const [k, p] of Object.entries(PRESETS)) assert.equal(checkOfferRules({ ...p, email: 'a@b.co', issuedBy: p.kind === 'web_intro' || p.kind === 'referral' ? 'system' : 'admin' }), undefined, `preset ${k} is valid`);
  assert.match(checkOfferRules({ kind: 'demo', title: 'x', percentOff: 50, months: 1, email: 'a@b.co', issuedBy: 'admin' })!, /1–25%/);
  assert.match(checkOfferRules({ kind: 'demo', mode: 'base', title: 'x', months: 6, terms: ['monthly'], email: 'a@b.co', issuedBy: 'admin' })!, /1–3 months/);
  assert.equal(checkOfferRules({ kind: 'demo', mode: 'base', title: 'x', months: 12, terms: ['contract12'], email: 'a@b.co', issuedBy: 'admin' }), undefined);
  assert.match(checkOfferRules({ kind: 'seasonal', mode: 'base', title: 'x', months: 2, terms: ['monthly'], email: 'a@b.co', issuedBy: 'admin' })!, /12-month agreement/);
  assert.match(checkOfferRules({ kind: 'winback', title: 'x', percentOff: 25, months: 1, plans: ['plus'], email: 'a@b.co', issuedBy: 'admin' }) ?? 'ok', /ok/);
  assert.match(checkOfferRules({ kind: 'web_intro', title: 'x', percentOff: 10, months: 1, email: 'a@b.co', issuedBy: 'admin' })!, /automatically/);
  assert.match(checkOfferRules({ kind: 'seasonal', title: 'x', percentOff: 15, months: 1, issuedBy: 'admin' })!, /one owner or one email/);
});

test('pricing: whole $5 prices, and original-price offers land exactly on the original', () => {
  assert.deepEqual(LIST_PRICE, { essentials: { monthly: 2000, contract12: 1500 }, autopilot: { monthly: 4500, contract12: 3500 }, plus: { monthly: 7000, contract12: 6000 } });
  for (const plan of ['essentials', 'autopilot', 'plus'] as const) for (const t of ['monthly', 'contract12'] as const) { assert.equal(LIST_PRICE[plan][t] % 500, 0); assert.equal(BASE_PRICE[plan][t] % 500, 0); assert.ok(BASE_PRICE[plan][t] < LIST_PRICE[plan][t]); }
  for (const plan of ['essentials', 'autopilot', 'plus'] as const) for (const t of ['monthly', 'contract12'] as const) assert.equal(offerPrice({ mode: 'base', percentOff: 13 }, plan, t), BASE_PRICE[plan][t]);
});

test('offers: private to one person, best one wins, never stacked, win-back only for former customers', () => {
  const store = new MemoryStore();
  const s = seed(store, {});
  const small = issueOffer(store, { ...PRESETS['web-intro'], ownerId: s.owner.id, issuedBy: 'system' }, now);
  const big = issueOffer(store, { ...PRESETS['demo-day'], ownerId: s.owner.id, issuedBy: 'admin' }, now);
  const theirs = issueOffer(store, { ...PRESETS['demo-day'], email: 'someone@else.com', issuedBy: 'admin' }, now);
  assert.equal(pickOffer(store, { owner: s.owner }, 'autopilot', 'contract12', now).offer?.id, big.id, 'best eligible offer applies');
  assert.equal(pickOffer(store, { owner: s.owner }, 'autopilot', 'monthly', now).offer?.id, small.id, 'demo offer needs the 12-month agreement');
  assert.match(pickOffer(store, { owner: s.owner }, 'autopilot', 'contract12', now, theirs.id).error!, /someone else/);
  assert.match(canUse(big, { owner: s.owner }, 'autopilot', 'contract12', new Date(now.getTime() + 4 * 86_400_000))!, /expired/);
  const wb = issueOffer(store, { ...PRESETS.winback, ownerId: s.owner.id, issuedBy: 'admin' }, now);
  assert.match(canUse(wb, { owner: s.owner }, 'autopilot', 'monthly', now)!, /former customers/);
});

test('billing: contract start, offer redeemed, referral reward once', () => {
  const store = new MemoryStore();
  const s = seed(store, {});
  const friend = store.insert('owners', { name: 'Ana Ruiz', email: 'ana@example.com', phone: '+17205550123', plan: 'autopilot', timezone: 'America/Denver', createdAt: now.toISOString() });
  const o = issueOffer(store, { ...PRESETS.referral, ownerId: friend.id, referrerOwnerId: s.owner.id, issuedBy: 'system' }, now);
  const ev = { type: 'checkout.session.completed', data: { object: { mode: 'subscription', client_reference_id: friend.id, customer: 'cus_a', subscription: 'sub_a', payment_status: 'paid', metadata: { term: 'contract12', offer_id: o.id } } } };
  const r = applyBillingEvent(store, ev, now.toISOString())!;
  assert.equal(r.started, true);
  assert.equal(r.billing.term, 'contract12');
  assert.equal(r.billing.contractEndsAt!.slice(0, 10), '2027-10-10');
  assert.equal(store.get('offers', o.id)!.status, 'redeemed');
  assert.deepEqual(r.referralReward, { referrerOwnerId: s.owner.id, offerId: o.id });
  assert.equal(applyBillingEvent(store, { type: 'invoice.paid', data: { object: { customer: 'cus_a' } } }, now.toISOString())!.referralReward, undefined, 'reward only once');
});

test('API: web signup gets a welcome offer and a discounted checkout; admin, offer page and Calendly', async () => {
  const store = new MemoryStore();
  const env = { STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY, ADMIN_API_TOKEN: process.env.ADMIN_API_TOKEN, CALENDLY_URL: process.env.CALENDLY_URL, CALENDLY_WEBHOOK_SECRET: process.env.CALENDLY_WEBHOOK_SECRET };
  Object.assign(process.env, { STRIPE_SECRET_KEY: 'sk_test_x', ADMIN_API_TOKEN: 'admin-secret', CALENDLY_URL: 'https://calendly.com/keyhelm/onboarding', CALENDLY_WEBHOOK_SECRET: 'cal_secret' });
  const svc = createServices({ store, clock: new SystemClock(), env: {} });
  install(svc);
  seed(store, {});
  const server = createApp(svc).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const realFetch = globalThis.fetch;
  const stripeCalls: string[] = [];
  globalThis.fetch = (async (url: any, init?: any) => {
    const u = String(url);
    if (!u.startsWith('https://api.stripe.com/')) return realFetch(url, init);
    stripeCalls.push(u + ' ' + decodeURIComponent(String(init?.body ?? '')));
    if (u.includes('/prices')) return new Response(JSON.stringify({ data: [{ id: 'price_x', unit_amount: 4500 }] }));
    if (u.includes('/coupons')) return new Response(JSON.stringify({ id: 'coupon_1' }));
    return new Response(JSON.stringify({ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/cs_test_1' }));
  }) as typeof fetch;
  try {
    const signup = (extra: object) => fetch(`${base}/api/public/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Pat Lee', email: 'Pat@Example.com', phone: '720-555-0142', doors: 3, plan: 'autopilot', term: 'monthly', ...extra }) });
    assert.equal((await signup({})).status, 400, 'terms must be accepted');
    const r = await signup({ agree: true, smsConsent: false });
    const out = await r.json();
    assert.equal(r.status, 200, JSON.stringify(out));
    assert.equal(out.offer.kind, 'web_intro');
    assert.equal(out.quote.firstMonthDueToday, 3 * 3500, 'first month at the original $35/door');
    assert.ok(stripeCalls.some((c) => c.includes('/coupons') && c.includes('amount_off=3000') && c.includes('max_redemptions=1')), 'single-use coupon worth exactly $10 × 3 doors');
    assert.ok(stripeCalls.some((c) => c.includes('discounts[0][coupon]=coupon_1') && !c.includes('allow_promotion_codes')), 'no public promo codes');
    const pat = store.find('owners', (o) => o.email === 'pat@example.com')!;
    assert.equal(pat.source, 'web');
    assert.ok(pat.consents?.termsAcceptedAt && pat.consents.termsVersion, 'terms acceptance recorded');
    assert.equal(pat.consents?.smsConsent, false, 'texts stay off unless they opt in');

    // After checkout: straight to Calendly with name/email filled in and the account id for matching.
    const done = await fetch(`${base}/billing/done?session=cs_test_1`, { redirect: 'manual' });
    assert.equal(done.status, 303);
    const loc = new URL(done.headers.get('location')!);
    assert.equal(loc.origin + loc.pathname, 'https://calendly.com/keyhelm/onboarding');
    assert.equal(loc.searchParams.get('email'), 'pat@example.com');
    assert.equal(loc.searchParams.get('utm_content'), pat.id);

    // Calendly webhook marks onboarding booked.
    const body = JSON.stringify({ event: 'invitee.created', payload: { email: 'pat@example.com', tracking: { utm_content: pat.id }, scheduled_event: { start_time: '2026-10-14T16:00:00Z' } } });
    const t = Math.floor(Date.now() / 1000);
    const sig = createHmac('sha256', 'cal_secret').update(`${t}.${body}`).digest('hex');
    assert.equal((await fetch(`${base}/webhooks/calendly`, { method: 'POST', headers: { 'content-type': 'application/json', 'calendly-webhook-signature': `t=${t},v1=bad` }, body })).status, 400);
    assert.equal((await fetch(`${base}/webhooks/calendly`, { method: 'POST', headers: { 'content-type': 'application/json', 'calendly-webhook-signature': `t=${t},v1=${sig}` }, body })).status, 200);
    assert.equal(store.get('owners', pat.id)!.onboarding!.status, 'booked');

    // Admin: locked without the token; issues a demo offer by email; the personal link works; revoke works.
    assert.equal((await fetch(`${base}/api/admin/overview`)).status, 401);
    const auth = { authorization: 'Bearer admin-secret', 'content-type': 'application/json' };
    const bad = await fetch(`${base}/api/admin/offers`, { method: 'POST', headers: auth, body: JSON.stringify({ preset: 'demo-day', mode: 'percent', percentOff: 60, email: 'lead@example.com' }) });
    assert.equal(bad.status, 400);
    const made = await (await fetch(`${base}/api/admin/offers`, { method: 'POST', headers: auth, body: JSON.stringify({ preset: 'demo-day', email: 'lead@example.com' }) })).json();
    assert.equal(made.length, 1);
    const pageRes = await fetch(made[0].link.replace(/^https?:\/\/[^/]+/, base));
    assert.equal(pageRes.status, 200);
    assert.match(await pageRes.text(), /Demo-day price/);
    assert.equal((await fetch(`${base}/api/admin/offers/${made[0].id}/revoke`, { method: 'POST', headers: auth, body: '{}' })).status, 200);
    assert.equal((await fetch(made[0].link.replace(/^https?:\/\/[^/]+/, base))).status, 404);
  } finally {
    globalThis.fetch = realFetch;
    server.close();
    for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});
