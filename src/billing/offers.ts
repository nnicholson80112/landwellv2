// PRIVATE OFFERS. Modeled on what keeps promotions profitable at companies that
// discount constantly without training customers to wait for a sale:
//
//   • Housecall Pro / Jobber: the deepest discounts are tied to a longer commitment
//     (annual billing / intro price for 12 months), plus a two-sided referral reward.
//   • West Shore Home: an in-home (for us: live demo) price that's good for a short,
//     real window, and rotating named "savings events" with an end date.
//   • Nike: member-only, single-use codes tied to one account; can't be combined;
//     the best eligible offer applies automatically.
//   • Hulu: deep but time-boxed intro deals, and win-back offers sent only to former
//     subscribers by personal email link.
//
// Landwell's version: every offer belongs to ONE owner (or one email before signup),
// is applied by the server at checkout (no code to type, nothing to share), expires,
// never stacks, and is checked against a per-door price floor so a discount can't
// sell the product below what it costs to run.

import type { BillingTerm, Offer, Owner } from '../domain/types.ts';
import type { Store } from '../store/store.ts';
import type { Plan } from './stripe.ts';

export const DAY_MS = 86_400_000;

/** List prices per door per month, in cents. Must match the Stripe prices (see docs/DEPLOY.md). */
export const LIST_PRICE: Record<Plan, Record<BillingTerm, number>> = {
  essentials: { monthly: 1500, contract12: 1300 },
  autopilot: { monthly: 3500, contract12: 3000 },
  plus: { monthly: 5900, contract12: 5000 },
};

/**
 * The lowest per-door price any discount may reach. Set these from real cost to
 * serve (texting, AI, support) plus your minimum margin. Placeholders for now.
 */
export const PRICE_FLOOR: Record<Plan, number> = { essentials: 900, autopilot: 2000, plus: 3500 };

/** What each kind of offer is allowed to be. The admin console can't exceed these. */
export const OFFER_RULES: Record<Offer['kind'], { label: string; who: 'admin' | 'system'; maxPercent: number; maxMonths: number; terms: BillingTerm[]; defaultDays: number; maxDays: number }> = {
  demo:      { label: 'Demo-day offer',  who: 'admin',  maxPercent: 30, maxMonths: 3, terms: ['contract12'],            defaultDays: 3,  maxDays: 7 },
  web_intro: { label: 'Web intro offer', who: 'system', maxPercent: 15, maxMonths: 2, terms: ['monthly', 'contract12'], defaultDays: 7,  maxDays: 14 },
  winback:   { label: 'Win-back offer',  who: 'admin',  maxPercent: 25, maxMonths: 3, terms: ['monthly', 'contract12'], defaultDays: 14, maxDays: 30 },
  referral:  { label: 'Referral offer',  who: 'system', maxPercent: 20, maxMonths: 2, terms: ['monthly', 'contract12'], defaultDays: 30, maxDays: 60 },
  seasonal:  { label: 'Seasonal event',  who: 'admin',  maxPercent: 20, maxMonths: 2, terms: ['contract12'],            defaultDays: 14, maxDays: 21 },
};

