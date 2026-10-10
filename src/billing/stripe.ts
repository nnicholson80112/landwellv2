// LANDWELL BILLING: the only money Landwell ever charges is its own subscription.
// Owners pay a flat monthly price per door (plus a one-time setup fee) through
// Stripe Checkout. Rent, deposits and vendor payments never touch Landwell.
//
// Prices live in Stripe and are found by lookup key, so changing a price is done
// in the Stripe dashboard (new price, same lookup key), not in code:
//   landwell_essentials_monthly  · landwell_autopilot_monthly · landwell_plus_monthly  (per door / month)
//   landwell_setup_fee           (one-time, optional: skipped if it doesn't exist)

import type { Store } from '../store/store.ts';
import type { Owner, OwnerBilling } from '../domain/types.ts';

export type Plan = 'essentials' | 'autopilot' | 'plus';
export const PLAN_LOOKUP: Record<Plan, string> = {
  essentials: 'landwell_essentials_monthly',
  autopilot: 'landwell_autopilot_monthly',
  plus: 'landwell_plus_monthly',
};
export const SETUP_FEE_LOOKUP = 'landwell_setup_fee';

export class StripeBilling {
  private key: string;
  private base: string;
  constructor(o: { secretKey: string; publicUrl: string }) {
    this.key = o.secretKey;
    this.base = o.publicUrl.replace(/\/$/, '');
  }

  private async api(method: 'GET' | 'POST', path: string, params: URLSearchParams): Promise<any> {
    const url = 'https://api.stripe.com/v1/' + path + (method === 'GET' ? '?' + params : '');
    const r = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${this.key}`, ...(method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
      body: method === 'POST' ? params : undefined,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Stripe ${path}: ${data?.error?.message ?? r.status}`);
    return data;
  }

  /** Active prices keyed by lookup key. */
  async prices(): Promise<Record<string, { id: string; unit_amount: number; recurring: unknown }>> {
    const q = new URLSearchParams({ active: 'true', limit: '10' });
    for (const k of [...Object.values(PLAN_LOOKUP), SETUP_FEE_LOOKUP]) q.append('lookup_keys[]', k);
    const res = await this.api('GET', 'prices', q);
    return Object.fromEntries((res.data as any[]).map((p) => [p.lookup_key, p]));
  }

  /** A Stripe Checkout page where the owner starts their subscription. */
  async createCheckout(i: { owner: Owner; plan: Plan; doors: number }): Promise<{ url: string; id: string }> {
    const prices = await this.prices();
    const plan = prices[PLAN_LOOKUP[i.plan]];
    if (!plan) throw new Error(`No active Stripe price with lookup key ${PLAN_LOOKUP[i.plan]}`);
    const p = new URLSearchParams({
      mode: 'subscription',
      client_reference_id: i.owner.id,
      'metadata[owner_id]': i.owner.id,
      'subscription_data[metadata][owner_id]': i.owner.id,
      'subscription_data[metadata][plan]': i.plan,
      'line_items[0][price]': plan.id,
      'line_items[0][quantity]': String(Math.max(1, i.doors)),
      success_url: `${this.base}/billing/done?session={CHECKOUT_SESSION_ID}`,
      cancel_url: `${this.base}/#pricing`,
      allow_promotion_codes: 'false',
    });
    const setup = prices[SETUP_FEE_LOOKUP];
    if (setup && !i.owner.billing?.subscriptionId) { // setup fee only on the first subscription
      p.set('line_items[1][price]', setup.id);
      p.set('line_items[1][quantity]', '1');
    }
    if (i.owner.billing?.customerId) p.set('customer', i.owner.billing.customerId);
    else if (i.owner.email) p.set('customer_email', i.owner.email);
    const s = await this.api('POST', 'checkout/sessions', p);
    return { url: s.url, id: s.id };
  }
}

/** Stripe webhook events Landwell listens to (register exactly these). */
export const BILLING_EVENTS = ['checkout.session.completed', 'customer.subscription.updated', 'customer.subscription.deleted', 'invoice.paid', 'invoice.payment_failed'];

const STATUS: Record<string, OwnerBilling['status']> = {
  active: 'active', trialing: 'active', past_due: 'past_due', unpaid: 'past_due', incomplete: 'checkout_started',
  canceled: 'canceled', incomplete_expired: 'canceled', paused: 'canceled',
};

/** Applies a Stripe billing event to the owner's record. Returns what changed, for the audit log. */
export function applyBillingEvent(store: Store, ev: any, now: string): { ownerId: string; billing: OwnerBilling } | undefined {
  const obj = ev?.data?.object ?? {};
  const byCustomer = (c?: string) => (c ? store.find('owners', (o) => o.billing?.customerId === c) : undefined);
  let owner: Owner | undefined;
  let patch: Partial<OwnerBilling> = {};

  switch (ev?.type) {
    case 'checkout.session.completed': {
      if (obj.mode !== 'subscription') return undefined;
      const id = obj.client_reference_id ?? obj.metadata?.owner_id;
      owner = id ? store.get('owners', id) : byCustomer(obj.customer);
      patch = { status: obj.payment_status === 'paid' || obj.payment_status === 'no_payment_required' ? 'active' : 'checkout_started', customerId: obj.customer, subscriptionId: obj.subscription };
      break;
    }
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      owner = (obj.metadata?.owner_id && store.get('owners', obj.metadata.owner_id)) || byCustomer(obj.customer);
      const item = obj.items?.data?.find((x: any) => x.price?.recurring) ?? obj.items?.data?.[0];
      const plan = (Object.entries(PLAN_LOOKUP).find(([, k]) => k === item?.price?.lookup_key)?.[0] ?? obj.metadata?.plan) as Plan | undefined;
      patch = { status: ev.type.endsWith('deleted') ? 'canceled' : STATUS[obj.status] ?? 'past_due', subscriptionId: obj.id, customerId: obj.customer, ...(plan ? { plan } : {}), ...(item?.quantity ? { doors: item.quantity } : {}) };
      break;
    }
    case 'invoice.paid':
      owner = byCustomer(obj.customer);
      patch = { status: 'active' };
      break;
    case 'invoice.payment_failed':
      owner = byCustomer(obj.customer);
      patch = { status: 'past_due' };
      break;
    default:
      return undefined;
  }
  if (!owner) return undefined;
  const billing: OwnerBilling = { ...(owner.billing ?? { status: 'checkout_started' }), ...patch, updatedAt: now } as OwnerBilling;
  if (billing.plan && billing.plan !== owner.plan) store.update('owners', owner.id, { billing, plan: billing.plan });
  else store.update('owners', owner.id, { billing });
  return { ownerId: owner.id, billing };
}
