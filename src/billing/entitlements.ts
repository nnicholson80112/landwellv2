// WHAT EACH PLAN INCLUDES. Each plan has everything in the plan below it, plus its own features.
// The server checks these (the AI, phone calls, state documents); the owner app and website
// show the same list. Change a plan here and the checks, /api/me and the app follow.
//
//   Essentials     everything KeyHelm does day to day, on the in-house AI. Workflow messages
//                  (repairs, emergencies, showings, renewals, move-outs) are automatic; general
//                  questions get a drafted reply the owner sends.
//   Autopilot      + text and email automation answering tenants 24/7, the high-end AI model,
//                  state-specific leases and required disclosures.
//   Autopilot Pro  + the Landlord Forms Pack (all state documents), voice AI for calls,
//                  the best AI model, 24/7 customer support.

import type { Owner } from '../domain/types.ts';
import { asPlanId, type Plan } from './plans.ts';

export type Feature =
  | 'assistant' // answers general tenant and prospect questions on its own, any hour
  | 'high_ai' // the high-end model for repairs and harder messages
  | 'best_ai' // the best model, upgraded as it improves
  | 'voice' // voice AI answers calls
  | 'state_leases' // state lease, month-to-month agreement, disclosures, lead-paint form
  | 'forms_pack' // every state document (condition reports, notices, deposit itemization)
  | 'support_247'; // 24/7 customer support

/** The lowest plan that includes each feature. */
export const MIN_PLAN: Record<Feature, Plan> = {
  assistant: 'autopilot',
  high_ai: 'autopilot',
  state_leases: 'autopilot',
  best_ai: 'pro',
  voice: 'pro',
  forms_pack: 'pro',
  support_247: 'pro',
};

const RANK: Record<Plan, number> = { essentials: 0, autopilot: 1, pro: 2 };

/** The plan an owner is on. Accounts made before plans existed (demo, admin-made) count as Autopilot. */
export function planOf(owner: Pick<Owner, 'plan'> | undefined): Plan {
  return asPlanId(owner?.plan) ?? 'autopilot';
}

export function planIncludes(plan: Plan, feature: Feature): boolean {
  return RANK[plan] >= RANK[MIN_PLAN[feature]];
}

export function allows(owner: Pick<Owner, 'plan'> | undefined, feature: Feature): boolean {
  return planIncludes(planOf(owner), feature);
}

/** Which AI tier answers for this owner (see src/ai/route.ts). */
export type AITier = Plan;

/**
 * The feature list customers see on the website, in Stripe and in the app, with the lowest plan
 * that has each one. Same order and words as the website's plan cards.
 */
export const FEATURE_LIST: { label: string; plan: Plan }[] = [
  { label: 'KeyHelm in-house AI', plan: 'essentials' },
  { label: 'Our high-end AI model', plan: 'autopilot' },
  { label: 'Our best AI model, upgraded as it improves', plan: 'pro' },
  { label: 'Voice AI for tenant and prospect calls', plan: 'pro' },
  { label: 'Repair requests, guided fixes and vendor dispatch', plan: 'essentials' },
  { label: '24/7 emergency repair dispatch', plan: 'essentials' },
  { label: 'Text and email automation, answering tenants 24/7', plan: 'autopilot' },
  { label: 'Rent reminders and late notices', plan: 'essentials' },
  { label: 'Applications and screening', plan: 'essentials' },
  { label: 'Smart-lock self-showings and listings', plan: 'essentials' },
  { label: 'Your own lease, filled in and e-signed', plan: 'essentials' },
  { label: 'Renewals, move-outs and deposit statements', plan: 'essentials' },
  { label: 'Income and expense books and monthly statements', plan: 'essentials' },
  { label: 'State-specific leases and required disclosures', plan: 'autopilot' },
  { label: 'Landlord Forms Pack: all 10 state documents', plan: 'pro' },
  { label: '24/7 customer support', plan: 'pro' },
];

/** Everything an owner's plan includes, for /api/me. */
export function entitlementsOf(owner: Pick<Owner, 'plan'> | undefined): { plan: Plan; features: Record<Feature, boolean>; list: { label: string; plan: Plan; included: boolean }[] } {
  const plan = planOf(owner);
  const features = Object.fromEntries((Object.keys(MIN_PLAN) as Feature[]).map((f) => [f, planIncludes(plan, f)])) as Record<Feature, boolean>;
  return { plan, features, list: FEATURE_LIST.map((f) => ({ ...f, included: RANK[plan] >= RANK[f.plan] })) };
}