/** One-click presets for the admin console and for automatic offers. */
export const PRESETS: Record<string, { kind: Offer['kind']; title: string; percentOff: number; months: number; terms: BillingTerm[]; days?: number }> = {
  'demo-day':        { kind: 'demo', title: 'Demo-day price: 25% off your first 3 months with a 12-month agreement', percentOff: 25, months: 3, terms: ['contract12'], days: 3 },
  'demo-quick-start':{ kind: 'demo', title: 'Start this week: 30% off your first month with a 12-month agreement', percentOff: 30, months: 1, terms: ['contract12'], days: 2 },
  'web-intro':       { kind: 'web_intro', title: 'Welcome offer: 10% off your first 2 months', percentOff: 10, months: 2, terms: ['monthly', 'contract12'] },
  'web-intro-annual':{ kind: 'web_intro', title: 'Welcome offer: 15% off your first 2 months with a 12-month agreement', percentOff: 15, months: 2, terms: ['contract12'] },
  'winback':         { kind: 'winback', title: 'Come back to Landwell: 25% off 3 months', percentOff: 25, months: 3, terms: ['monthly', 'contract12'] },
  'referral':        { kind: 'referral', title: 'Referred by a friend: 20% off your first 2 months', percentOff: 20, months: 2, terms: ['monthly', 'contract12'] },
  'spring-leasing':  { kind: 'seasonal', title: 'Spring Leasing Event: 15% off 2 months with a 12-month agreement', percentOff: 15, months: 2, terms: ['contract12'], days: 14 },
  'year-end':        { kind: 'seasonal', title: 'Year-End Event: 20% off 2 months with a 12-month agreement', percentOff: 20, months: 2, terms: ['contract12'], days: 14 },
};

/** Referrers get this much account credit after the referred owner's first paid month. */
export const REFERRAL_CREDIT_CENTS = 5000;

const clean = (e?: string) => (e ?? '').trim().toLowerCase() || undefined;

export interface IssueInput {
  kind: Offer['kind'];
  title: string;
  percentOff: number;
  months: number;
  terms?: BillingTerm[];
  plans?: Plan[];
  days?: number;
  ownerId?: string;
  email?: string;
  campaign?: string;
  note?: string;
  referrerOwnerId?: string;
  issuedBy: 'admin' | 'system';
}

/** Checks an offer against its kind's rules and the price floors. Returns a reason if it's not allowed. */
export function checkOfferRules(i: IssueInput): string | undefined {
  const r = OFFER_RULES[i.kind];
  if (!r) return `Unknown offer type ${i.kind}`;
  if (r.who === 'system' && i.issuedBy !== 'system') return `${r.label}s are issued automatically, not by hand`;
  if (!i.ownerId && !clean(i.email)) return 'An offer must be for one owner or one email address';
  if (!(i.percentOff >= 1 && i.percentOff <= r.maxPercent)) return `${r.label}: discount must be 1–${r.maxPercent}%`;
  if (!(Number.isInteger(i.months) && i.months >= 1 && i.months <= r.maxMonths)) return `${r.label}: 1–${r.maxMonths} months`;
  const days = i.days ?? r.defaultDays;
  if (!(days >= 1 && days <= r.maxDays)) return `${r.label}: must expire within ${r.maxDays} days`;
  const terms = i.terms?.length ? i.terms : r.terms;
  if (terms.some((t) => !r.terms.includes(t))) return `${r.label}: only allowed with ${r.terms.map(termLabel).join(' or ')}`;
  for (const plan of (i.plans?.length ? i.plans : (Object.keys(LIST_PRICE) as Plan[]))) {
    for (const t of terms) {
      const price = Math.round(LIST_PRICE[plan][t] * (1 - i.percentOff / 100));
      if (price < PRICE_FLOOR[plan]) return `That would put ${plan} (${termLabel(t)}) at $${(price / 100).toFixed(2)}/door, below the $${(PRICE_FLOOR[plan] / 100).toFixed(2)} floor. Lower the discount or limit it to other plans.`;
    }
  }
  return undefined;
}

export function issueOffer(store: Store, i: IssueInput, now: Date): Offer {
  const reason = checkOfferRules(i);
  if (reason) throw new Error(reason);
  const r = OFFER_RULES[i.kind];
  return store.insert('offers', {
    kind: i.kind, ownerId: i.ownerId, email: clean(i.email), title: i.title.trim(), percentOff: i.percentOff, months: i.months,
    terms: i.terms?.length ? i.terms : r.terms, plans: i.plans?.length ? i.plans : undefined,
    expiresAt: new Date(now.getTime() + (i.days ?? r.defaultDays) * DAY_MS).toISOString(),
    status: 'issued', issuedBy: i.issuedBy, campaign: i.campaign, note: i.note, referrerOwnerId: i.referrerOwnerId,
    createdAt: now.toISOString(),
  });
}

