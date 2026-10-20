// KEYHELM BILLING: the only money KeyHelm ever charges is its own subscription.
// Owners pay a flat monthly price per door through Stripe Checkout, either
// month-to-month or on a 12-month agreement billed monthly at a lower price. The
// first month is always paid up front. Rent, deposits and vendor payments never
// touch KeyHelm.
//
// Stripe holds the STANDARD prices (LIST_PRICE in src/billing/offers.ts). Prices are
// found by lookup key (see ./plans.ts):
//   keyhelm_<plan>_monthly   month-to-month, per door / month
//   keyhelm_<plan>_annual    12-month agreement, billed monthly, per door / month
// where <plan> is essentials | autopilot | pro. Older keys (keyhelm_<plan>_contract12,
// landwell_*) are still read. When a key has no active price, the server creates it at
// boot (./catalog.ts). To change a price: make a new price in Stripe, move the lookup key
// to it, and change LIST_PRICE/BASE_PRICE.
//
// Private offers (src/billing/offers.ts) become a single-use Stripe coupon created
// at checkout time. Nothing is ever a public promotion code.

import type { Store } from '../store/store.ts';
import type { BillingTerm, Offer, Owner, OwnerBilling } from '../domain/types.ts';
import { BASE_PRICE } from './offers.ts';
import { PLAN_NAMES, asPlanId, asTermId, lookupKey, lookupKeyCandidates, planTermFromLookupKey, termName, type Plan } from './plans.ts';

export type { Plan } from './plans.ts';
export { PLANS, TERMS, PLAN_NAMES, asPlanId, asTermId, lookupKey, lookupKeyCandidates, planTermFromLookupKey } from './plans.ts';

/** True for a live-mode key (sk_live_ / rk_live_). */
export const isLiveKey = (key: string) => /^[sr]k_live_/.test(key);

/** One call to Stripe's API (form-encoded, as Stripe expects). Throws with Stripe's own message. */
export async function stripeCall(key: string, method: 'GET' | 'POST' | 'DELETE', path: string, params: URLSearchParams = new URLSearchParams()): Promise<any> {
  const qs = method === 'POST' ? '' : String(params);
  const url = 'https://api.stripe.com/v1/' + path + (qs ? '?' + qs : '');
  const r = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${key}`, ...(method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
    body: method === 'POST' ? params : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Stripe ${path}: ${data?.error?.message ?? r.status}`);
  return data;
}

export class StripeBilling {
  private key: string;
  private base: string;
  constructor(o: { secretKey: string; publicUrl: string }) {
    this.key = o.secretKey;
    this.base = o.publicUrl.replace(/\/$/, '');
  }

  private api(method: 'GET' | 'POST' | 'DELETE', path: string, params?: URLSearchParams): Promise<any> {
    return stripeCall(this.key, method, path, params);
  }

  /** The active price for this plan and term: today's lookup key first, then older keys. */
  async priceFor(plan: Plan, term: BillingTerm): Promise<{ id: string; unit_amount: number; lookup_key?: string }> {
    const keys = lookupKeyCandidates(plan, term);
    const q = new URLSearchParams({ active: 'true', limit: '100' });
    for (const k of keys) q.append('lookup_keys[]', k);
    const res = await this.api('GET', 'prices', q);
    const rank = (p: any) => { const i = keys.indexOf(p?.lookup_key); return i < 0 ? keys.length : i; };
    const p = [...(res.data ?? [])].sort((a: any, b: any) => rank(a) - rank(b))[0];
    if (!p) throw new Error(`No active Stripe price with lookup key ${lookupKey(plan, term)}`);
    return p;
  }

