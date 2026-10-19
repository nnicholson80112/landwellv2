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
import { applyBillingEvent } from '../src/billing/stripe.ts';

test('billing: Stripe events update only the owner\'s KeyHelm subscription', () => {
  const store = new MemoryStore();
  const s = seed(store, {});
  const now = new Date().toISOString();
  applyBillingEvent(store, { type: 'checkout.session.completed', data: { object: { mode: 'subscription', client_reference_id: s.owner.id, customer: 'cus_1', subscription: 'sub_1', payment_status: 'paid' } } }, now);
  assert.equal(store.get('owners', s.owner.id)!.billing!.status, 'active');
  applyBillingEvent(store, { type: 'customer.subscription.updated', data: { object: { id: 'sub_1', customer: 'cus_1', status: 'active', metadata: { owner_id: s.owner.id }, items: { data: [{ quantity: 4, price: { lookup_key: 'keyhelm_plus_monthly', recurring: {} } }] } } } }, now);
  const o = store.get('owners', s.owner.id)!;
  assert.equal(o.billing!.doors, 4);
  assert.equal(o.plan, 'plus');
  applyBillingEvent(store, { type: 'invoice.payment_failed', data: { object: { customer: 'cus_1' } } }, now);
  assert.equal(store.get('owners', s.owner.id)!.billing!.status, 'past_due');
  applyBillingEvent(store, { type: 'customer.subscription.deleted', data: { object: { id: 'sub_1', customer: 'cus_1', status: 'canceled', items: { data: [] } } } }, now);
  assert.equal(store.get('owners', s.owner.id)!.billing!.status, 'canceled');
  // Payment-mode checkouts (anything that isn't a subscription) are ignored: KeyHelm takes no other payments.
  assert.equal(applyBillingEvent(store, { type: 'checkout.session.completed', data: { object: { mode: 'payment', client_reference_id: s.owner.id } } }, now), undefined);
});

test('API: signed Stripe webhook, owner marks rent received', async () => {
  const store = new MemoryStore();
  const prev = process.env.STRIPE_WEBHOOK_SECRET;
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
  const svc = createServices({ store, clock: new SystemClock(), env: {} });
  install(svc);
  const s = seed(store, {});
  store.kvSet('tokens', 'tok', s.owner.id);
  const server = createApp(svc).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const body = JSON.stringify({ type: 'checkout.session.completed', data: { object: { mode: 'subscription', client_reference_id: s.owner.id, customer: 'cus_9', subscription: 'sub_9', payment_status: 'paid' } } });
    const bad = await fetch(`${base}/webhooks/stripe`, { method: 'POST', headers: { 'stripe-signature': 't=1,v1=00', 'content-type': 'application/json' }, body });
    assert.equal(bad.status, 400);
    const t = Math.floor(Date.now() / 1000);
    const sig = createHmac('sha256', 'whsec_test').update(`${t}.${body}`).digest('hex');
    const ok = await fetch(`${base}/webhooks/stripe`, { method: 'POST', headers: { 'stripe-signature': `t=${t},v1=${sig}`, 'content-type': 'application/json' }, body });
    assert.equal(ok.status, 200);
    assert.equal(store.get('owners', s.owner.id)!.billing!.status, 'active');

    const c = store.insert('charges', { ownerId: s.owner.id, leaseId: s.lease.id, kind: 'rent', amount: 275000, dueDate: '2026-11-01', paid: 0, status: 'open', period: '2026-11', notices: [] });
    const r = await fetch(`${base}/api/charges/${c.id}/received`, { method: 'POST', headers: { authorization: 'Bearer tok', 'content-type': 'application/json' }, body: '{}' });
    assert.equal((await r.json()).status, 'paid');
    assert.equal(store.list('payments')[0].method, 'owner_recorded');
    const noKey = await fetch(`${base}/api/billing/checkout`, { method: 'POST', headers: { authorization: 'Bearer tok', 'content-type': 'application/json' }, body: '{}' });
    if (!process.env.STRIPE_SECRET_KEY) assert.equal(noKey.status, 503);
  } finally {
    server.close();
    if (prev === undefined) delete process.env.STRIPE_WEBHOOK_SECRET; else process.env.STRIPE_WEBHOOK_SECRET = prev;
  }
});
