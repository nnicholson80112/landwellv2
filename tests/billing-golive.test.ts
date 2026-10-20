// Billing that matches Nate's KeyHelm Stripe catalog, and sets the catalog up by itself when a
// new Stripe key is set. Every Stripe call here goes to an in-memory fake (global fetch is
// replaced); nothing reaches Stripe and nobody is charged.

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
import type { Owner } from '../src/domain/types.ts';
import { BASE_PRICE, LIST_PRICE, PRESETS, PRICE_FLOOR, canUse, checkOfferRules, dealText, issueOffer, offerPrice, quote } from '../src/billing/offers.ts';
import { BILLING_EVENTS, PLANS, PLAN_NAMES, StripeBilling, applyBillingEvent, asPlanId, asTermId, checkoutTerms, lookupKey, lookupKeyCandidates, planTermFromLookupKey } from '../src/billing/stripe.ts';
import { PLAN_CONTENTS } from '../src/billing/plans.ts';
import { PRODUCT_NAMES, STRIPE_KV, ensureCatalog, ensurePortal, ensureWebhook, portalConfiguration, startStripeSetup, webhookSecrets } from '../src/billing/catalog.ts';

const KEY = 'sk_test_fake_never_real';
const PUBLIC = 'https://app.keyhelm.test';
const now = new Date('2026-10-20T16:00:00Z');

/* ---------------- A fake Stripe (in memory) ---------------- */

type Call = { method: string; path: string; params: URLSearchParams };
type Obj = Record<string, any>;