  /** A Stripe Checkout page where the owner starts their subscription. The first month is charged today. */
  async createCheckout(i: { owner: Owner; plan: Plan; term: BillingTerm; doors: number; offer?: Offer }): Promise<{ url: string; id: string }> {
    const price = await this.priceFor(i.plan, i.term);
    const p = new URLSearchParams({
      mode: 'subscription',
      client_reference_id: i.owner.id,
      'metadata[owner_id]': i.owner.id,
      'metadata[term]': i.term,
      'subscription_data[metadata][owner_id]': i.owner.id,
      'subscription_data[metadata][plan]': i.plan,
      'subscription_data[metadata][term]': i.term,
      'line_items[0][price]': price.id,
      'line_items[0][quantity]': String(Math.max(1, i.doors)),
      success_url: `${this.base}/billing/done?session={CHECKOUT_SESSION_ID}`,
      cancel_url: `${this.base}/#pricing`,
      'custom_text[submit][message]': checkoutTerms(i.plan, i.term),
    });
    if (i.offer) {
      // One single-use coupon per offer: it can't be reused, shared or found by anyone else.
      // "Original price" offers take an exact dollar amount off (standard − original, per door),
      // so the price lands exactly on the original; custom offers take a percent off the standard price.
      const doors = Math.max(1, i.doors);
      const off: Record<string, string> = i.offer.mode === 'base'
        ? { amount_off: String(Math.max(0, price.unit_amount - BASE_PRICE[i.plan][i.term]) * doors), currency: 'usd' }
        : { percent_off: String(i.offer.percentOff) };
      const c = await this.api('POST', 'coupons', new URLSearchParams({
        ...off,
        duration: 'repeating',
        duration_in_months: String(i.offer.months),
        max_redemptions: '1',
        redeem_by: String(Math.floor(Date.parse(i.offer.expiresAt) / 1000)),
        name: i.offer.title.slice(0, 40),
        'metadata[offer_id]': i.offer.id,
        'metadata[kind]': i.offer.kind,
      }));
      p.set('discounts[0][coupon]', c.id);
      p.set('metadata[offer_id]', i.offer.id);
      p.set('subscription_data[metadata][offer_id]', i.offer.id);
    }
    if (i.owner.billing?.customerId) p.set('customer', i.owner.billing.customerId);
    else if (i.owner.email) p.set('customer_email', i.owner.email);
    const s = await this.api('POST', 'checkout/sessions', p);
    return { url: s.url, id: s.id };
  }

  /** Account credit (e.g. a referral reward): lowers the owner's next KeyHelm invoice. */
  async credit(customerId: string, cents: number, description: string): Promise<void> {
    await this.api('POST', `customers/${customerId}/balance_transactions`, new URLSearchParams({ amount: String(-Math.abs(cents)), currency: 'usd', description }));
  }

  /**
   * A Stripe customer portal page where the owner updates their card, sees invoices or
   * cancels (at the end of the paid period). `configuration` is the portal setup KeyHelm made
   * (./catalog.ts); without it Stripe uses the account's default portal settings.
   */
  async portalSession(i: { customerId: string; returnUrl: string; configuration?: string }): Promise<{ url: string; id: string }> {
    const p = new URLSearchParams({ customer: i.customerId, return_url: i.returnUrl });
    if (i.configuration) p.set('configuration', i.configuration);
    const s = await this.api('POST', 'billing_portal/sessions', p);
    return { url: s.url, id: s.id };
  }
}

/** The plain-words agreement shown above the pay button on Stripe Checkout. */
export function checkoutTerms(plan: Plan, term: BillingTerm): string {
  const name = `KeyHelm ${PLAN_NAMES[plan]}, ${termName(term)}`;
  return term === 'contract12'
    ? `${name}: you are agreeing to a 12-month KeyHelm agreement, billed monthly per door. Your first month is charged today and each month after until the agreement ends.`
    : `${name}: your first month is charged today, then this plan renews automatically every month at the price shown until you cancel. Cancel anytime by emailing us; it takes effect at the end of the paid month.`;
}

/** Stripe webhook events KeyHelm listens to (register exactly these; ./catalog.ts does it for you). */
export const BILLING_EVENTS = ['checkout.session.completed', 'customer.subscription.updated', 'customer.subscription.deleted', 'invoice.paid', 'invoice.payment_failed'];