/** Marks offers past their expiry. */
export function expireOffers(store: Store, now: Date): number {
  let n = 0;
  for (const o of store.list('offers', (x) => x.status === 'issued' && x.expiresAt <= now.toISOString())) { store.update('offers', o.id, { status: 'expired' }); n++; }
  return n;
}

/** Is this offer usable by this person, for this plan and term, right now? */
export function canUse(o: Offer, who: { owner?: Owner; email?: string }, plan: Plan, term: BillingTerm, now: Date): string | undefined {
  if (o.status !== 'issued') return `This offer is ${o.status}`;
  if (o.expiresAt <= now.toISOString()) return 'This offer has expired';
  const email = clean(who.email ?? who.owner?.email);
  const mine = (o.ownerId && o.ownerId === who.owner?.id) || (!!o.email && o.email === email);
  if (!mine) return 'This offer belongs to someone else';
  if (!o.terms.includes(term)) return `This offer needs ${o.terms.map(termLabel).join(' or ')}`;
  if (o.plans && !o.plans.includes(plan)) return `This offer is for ${o.plans.join(' / ')}`;
  if (o.kind === 'winback' && who.owner?.billing?.status !== 'canceled') return 'Win-back offers are for former customers';
  if ((o.kind === 'web_intro' || o.kind === 'demo' || o.kind === 'referral') && who.owner?.billing?.startedAt) return 'This offer is for new customers';
  return undefined;
}

/** The value of an offer in cents per door, for picking the best one (Nike-style: best eligible offer wins, never stacked). */
export const offerValue = (o: Offer, plan: Plan, term: BillingTerm) => Math.round(LIST_PRICE[plan][term] * o.percentOff / 100) * o.months;

/** All usable offers for this person, best first. */
export function usableOffers(store: Store, who: { owner?: Owner; email?: string }, plan: Plan, term: BillingTerm, now: Date): Offer[] {
  return store.list('offers', (o) => !canUse(o, who, plan, term, now)).sort((a, b) => offerValue(b, plan, term) - offerValue(a, plan, term));
}

/** Picks the offer to apply: the one asked for if valid, else the best usable one. */
export function pickOffer(store: Store, who: { owner?: Owner; email?: string }, plan: Plan, term: BillingTerm, now: Date, offerId?: string): { offer?: Offer; error?: string } {
  if (offerId) {
    const o = store.get('offers', offerId);
    if (!o) return { error: 'Offer not found' };
    const why = canUse(o, who, plan, term, now);
    return why ? { error: why } : { offer: o };
  }
  return { offer: usableOffers(store, who, plan, term, now)[0] };
}

export const termLabel = (t: BillingTerm) => (t === 'contract12' ? '12-month agreement' : 'month-to-month');

/** Personal referral code for an owner (created once). */
export function referralCodeFor(store: Store, owner: Owner): string {
  if (owner.referralCode) return owner.referralCode;
  const base = owner.name.split(' ')[0].toUpperCase().replace(/[^A-Z]/g, '').slice(0, 6) || 'OWNER';
  let code = '';
  do code = `${base}-${Math.floor(1000 + Math.random() * 9000)}`; while (store.find('owners', (o) => o.referralCode === code));
  store.update('owners', owner.id, { referralCode: code });
  return code;
}

/** Example spend for a quote: first-year cost per door with and without the offer. */
export function quote(plan: Plan, term: BillingTerm, doors: number, o?: Offer) {
  const list = LIST_PRICE[plan][term];
  const months = o ? Math.min(o.months, 12) : 0;
  const discounted = Math.round(list * (1 - (o?.percentOff ?? 0) / 100));
  return { listPerDoor: list, firstMonthsPerDoor: discounted, discountedMonths: months, firstYearTotal: doors * (discounted * months + list * (12 - months)), firstMonthDueToday: doors * (months ? discounted : list) };
}
