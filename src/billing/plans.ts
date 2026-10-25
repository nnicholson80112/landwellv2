// KEYHELM PLANS AND STRIPE LOOKUP KEYS. No imports besides types, so offers.ts, stripe.ts
// and catalog.ts can all use it without import cycles.
//
//   Plan ids:  essentials | autopilot | pro    shown as Essentials / Autopilot / Autopilot Pro
//              ('plus' is the old id for Autopilot Pro: accepted in input and old records, never written)
//   Terms:     monthly (month-to-month) | contract12 (12-month agreement, billed monthly)
//   Stripe:    lookup key keyhelm_<plan>_monthly | keyhelm_<plan>_annual ("annual" = the 12-month
//              agreement; it is still billed every month). Older keys are still read:
//              keyhelm_<plan>_contract12 and landwell_<plan>_<monthly|contract12> (landwell 'plus' = 'pro').

import type { BillingTerm } from '../domain/types.ts';

export type Plan = 'essentials' | 'autopilot' | 'pro';
export const PLANS: Plan[] = ['essentials', 'autopilot', 'pro'];
export const TERMS: BillingTerm[] = ['monthly', 'contract12'];

/** What customers see. */
export const PLAN_NAMES: Record<Plan, string> = { essentials: 'Essentials', autopilot: 'Autopilot', pro: 'Autopilot Pro' };

/** What each plan includes (the same words as the Stripe product descriptions; the full list is in entitlements.ts). */
export const PLAN_CONTENTS: Record<Plan, string> = {
  essentials: 'KeyHelm in-house AI, repair requests with guided fixes and vendor dispatch, 24/7 emergency dispatch, rent reminders and late notices, applications and screening, smart-lock self-showings and listings, your own lease filled in and e-signed, renewals, move-outs and deposit statements, income and expense books and monthly statements.',
  autopilot: 'Everything in Essentials, plus text and email automation answering tenants 24/7, our high-end AI model, and state-specific leases with required disclosures.',
  pro: 'Everything in Autopilot, plus the Landlord Forms Pack (all state documents), voice AI for calls, our best AI model, and 24/7 customer support.',
};

/**
 * A plan id from a form, an API call, a Stripe record or an old saved record. 'plus' (the old
 * id for Autopilot Pro) becomes 'pro'; display names work too. Undefined when it isn't a plan.
 */
export function asPlanId(v: unknown): Plan | undefined {
  const s = String(v ?? '').trim().toLowerCase().replace(/[\s_-]+/g, ' ');
  if (s === 'pro' || s === 'plus' || s === 'autopilot pro' || s === 'autopilot plus') return 'pro';
  return s === 'essentials' || s === 'autopilot' ? s : undefined;
}

/** A billing term from input. 'annual' (Stripe's name for the 12-month agreement) means 'contract12'. */
export function asTermId(v: unknown): BillingTerm | undefined {
  const s = String(v ?? '').trim().toLowerCase();
  return s === 'monthly' ? 'monthly' : s === 'contract12' || s === 'annual' ? 'contract12' : undefined;
}

/** The term as Stripe's lookup keys and metadata name it. */
export const stripeTerm = (t: BillingTerm): 'monthly' | 'annual' => (t === 'contract12' ? 'annual' : 'monthly');

/** "Autopilot Pro, 12-month agreement" style names, used on checkout and in Stripe nicknames. */
export const termName = (t: BillingTerm) => (t === 'contract12' ? '12-month agreement' : 'month-to-month');

/** The lookup key KeyHelm's Stripe price for this plan and term must carry. */
export const lookupKey = (plan: Plan, term: BillingTerm) => `keyhelm_${plan}_${stripeTerm(term)}`;

/** Every lookup key that may hold this plan's price, best first: today's key, then older ones. */
export function lookupKeyCandidates(plan: Plan, term: BillingTerm): string[] {
  const keys = [lookupKey(plan, term), `keyhelm_${plan}_${term}`];
  if (plan === 'pro') keys.push(`keyhelm_plus_${term}`);
  keys.push(`landwell_${plan === 'pro' ? 'plus' : plan}_${term}`);
  return [...new Set(keys)];
}

/** Plan and term from any KeyHelm lookup key, current or older. */
export function planTermFromLookupKey(k: unknown): { plan: Plan; term: BillingTerm } | undefined {
  const m = String(k ?? '').match(/^(?:keyhelm|landwell)_(essentials|autopilot|pro|plus)_(monthly|annual|contract12)$/);
  const plan = m ? asPlanId(m[1]) : undefined;
  const term = m ? asTermId(m[2]) : undefined;
  return plan && term ? { plan, term } : undefined;
}