const STATUS: Record<string, OwnerBilling['status']> = {
  active: 'active', trialing: 'active', past_due: 'past_due', unpaid: 'past_due', incomplete: 'checkout_started',
  canceled: 'canceled', incomplete_expired: 'canceled', paused: 'canceled',
};

const addMonths = (iso: string, n: number) => { const d = new Date(iso); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString(); };

export interface BillingChange {
  ownerId: string;
  billing: OwnerBilling;
  /** First successful payment for this owner: start onboarding. */
  started?: boolean;
  /** A referral offer was used and the first month is paid: credit the referrer. */
  referralReward?: { referrerOwnerId: string; offerId: string };
}

/** Applies a Stripe billing event to the owner's record. */
export function applyBillingEvent(store: Store, ev: any, now: string): BillingChange | undefined {
  const obj = ev?.data?.object ?? {};
  const byCustomer = (c?: string) => (c ? store.find('owners', (o) => o.billing?.customerId === c) : undefined);
  let owner: Owner | undefined;
  let patch: Partial<OwnerBilling> = {};

  switch (ev?.type) {
    case 'checkout.session.completed': {
      if (obj.mode !== 'subscription') return undefined; // KeyHelm takes no other kind of payment
      const id = obj.client_reference_id ?? obj.metadata?.owner_id;
      owner = id ? store.get('owners', id) : byCustomer(obj.customer);
      const paid = obj.payment_status === 'paid' || obj.payment_status === 'no_payment_required';
      const term: BillingTerm = asTermId(obj.metadata?.term) ?? 'monthly';
      patch = { status: paid ? 'active' : 'checkout_started', customerId: obj.customer, subscriptionId: obj.subscription, term, ...(obj.metadata?.offer_id ? { offerId: obj.metadata.offer_id } : {}) };
      if (obj.metadata?.offer_id) {
        const o = store.get('offers', obj.metadata.offer_id);
        if (o && o.status === 'issued') store.update('offers', o.id, { status: 'redeemed', redeemedAt: now, ownerId: o.ownerId ?? id });
      }
      break;
    }
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      owner = (obj.metadata?.owner_id && store.get('owners', obj.metadata.owner_id)) || byCustomer(obj.customer);
      const item = obj.items?.data?.[0];
      const pt = planTermFromLookupKey(item?.price?.lookup_key);
      const metaPlan = asPlanId(obj.metadata?.plan);
      const deleted = ev.type.endsWith('deleted');
      patch = {
        status: deleted ? 'canceled' : STATUS[obj.status] ?? 'past_due', subscriptionId: obj.id, customerId: obj.customer,
        ...(pt ? { plan: pt.plan, term: pt.term } : metaPlan ? { plan: metaPlan } : {}),
        ...(item?.quantity ? { doors: item.quantity } : {}),
        ...(deleted ? { canceledAt: now } : {}),
      };
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

  const prev = owner.billing;
  const billing: OwnerBilling = { ...(prev ?? { status: 'checkout_started' }), ...patch, updatedAt: now } as OwnerBilling;
  // Records saved before the rename may say 'plus': always written back as 'pro'.
  if (billing.plan !== undefined) { const p = asPlanId(billing.plan); if (p) billing.plan = p; else delete billing.plan; }
  let started = false;
  if (billing.status === 'active' && !billing.startedAt) {
    billing.startedAt = now;
    if (billing.term === 'contract12') billing.contractEndsAt = addMonths(now, 12);
    started = true;
  }
  const plan = billing.plan ?? asPlanId(owner.plan);
  store.update('owners', owner.id, plan && plan !== owner.plan ? { billing, plan } : { billing });

  // Referral reward: once, after the referred owner's first paid month.
  let referralReward: BillingChange['referralReward'];
  if (started && billing.offerId) {
    const o = store.get('offers', billing.offerId);
    if (o?.kind === 'referral' && o.referrerOwnerId && !store.kvGet('referralPaid', o.id)) {
      store.kvSet('referralPaid', o.id, now);
      referralReward = { referrerOwnerId: o.referrerOwnerId, offerId: o.id };
    }
  }
  return { ownerId: owner.id, billing, started, referralReward };
}