function fakeStripe(init: { prices?: Obj[]; products?: Obj[]; endpoints?: Obj[]; portal?: Obj[]; pageSize?: number; down?: boolean } = {}) {
  const st = {
    prices: [...(init.prices ?? [])], products: [...(init.products ?? [])], endpoints: [...(init.endpoints ?? [])], portal: [...(init.portal ?? [])],
    calls: [] as Call[], secrets: {} as Record<string, string>, seq: 0,
  };
  const realFetch = globalThis.fetch;
  const nextId = (p: string) => `${p}_fake${++st.seq}`;
  const meta = (p: URLSearchParams) => Object.fromEntries([...p.entries()].filter(([k]) => k.startsWith('metadata[')).map(([k, v]) => [k.slice(9, -1), v]));
  const page = (items: Obj[], q: URLSearchParams) => {
    const limit = Math.min(Number(q.get('limit') ?? 10), init.pageSize ?? 100);
    const after = q.get('starting_after');
    const start = after ? items.findIndex((x) => x.id === after) + 1 : 0;
    return { object: 'list', data: items.slice(start, start + limit), has_more: start + limit < items.length };
  };
  const activeOnly = (items: Obj[], q: URLSearchParams) => (q.get('active') === 'true' ? items.filter((x) => x.active) : q.get('active') === 'false' ? items.filter((x) => !x.active) : items);
  const err = (status: number, message: string) => Response.json({ error: { message } }, { status });

  globalThis.fetch = (async (url: any, req?: any) => {
    const u = new URL(String(url));
    if (u.hostname !== 'api.stripe.com') return realFetch(url, req);
    if (init.down) throw new TypeError('fetch failed');
    const method = req?.method ?? 'GET';
    const path = u.pathname.replace(/^\/v1\//, '');
    const params = method === 'POST' ? new URLSearchParams(String(req?.body ?? '')) : u.searchParams;
    st.calls.push({ method, path, params });
    if (req?.headers?.authorization !== `Bearer ${KEY}`) return err(401, 'Invalid API Key provided');

    if (method === 'GET' && path === 'prices') {
      const keys = params.getAll('lookup_keys[]');
      return Response.json(page(activeOnly(st.prices, params).filter((p) => !keys.length || keys.includes(p.lookup_key)), params));
    }
    if (method === 'POST' && path === 'prices') {
      const holder = st.prices.find((p) => p.lookup_key && p.lookup_key === params.get('lookup_key'));
      if (holder) return err(400, `A price (\`${holder.id}\`) already uses that lookup key.`);
      const p = { id: nextId('price'), object: 'price', active: true, product: params.get('product'), currency: params.get('currency'), unit_amount: Number(params.get('unit_amount')), recurring: { interval: params.get('recurring[interval]') }, lookup_key: params.get('lookup_key'), nickname: params.get('nickname'), metadata: meta(params) };
      st.prices.push(p);
      return Response.json(p);
    }
    if (method === 'GET' && path === 'products') return Response.json(page(activeOnly(st.products, params), params));
    if (method === 'POST' && path === 'products') {
      const p = { id: nextId('prod'), object: 'product', active: true, name: params.get('name'), description: params.get('description'), unit_label: params.get('unit_label'), type: params.get('type') ?? 'service', metadata: meta(params) };
      st.products.push(p);
      return Response.json(p);
    }
    if (method === 'GET' && path === 'webhook_endpoints') return Response.json(page(st.endpoints, params));
    if (method === 'POST' && path === 'webhook_endpoints') {
      const e = { id: nextId('we'), object: 'webhook_endpoint', url: params.get('url'), enabled_events: params.getAll('enabled_events[]'), metadata: meta(params), status: 'enabled', livemode: false };
      const secret = `whsec_fake${st.seq}`;
      st.secrets[e.id] = secret;
      st.endpoints.push(e);
      return Response.json({ ...e, secret }); // Stripe shows the secret only when the endpoint is made
    }
    let m = path.match(/^webhook_endpoints\/(we_\w+)$/);
    if (m) {
      const i = st.endpoints.findIndex((e) => e.id === m![1]);
      if (i < 0) return err(404, 'No such webhook endpoint');
      if (method === 'DELETE') { st.endpoints.splice(i, 1); return Response.json({ id: m[1], deleted: true }); }
      const e = st.endpoints[i];
      if (params.getAll('enabled_events[]').length) e.enabled_events = params.getAll('enabled_events[]');
      if (params.get('disabled') === 'false') e.status = 'enabled';
      return Response.json(e);
    }
    if (method === 'GET' && path === 'billing_portal/configurations') return Response.json(page(activeOnly(st.portal, params), params));
    if (method === 'POST' && path === 'billing_portal/configurations') {
      const c = { id: nextId('bpc'), object: 'billing_portal.configuration', active: true, is_default: false, livemode: false, metadata: meta(params), params: Object.fromEntries(params) };
      st.portal.push(c);
      return Response.json(c);
    }
    if (method === 'POST' && path === 'billing_portal/sessions') {
      const conf = params.get('configuration');
      if (conf ? !st.portal.some((c) => c.id === conf) : !st.portal.some((c) => c.is_default)) return err(400, 'No configuration provided and your default configuration has not been created.');
      if (params.get('customer') === 'cus_gone') return err(400, 'No such customer');
      return Response.json({ id: nextId('bps'), url: `https://billing.stripe.com/p/session/test_${st.seq}` });
    }
    if (method === 'POST' && path === 'coupons') return Response.json({ id: nextId('coupon') });
    if (method === 'POST' && path === 'checkout/sessions') { const id = nextId('cs'); return Response.json({ id, url: `https://checkout.stripe.com/c/pay/${id}` }); }
    return err(404, `fake Stripe has no ${method} ${path}`);
  }) as typeof fetch;

  const writes = () => st.calls.filter((c) => c.method !== 'GET');
  return { st, writes, restore: () => { globalThis.fetch = realFetch; } };
}

const price = (id: string, lookup_key: string, unit_amount: number, product: string, active = true): Obj => ({ id, object: 'price', active, lookup_key, unit_amount, currency: 'usd', recurring: { interval: 'month' }, product });

function withEnv(vars: Record<string, string | undefined>) {
  const prev = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  return () => { for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
}

function boot() {
  const store = new MemoryStore();
  const svc = createServices({ store, clock: new SystemClock(), env: { PUBLIC_URL: PUBLIC } });
  install(svc);
  const s = seed(store, {});
  store.kvSet('tokens', 'owner-tok', s.owner.id);
  const server = createApp(svc).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { store, svc, s, base, close: () => server.close() };
}

const signed = (secret: string, body: string) => {
  const t = Math.floor(Date.now() / 1000);
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
};

/* ---------------- Plans and aliases ---------------- */

test('plans: essentials, autopilot, pro; "plus" is only an alias for Autopilot Pro, in input and in old records', () => {
  assert.deepEqual(PLANS, ['essentials', 'autopilot', 'pro']);
  assert.deepEqual(PLAN_NAMES, { essentials: 'Essentials', autopilot: 'Autopilot', pro: 'Autopilot Pro' });
  for (const v of ['pro', 'plus', 'PLUS', ' Pro ', 'Autopilot Pro', 'autopilot plus', 'autopilot_pro']) assert.equal(asPlanId(v), 'pro', v);
  assert.equal(asPlanId('Essentials'), 'essentials');
  assert.equal(asPlanId('autopilot'), 'autopilot');
  for (const v of ['gold', '', undefined, null, 42]) assert.equal(asPlanId(v), undefined, String(v));
  assert.equal(asTermId('annual'), 'contract12');
  assert.equal(asTermId('contract12'), 'contract12');
  assert.equal(asTermId('Monthly'), 'monthly');
  assert.equal(asTermId('yearly'), undefined);

  // Records saved before the rename say 'plus'; they keep working and are written back as 'pro'.
  const store = new MemoryStore();
  const s = seed(store, {});
  const old = store.update('owners', s.owner.id, { plan: 'plus' as Owner['plan'], billing: { status: 'active', plan: 'plus' as 'pro', customerId: 'cus_old', startedAt: now.toISOString(), updatedAt: now.toISOString() } });
  const oldOffer = store.insert('offers', { kind: 'demo', mode: 'base', ownerId: old.id, title: 'Old demo offer', percentOff: 0, months: 3, terms: ['monthly'], plans: ['plus' as 'pro'], expiresAt: '2026-10-25T00:00:00Z', status: 'issued', issuedBy: 'admin', createdAt: now.toISOString() });
  assert.equal(canUse(oldOffer, { owner: { ...old, billing: undefined } }, 'pro', 'monthly', now), undefined, "an old 'plus' offer works for Autopilot Pro");
  assert.match(canUse(oldOffer, { owner: { ...old, billing: undefined } }, 'autopilot', 'monthly', now)!, /Autopilot Pro/);
  const r = applyBillingEvent(store, { type: 'invoice.paid', data: { object: { customer: 'cus_old' } } }, now.toISOString())!;
  assert.equal(r.billing.plan, 'pro');
  assert.equal(store.get('owners', s.owner.id)!.plan, 'pro');

  // Subscription metadata from before the rename (no lookup key on the price).
  applyBillingEvent(store, { type: 'customer.subscription.updated', data: { object: { id: 'sub_old', customer: 'cus_old', status: 'active', metadata: { owner_id: s.owner.id, plan: 'plus' }, items: { data: [{ quantity: 2, price: {} }] } } } }, now.toISOString());
  assert.equal(store.get('owners', s.owner.id)!.billing!.plan, 'pro');

  // Offers: 'plus' accepted and stored as 'pro'; unknown plans refused.
  const o = issueOffer(store, { kind: 'demo', mode: 'base', title: 'Demo', months: 3, terms: ['monthly'], plans: ['plus' as 'pro'], email: 'lead@example.com', issuedBy: 'admin' }, now);
  assert.deepEqual(o.plans, ['pro']);
  assert.match(checkOfferRules({ kind: 'demo', mode: 'base', title: 'Demo', months: 3, terms: ['monthly'], plans: ['gold' as 'pro'], email: 'lead@example.com', issuedBy: 'admin' })!, /Unknown plan/);
});

/* ---------------- Lookup keys ---------------- */

test('lookup keys: keyhelm_<plan>_<monthly|annual>; keyhelm_*_contract12 and landwell_* are still read', async () => {
  assert.equal(lookupKey('essentials', 'monthly'), 'keyhelm_essentials_monthly');
  assert.equal(lookupKey('autopilot', 'contract12'), 'keyhelm_autopilot_annual');
  assert.equal(lookupKey('pro', 'contract12'), 'keyhelm_pro_annual');
  assert.deepEqual(planTermFromLookupKey('keyhelm_pro_annual'), { plan: 'pro', term: 'contract12' });
  assert.deepEqual(planTermFromLookupKey('keyhelm_essentials_monthly'), { plan: 'essentials', term: 'monthly' });
  assert.deepEqual(planTermFromLookupKey('keyhelm_autopilot_contract12'), { plan: 'autopilot', term: 'contract12' });
  assert.deepEqual(planTermFromLookupKey('keyhelm_plus_monthly'), { plan: 'pro', term: 'monthly' });
  assert.deepEqual(planTermFromLookupKey('landwell_plus_contract12'), { plan: 'pro', term: 'contract12' });
  assert.deepEqual(planTermFromLookupKey('landwell_essentials_monthly'), { plan: 'essentials', term: 'monthly' });
  for (const bad of ['keyhelm_gold_monthly', 'acme_pro_monthly', 'keyhelm_pro_weekly', '', undefined]) assert.equal(planTermFromLookupKey(bad), undefined, String(bad));
  assert.deepEqual(lookupKeyCandidates('pro', 'contract12'), ['keyhelm_pro_annual', 'keyhelm_pro_contract12', 'keyhelm_plus_contract12', 'landwell_plus_contract12']);
  assert.deepEqual(lookupKeyCandidates('essentials', 'monthly'), ['keyhelm_essentials_monthly', 'landwell_essentials_monthly']);

  // A subscription on an old landwell price is read as Autopilot Pro on the 12-month agreement.
  const store = new MemoryStore();
  const s = seed(store, {});
  applyBillingEvent(store, { type: 'customer.subscription.updated', data: { object: { id: 'sub_1', customer: 'cus_1', status: 'active', metadata: { owner_id: s.owner.id }, items: { data: [{ quantity: 3, price: { lookup_key: 'landwell_plus_contract12' } }] } } } }, now.toISOString());
  const b = store.get('owners', s.owner.id)!.billing!;
  assert.deepEqual([b.plan, b.term, b.doors], ['pro', 'contract12', 3]);

  // Checkout picks today's key first, then the older ones.
  const f = fakeStripe({ prices: [price('price_lw', 'landwell_plus_contract12', 6000, 'prod_old'), price('price_c12', 'keyhelm_pro_contract12', 1600, 'prod_pro'), price('price_annual', 'keyhelm_pro_annual', 1600, 'prod_pro')] });
  try {
    const client = new StripeBilling({ secretKey: KEY, publicUrl: PUBLIC });
    assert.equal((await client.priceFor('pro', 'contract12')).id, 'price_annual');
    const q = f.st.calls[0].params;
    assert.equal(q.get('active'), 'true');
    assert.deepEqual(q.getAll('lookup_keys[]'), lookupKeyCandidates('pro', 'contract12'));
    f.st.prices = f.st.prices.filter((p) => p.id !== 'price_annual');
    assert.equal((await client.priceFor('pro', 'contract12')).id, 'price_c12');
    f.st.prices = f.st.prices.filter((p) => p.id !== 'price_c12');
    assert.equal((await client.priceFor('pro', 'contract12')).id, 'price_lw');
    f.st.prices = [];
    await assert.rejects(client.priceFor('pro', 'contract12'), /keyhelm_pro_annual/);
  } finally {
    f.restore();
  }
});

/* ---------------- Prices and offer math ---------------- */

test('prices: the Stripe catalog prices, offer prices below them, floors below those, and the offer math', async () => {
  assert.deepEqual(LIST_PRICE, { essentials: { monthly: 1000, contract12: 800 }, autopilot: { monthly: 1500, contract12: 1200 }, pro: { monthly: 2000, contract12: 1600 } });
  assert.deepEqual(BASE_PRICE, { essentials: { monthly: 800, contract12: 600 }, autopilot: { monthly: 1200, contract12: 1000 }, pro: { monthly: 1600, contract12: 1300 } });
  assert.deepEqual(PRICE_FLOOR, { essentials: 500, autopilot: 800, pro: 1000 });
  for (const plan of PLANS) {
    for (const t of ['monthly', 'contract12'] as const) {
      assert.equal(LIST_PRICE[plan][t] % 100, 0, 'whole dollars');
      assert.equal(BASE_PRICE[plan][t] % 100, 0, 'whole dollars');
      assert.ok(BASE_PRICE[plan][t] < LIST_PRICE[plan][t], `${plan} ${t}: offer price below standard`);
      assert.ok(PRICE_FLOOR[plan] < BASE_PRICE[plan][t], `${plan} ${t}: floor below the offer price`);
      assert.equal(offerPrice({ mode: 'base', percentOff: 0 }, plan, t), BASE_PRICE[plan][t]);
    }
    assert.ok(LIST_PRICE[plan].contract12 < LIST_PRICE[plan].monthly, 'the 12-month agreement costs less');
  }
  // FTC guardrail: offers stay private, capped and time-limited; every preset still passes at the new prices.
  for (const [k, p] of Object.entries(PRESETS)) assert.equal(checkOfferRules({ ...p, email: 'a@b.co', issuedBy: p.kind === 'web_intro' || p.kind === 'referral' ? 'system' : 'admin' }), undefined, k);
  assert.match(checkOfferRules({ kind: 'demo', title: 'x', percentOff: 30, months: 1, email: 'a@b.co', issuedBy: 'admin' })!, /1–25%/);
  assert.match(checkOfferRules({ kind: 'winback', mode: 'base', title: 'x', months: 6, terms: ['monthly'], email: 'a@b.co', issuedBy: 'admin' })!, /1–3 months/);
  assert.equal(offerPrice({ mode: 'percent', percentOff: 20 }, 'pro', 'contract12'), 1280);

  const intro = { ...PRESETS['web-intro'], id: 'off_1', status: 'issued', expiresAt: '2026-10-27T00:00:00Z', percentOff: 0, createdAt: now.toISOString(), issuedBy: 'system' } as any;
  assert.deepEqual(quote('autopilot', 'monthly', 3, intro), { listPerDoor: 1500, offerPerDoor: 1200, discountedMonths: 1, firstYearTotal: 3 * (1200 + 1500 * 11), firstMonthDueToday: 3600 });
  assert.equal(dealText(intro, 'autopilot', 'monthly'), '$12/door for 1 month (standard $15)');

  // Checkout: the coupon takes exactly standard minus offer price per door; the agreement text names the plan and term.
  const f = fakeStripe({ prices: [price('price_pro_a', 'keyhelm_pro_annual', 1600, 'prod_pro'), price('price_ess_m', 'keyhelm_essentials_monthly', 1000, 'prod_ess')] });
  try {
    const client = new StripeBilling({ secretKey: KEY, publicUrl: PUBLIC });
    const owner = { id: 'own_x', name: 'Pat', email: 'pat@example.com', phone: '+17205550142', plan: 'pro', timezone: 'America/Denver', createdAt: now.toISOString() } as Owner;
    const demo = { ...PRESETS['demo-day'], id: 'off_d', status: 'issued', expiresAt: '2026-10-23T00:00:00Z', percentOff: 0, createdAt: now.toISOString(), issuedBy: 'admin' } as any;
    await client.createCheckout({ owner, plan: 'pro', term: 'contract12', doors: 4, offer: demo });
    const coupon = f.st.calls.find((c) => c.path === 'coupons')!.params;
    assert.equal(coupon.get('amount_off'), String((1600 - 1300) * 4));
    assert.equal(coupon.get('max_redemptions'), '1');
    assert.equal(coupon.get('duration_in_months'), '12');
    const cs = f.st.calls.find((c) => c.path === 'checkout/sessions')!.params;
    assert.equal(cs.get('line_items[0][price]'), 'price_pro_a');
    assert.equal(cs.get('line_items[0][quantity]'), '4');
    assert.equal(cs.get('subscription_data[metadata][plan]'), 'pro');
    assert.equal(cs.get('metadata[term]'), 'contract12');
    assert.equal(cs.get('allow_promotion_codes'), null, 'no public promo codes');
    const annual = cs.get('custom_text[submit][message]')!;
    assert.equal(annual, checkoutTerms('pro', 'contract12'));
    assert.match(annual, /^KeyHelm Autopilot Pro, 12-month agreement: /);
    assert.match(annual, /12-month KeyHelm agreement, billed monthly per door/);
    assert.match(annual, /first month is charged today/);
    const monthly = checkoutTerms('essentials', 'monthly');
    assert.match(monthly, /^KeyHelm Essentials, month-to-month: /);
    assert.match(monthly, /first month is charged today/);
    assert.match(monthly, /renews automatically every month .* until you cancel/);
    for (const text of [annual, monthly]) { assert.ok(text.length <= 1200, 'Stripe allows 1200 characters'); assert.doesNotMatch(text, /—/, 'no em dashes'); }
  } finally {
    f.restore();
  }
});

/* ---------------- Catalog setup ---------------- */

test('ensureCatalog creates exactly the missing products and prices with the right details, never edits existing ones, and is idempotent', async () => {
  const f = fakeStripe({
    pageSize: 2, // forces paging through the product list
    products: [
      { id: 'prod_window', object: 'product', active: true, name: 'Window cleaning', metadata: {} },
      { id: 'prod_oldplus', object: 'product', active: true, name: 'Autopilot Plus', metadata: {} },
      { id: 'prod_auto', object: 'product', active: true, name: 'KeyHelm Autopilot', metadata: { brand: 'keyhelm', plan: 'autopilot' } },
    ],
    prices: [price('price_auto_m', 'keyhelm_autopilot_monthly', 1500, 'prod_auto'), price('price_lw', 'landwell_plus_monthly', 7000, 'prod_oldplus')],
  });
  try {
    const r = await ensureCatalog({ secretKey: KEY });
    assert.deepEqual(r.ok, ['keyhelm_autopilot_monthly']);
    assert.deepEqual(r.warnings, []);
    assert.ok(f.writes().every((c) => c.method === 'POST' && (c.path === 'products' || c.path === 'prices')), 'only creates; nothing is edited, archived or deleted');

    const newProducts = f.writes().filter((c) => c.path === 'products').map((c) => c.params);
    assert.deepEqual(newProducts.map((p) => p.get('name')), ['KeyHelm Essentials', 'KeyHelm Autopilot Pro']);
    for (const p of newProducts) {
      const plan = p.get('metadata[plan]') as 'essentials' | 'pro';
      assert.equal(p.get('name'), PRODUCT_NAMES[plan]);
      assert.equal(p.get('unit_label'), 'door');
      assert.equal(p.get('description'), PLAN_CONTENTS[plan]);
      assert.equal(p.get('metadata[brand]'), 'keyhelm');
      assert.notEqual(p.get('type'), 'good', 'a service product');
    }
    assert.match(PLAN_CONTENTS.pro, /emergency repair dispatch.*smart-lock self-showings.*Zillow.*priority support/);

    const made = f.writes().filter((c) => c.path === 'prices').map((c) => c.params);
    assert.deepEqual(made.map((p) => p.get('lookup_key')).sort(), ['keyhelm_autopilot_annual', 'keyhelm_essentials_annual', 'keyhelm_essentials_monthly', 'keyhelm_pro_annual', 'keyhelm_pro_monthly']);
    const productOf = (plan: string) => f.st.products.find((p) => p.metadata?.brand === 'keyhelm' && p.metadata?.plan === plan)!.id;
    for (const p of made) {
      const { plan, term } = planTermFromLookupKey(p.get('lookup_key'))!;
      assert.equal(p.get('unit_amount'), String(LIST_PRICE[plan][term]));
      assert.equal(p.get('currency'), 'usd');
      assert.equal(p.get('recurring[interval]'), 'month', 'the 12-month agreement is billed monthly too');
      assert.equal(p.get('product'), productOf(plan));
      assert.equal(p.get('metadata[plan]'), plan);
      assert.equal(p.get('metadata[term]'), term === 'contract12' ? 'annual' : 'monthly');
    }
    assert.equal(made.find((p) => p.get('lookup_key') === 'keyhelm_autopilot_annual')!.get('product'), 'prod_auto', "uses Autopilot's existing product");
    assert.equal(made.find((p) => p.get('lookup_key') === 'keyhelm_autopilot_annual')!.get('nickname'), 'Autopilot, 12-month agreement, per door');
    assert.equal(made.find((p) => p.get('lookup_key') === 'keyhelm_pro_monthly')!.get('nickname'), 'Autopilot Pro, month-to-month, per door');
    assert.equal(r.created.length, 7);
    assert.equal(f.st.prices.find((p) => p.id === 'price_lw')!.active, true, 'old prices are left alone');

    // Again: everything is there, nothing is made.
    const before = f.st.calls.length;
    const again = await ensureCatalog({ secretKey: KEY });
    assert.equal(again.created.length, 0);
    assert.equal(again.ok.length, 6);
    assert.equal(f.st.calls.slice(before).filter((c) => c.method !== 'GET').length, 0);
  } finally {
    f.restore();
  }

  // An archived price holding a key, and a price that doesn't match LIST_PRICE: reported, never changed.
  const g = fakeStripe({
    products: [{ id: 'prod_ess', object: 'product', active: true, name: 'Essentials', metadata: {} }],
    prices: [price('price_arch', 'keyhelm_essentials_monthly', 2000, 'prod_ess', false), price('price_ess_a', 'keyhelm_essentials_annual', 900, 'prod_ess')],
  });
  try {
    const logs: string[] = [];
    const r = await ensureCatalog({ secretKey: KEY, log: (m) => logs.push(m) });
    assert.equal(r.warnings.length, 2);
    assert.match(r.warnings.join('\n'), /keyhelm_essentials_monthly belongs to an archived price \(price_arch\)/);
    assert.match(r.warnings.join('\n'), /keyhelm_essentials_annual is \$9 USD every month in Stripe, but KeyHelm's standard price is \$8/);
    assert.ok(!g.writes().some((c) => c.path === 'prices' && c.params.get('lookup_key')?.startsWith('keyhelm_essentials')), 'no new essentials price');
    assert.ok(!g.writes().some((c) => /^(prices|products)\/./.test(c.path)), 'existing prices and products are never edited');
    assert.equal(g.writes().filter((c) => c.path === 'prices').length, 4, 'autopilot and pro prices made');
    assert.equal(g.writes().find((c) => c.path === 'prices')!.params.get('product') !== 'prod_ess', true);
    assert.ok(logs.some((l) => /archived price/.test(l)));
  } finally {
    g.restore();
  }
});

/* ---------------- Webhook setup ---------------- */

test('ensureWebhook: one endpoint for exactly the events the handler processes, secret stored, and the webhook route accepts it', async () => {
  // BILLING_EVENTS is exactly what applyBillingEvent acts on.
  {
    const store = new MemoryStore();
    const s = seed(store, {});
    store.update('owners', s.owner.id, { billing: { status: 'active', customerId: 'cus_e', updatedAt: now.toISOString() } });
    const obj: Record<string, Obj> = {
      'checkout.session.completed': { mode: 'subscription', client_reference_id: s.owner.id, customer: 'cus_e', subscription: 'sub_e', payment_status: 'paid' },
      'customer.subscription.updated': { id: 'sub_e', customer: 'cus_e', status: 'active', items: { data: [] } },
      'customer.subscription.deleted': { id: 'sub_e', customer: 'cus_e', status: 'canceled', items: { data: [] } },
      'invoice.paid': { customer: 'cus_e' },
      'invoice.payment_failed': { customer: 'cus_e' },
    };
    assert.deepEqual(Object.keys(obj).sort(), [...BILLING_EVENTS].sort());
    for (const type of BILLING_EVENTS) assert.ok(applyBillingEvent(store, { type, data: { object: obj[type] } }, now.toISOString()), type);
    for (const type of ['charge.succeeded', 'payment_intent.succeeded', 'customer.created']) assert.equal(applyBillingEvent(store, { type, data: { object: { customer: 'cus_e' } } }, now.toISOString()), undefined, type);
  }

  const url = `${PUBLIC}/webhooks/stripe`;
  const f = fakeStripe({ endpoints: [{ id: 'we_other', object: 'webhook_endpoint', url: 'https://other.example/hooks', enabled_events: ['*'], metadata: {}, status: 'enabled' }] });
  const t = boot();
  const restoreEnv = withEnv({ STRIPE_WEBHOOK_SECRET: undefined, STRIPE_SECRET_KEY: undefined });
  try {
    // Nothing set up yet: the route says so.
    const body = JSON.stringify({ type: 'checkout.session.completed', data: { object: { mode: 'subscription', client_reference_id: t.s.owner.id, customer: 'cus_w', subscription: 'sub_w', payment_status: 'paid' } } });
    assert.equal((await fetch(`${t.base}/webhooks/stripe`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': signed('whsec_x', body) }, body })).status, 503);

    const r = await ensureWebhook({ secretKey: KEY, publicUrl: PUBLIC, store: t.store, env: {} });
    assert.equal(r.status, 'created');
    const created = f.writes().filter((c) => c.path === 'webhook_endpoints');
    assert.equal(created.length, 1);
    assert.equal(created[0].params.get('url'), url);
    assert.deepEqual(created[0].params.getAll('enabled_events[]'), BILLING_EVENTS);
    assert.equal(created[0].params.get('metadata[keyhelm]'), 'true');
    const secret = t.store.kvGet<string>(STRIPE_KV, 'webhookSecret')!;
    assert.equal(secret, f.st.secrets[r.id!]);
    assert.deepEqual(webhookSecrets(t.store, {}), [secret]);
    assert.ok(!JSON.stringify(r).includes(secret), 'the report never carries the secret');
    assert.ok(f.st.endpoints.some((e) => e.id === 'we_other'), "other endpoints aren't touched");

    // The route accepts events signed with the stored secret, and nothing else.
    const bad = await fetch(`${t.base}/webhooks/stripe`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': signed('whsec_wrong', body) }, body });
    assert.equal(bad.status, 400);
    const ok = await fetch(`${t.base}/webhooks/stripe`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': signed(secret, body) }, body });
    assert.equal(ok.status, 200);
    assert.equal(t.store.get('owners', t.s.owner.id)!.billing!.status, 'active');
    // STRIPE_WEBHOOK_SECRET keeps working next to it.
    const restoreSecret = withEnv({ STRIPE_WEBHOOK_SECRET: 'whsec_from_railway' });
    try {
      assert.deepEqual(webhookSecrets(t.store), ['whsec_from_railway', secret]);
      assert.equal((await fetch(`${t.base}/webhooks/stripe`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': signed('whsec_from_railway', body) }, body })).status, 200);
    } finally { restoreSecret(); }

    // Run again: kept, nothing written.
    let mark = f.st.calls.length;
    assert.equal((await ensureWebhook({ secretKey: KEY, publicUrl: PUBLIC, store: t.store, env: {} })).status, 'kept');
    assert.equal(f.st.calls.slice(mark).filter((c) => c.method !== 'GET').length, 0);

    // Someone changed its events in Stripe: put back exactly ours.
    f.st.endpoints.find((e) => e.id === r.id)!.enabled_events = ['invoice.paid'];
    mark = f.st.calls.length;
    assert.equal((await ensureWebhook({ secretKey: KEY, publicUrl: PUBLIC, store: t.store, env: {} })).status, 'kept');
    const fix = f.st.calls.slice(mark).filter((c) => c.method !== 'GET');
    assert.equal(fix.length, 1);
    assert.equal(fix[0].path, `webhook_endpoints/${r.id}`);
    assert.deepEqual(fix[0].params.getAll('enabled_events[]'), BILLING_EVENTS);

    // The secret was lost (fresh database): make a new endpoint, store its secret, delete the old KeyHelm one.
    t.store.kvDelete(STRIPE_KV, 'webhookSecret');
    const r2 = await ensureWebhook({ secretKey: KEY, publicUrl: PUBLIC, store: t.store, env: {} });
    assert.equal(r2.status, 'created');
    assert.deepEqual(r2.deleted, [r.id]);
    assert.equal(t.store.kvGet(STRIPE_KV, 'webhookSecret'), f.st.secrets[r2.id!]);
    assert.deepEqual(f.st.endpoints.filter((e) => e.url === url).map((e) => e.id), [r2.id]);
    assert.ok(f.st.endpoints.some((e) => e.id === 'we_other'));

    // STRIPE_WEBHOOK_SECRET set and a hand-made endpoint points here: hands off.
    f.st.endpoints.push({ id: 'we_hand', object: 'webhook_endpoint', url, enabled_events: BILLING_EVENTS, metadata: {}, status: 'enabled' });
    mark = f.st.calls.length;
    assert.equal((await ensureWebhook({ secretKey: KEY, publicUrl: PUBLIC, store: t.store, env: { STRIPE_WEBHOOK_SECRET: 'whsec_hand' } })).status, 'env');
    assert.equal(f.st.calls.slice(mark).filter((c) => c.method !== 'GET').length, 0);

    // No public https address (local runs): nothing to do, no calls.
    mark = f.st.calls.length;
    assert.equal((await ensureWebhook({ secretKey: KEY, publicUrl: 'http://localhost:8787', store: t.store, env: {} })).status, 'skipped');
    assert.equal(f.st.calls.length, mark);
  } finally {
    restoreEnv();
    t.close();
    f.restore();
  }
});

/* ---------------- Customer portal ---------------- */

test('ensurePortal makes the KeyHelm billing portal settings once, or uses the account default', async () => {
  const store = new MemoryStore();
  const f = fakeStripe();
  try {
    const r = await ensurePortal({ secretKey: KEY, publicUrl: PUBLIC, store });
    assert.equal(r.status, 'created');
    const p = f.writes().find((c) => c.path === 'billing_portal/configurations')!.params;
    assert.equal(p.get('business_profile[headline]'), 'KeyHelm billing');
    assert.equal(p.get('features[payment_method_update][enabled]'), 'true');
    assert.equal(p.get('features[invoice_history][enabled]'), 'true');
    assert.equal(p.get('features[subscription_cancel][enabled]'), 'true');
    assert.equal(p.get('features[subscription_cancel][mode]'), 'at_period_end');
    assert.equal(p.get('features[subscription_update][enabled]'), null, 'plan changes are not offered in the portal');
    assert.equal(p.get('default_return_url'), `${PUBLIC}/app`);
    assert.equal(p.get('metadata[keyhelm]'), 'true');
    assert.equal(portalConfiguration(store, KEY), r.id);
    assert.equal(portalConfiguration(store, 'sk_live_other'), undefined, 'a sandbox setup is never used with a live key');

    const mark = f.st.calls.length;
    assert.deepEqual(await ensurePortal({ secretKey: KEY, publicUrl: PUBLIC, store }), { status: 'kept', id: r.id });
    assert.equal(f.st.calls.slice(mark).filter((c) => c.method !== 'GET').length, 0);

    // Nate saved portal settings in the Stripe dashboard: those are the default and win.
    f.st.portal.push({ id: 'bpc_dashboard', active: true, is_default: true, metadata: {} });
    assert.deepEqual(await ensurePortal({ secretKey: KEY, publicUrl: PUBLIC, store }), { status: 'default', id: 'bpc_dashboard' });
    assert.equal(portalConfiguration(store, KEY), undefined);
  } finally {
    f.restore();
  }
});

test('POST /api/billing/portal: the signed-in owner gets a Stripe billing page for their own subscription', async () => {
  const t = boot();
  const f = fakeStripe();
  const restoreEnv = withEnv({ STRIPE_SECRET_KEY: undefined });
  const post = (token?: string) => fetch(`${t.base}/api/billing/portal`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: '{}' });
  try {
    assert.equal((await post('owner-tok')).status, 503, 'no Stripe key yet');
    process.env.STRIPE_SECRET_KEY = KEY;
    assert.equal((await post()).status, 401, 'owners only');

    const none = await post('owner-tok');
    assert.equal(none.status, 409);
    assert.match((await none.json()).error, /^There is no KeyHelm subscription on this account yet\./);
    assert.equal(f.st.calls.length, 0);

    const portal = await ensurePortal({ secretKey: KEY, publicUrl: PUBLIC, store: t.store });
    t.store.update('owners', t.s.owner.id, { billing: { status: 'active', plan: 'autopilot', customerId: 'cus_nate', updatedAt: now.toISOString() } });
    const r = await post('owner-tok');
    assert.equal(r.status, 200);
    const out = await r.json();
    assert.match(out.url, /^https:\/\/billing\.stripe\.com\//);
    assert.deepEqual(Object.keys(out), ['url']);
    const s = f.st.calls.find((c) => c.path === 'billing_portal/sessions')!.params;
    assert.equal(s.get('customer'), 'cus_nate');
    assert.equal(s.get('return_url'), `${PUBLIC}/app`);
    assert.equal(s.get('configuration'), portal.id);

    const billing = await (await fetch(`${t.base}/api/billing`, { headers: { authorization: 'Bearer owner-tok' } })).json();
    assert.equal(billing.canManageBilling, true);
    assert.equal(billing.planNames.pro, 'Autopilot Pro');

    t.store.update('owners', t.s.owner.id, { billing: { status: 'active', customerId: 'cus_gone', updatedAt: now.toISOString() } });
    const failed = await post('owner-tok');
    assert.equal(failed.status, 502);
    assert.match((await failed.json()).error, /Stripe could not open the billing page/);
  } finally {
    restoreEnv();
    t.close();
    f.restore();
  }
});

/* ---------------- At boot ---------------- */

test('boot setup: only with a Stripe key, can be turned off, sets up a new account from nothing, and never throws', async () => {
  const store = new MemoryStore();
  const logs: string[] = [];
  const log = (m: string) => logs.push(m);
  const f = fakeStripe();
  try {
    assert.equal(await startStripeSetup({ store, publicUrl: PUBLIC, env: {}, log }), undefined);
    assert.equal(await startStripeSetup({ store, publicUrl: PUBLIC, env: { STRIPE_SECRET_KEY: KEY, STRIPE_AUTO_SETUP: 'false' }, log }), undefined);
    assert.equal(f.st.calls.length, 0, 'no key, or turned off: Stripe is never called');

    // A brand-new Stripe account (what a fresh sk_live key looks like): everything is made once.
    const r = (await startStripeSetup({ store, publicUrl: PUBLIC, env: { STRIPE_SECRET_KEY: KEY }, log }))!;
    assert.deepEqual(r.errors, []);
    assert.equal(r.mode, 'test');
    assert.equal(r.catalog!.created.filter((c) => c.startsWith('product')).length, 3);
    assert.equal(r.catalog!.created.filter((c) => c.startsWith('price')).length, 6);
    assert.equal(r.webhook!.status, 'created');
    assert.equal(r.portal!.status, 'created');
    assert.deepEqual(f.st.prices.map((p) => p.lookup_key).sort(), PLANS.flatMap((p) => [lookupKey(p, 'contract12'), lookupKey(p, 'monthly')]).sort());
    assert.ok(f.writes().every((c) => c.method === 'POST' && ['products', 'prices', 'webhook_endpoints', 'billing_portal/configurations'].includes(c.path)), 'catalog objects only: no charges, customers, subscriptions or invoices');
    const saved = store.kvGet(STRIPE_KV, 'setupReport');
    assert.ok(saved);
    assert.ok(!JSON.stringify(saved).includes('whsec_'), 'the saved report has no secret');
    assert.ok(logs.some((l) => /Stripe setup \(test\): ready/.test(l)));

    // Next boot: nothing new.
    const mark = f.writes().length;
    const again = (await startStripeSetup({ store, publicUrl: PUBLIC, env: { STRIPE_SECRET_KEY: KEY }, log }))!;
    assert.deepEqual(again.errors, []);
    assert.equal(f.writes().length, mark);
  } finally {
    f.restore();
  }

  // Stripe unreachable: every step fails on its own, logged, and start-up goes on.
  const down = fakeStripe({ down: true });
  try {
    logs.length = 0;
    const r = (await startStripeSetup({ store: new MemoryStore(), publicUrl: PUBLIC, env: { STRIPE_SECRET_KEY: KEY }, log }))!;
    assert.equal(r.errors.length, 3);
    assert.ok(logs.some((l) => /catalog failed: fetch failed/.test(l)));
  } finally {
    down.restore();
  }
});

/* ---------------- Public signup, admin and offer page with the new plan ids ---------------- */

test('signup and admin accept "plus" and "annual", and Stripe gets Autopilot Pro on the 12-month agreement', async () => {
  const t = boot();
  const f = fakeStripe({ prices: [price('price_pro_a', 'keyhelm_pro_annual', 1600, 'prod_pro')] });
  const restoreEnv = withEnv({ STRIPE_SECRET_KEY: KEY, ADMIN_API_TOKEN: 'admin-secret' });
  try {
    const r = await fetch(`${t.base}/api/public/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Ana Ruiz', email: 'ana@example.com', phone: '720-555-0177', doors: 2, plan: 'plus', term: 'annual', agree: true }) });
    const out = await r.json();
    assert.equal(r.status, 200, JSON.stringify(out));
    assert.equal(out.plan, 'pro');
    assert.equal(out.term, 'contract12');
    assert.equal(out.quote.firstMonthDueToday, 2 * 1300, 'welcome offer: first months at the $13/door offer price');
    const ana = t.store.find('owners', (o) => o.email === 'ana@example.com')!;
    assert.equal(ana.plan, 'pro');
    assert.equal(ana.billing!.plan, 'pro');
    const cs = f.st.calls.find((c) => c.path === 'checkout/sessions')!.params;
    assert.equal(cs.get('line_items[0][price]'), 'price_pro_a');
    assert.equal(cs.get('subscription_data[metadata][plan]'), 'pro');
    assert.match(cs.get('custom_text[submit][message]')!, /^KeyHelm Autopilot Pro, 12-month agreement: /);
    assert.equal(f.st.calls.find((c) => c.path === 'coupons')!.params.get('amount_off'), String((1600 - 1300) * 2));

    const admin = { authorization: 'Bearer admin-secret', 'content-type': 'application/json' };
    const made = await fetch(`${t.base}/api/admin/offers`, { method: 'POST', headers: admin, body: JSON.stringify({ preset: 'demo-day', email: 'lead@example.com', plans: ['plus'] }) });
    assert.equal(made.status, 200);
    const offer = (await made.json())[0];
    assert.deepEqual(offer.plans, ['pro']);
    assert.equal((await fetch(`${t.base}/api/admin/offers`, { method: 'POST', headers: admin, body: JSON.stringify({ preset: 'demo-day', email: 'lead2@example.com', plans: ['gold'] }) })).status, 400);
    const pageHtml = await (await fetch(`${t.base}/offer/${offer.id}`)).text();
    assert.match(pageHtml, /Autopilot Pro · 12-month agreement/);
    assert.match(pageHtml, /<option value="pro" selected>Autopilot Pro<\/option>/);

    const overview = await (await fetch(`${t.base}/api/admin/overview`, { headers: admin })).json();
    assert.equal(overview.planNames.pro, 'Autopilot Pro');
    assert.deepEqual(Object.keys(overview.prices), ['essentials', 'autopilot', 'pro']);
    assert.ok(overview.owners.every((o: any) => o.plan !== 'plus'));
    assert.equal(overview.stripeSetup, null);
  } finally {
    restoreEnv();
    t.close();
    f.restore();
  }
});
