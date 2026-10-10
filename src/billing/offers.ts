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
// PRICING MODEL: the STANDARD price (LIST_PRICE) sits above the original price (about +15%,
// rounded up to whole $5 steps), and
// it's what anyone without an offer pays, including every customer once their offer
// months end. Most offers bring the price back to the ORIGINAL price (BASE_PRICE) for
// a set number of months. Because offers are private and time-limited, the standard
// price stays a real, regularly charged price, which is what US pricing rules require
// before you can advertise a discount from it (FTC 16 CFR 233.1). Never make an offer
// that everyone gets forever: that turns the standard price into a fictitious one.
//
// Every offer belongs to ONE owner (or one email before signup), is applied by the
// server at checkout (no code to type, nothing to share), expires, never stacks, and
// is checked against a per-door price floor.

import type { BillingTerm, Offer, Owner } from '../domain/types.ts';
import type { Store } from '../store/store.ts';
import type { Plan } from './stripe.ts';

export const DAY_MS = 86_400_000;

/** Offer prices ("original" prices), per door per month, in cents. Original-price offers bring the price back to these. Whole $5 steps. */
export const BASE_PRICE: Record<Plan, Record<BillingTerm, number>> = {
  essentials: { monthly: 1500, contract12: 1000 },
  autopilot: { monthly: 3500, contract12: 3000 },
  plus: { monthly: 6000, contract12: 5000 },
};

/** STANDARD prices (what Stripe charges without an offer): the original prices plus about 15%, rounded up to the next $5. Must match the Stripe prices. */
export const LIST_PRICE: Record<Plan, Record<BillingTerm, number>> = {
  essentials: { monthly: 2000, contract12: 1500 },
  autopilot: { monthly: 4500, contract12: 3500 },
  plus: { monthly: 7000, contract12: 6000 },
};

/**
 * The lowest per-door price any discount may reach. Set these from real cost to
 * serve (texting, AI, support) plus your minimum margin. Placeholders for now.
 */
export const PRICE_FLOOR: Record<Plan, number> = { essentials: 900, autopilot: 2000, plus: 3500 };

/** What each kind of offer is allowed to be. maxPercent only limits custom-% offers; "back to original price" is always allowed. */
export const OFFER_RULES: Record<Offer['kind'], { label: string; who: 'admin' | 'system'; maxPercent: number; maxMonths: number; terms: BillingTerm[]; defaultDays: number; maxDays: number }> = {
  demo:      { label: 'Demo-day offer',  who: 'admin',  maxPercent: 25, maxMonths: 12, terms: ['monthly', 'contract12'], defaultDays: 3,  maxDays: 7 },
  web_intro: { label: 'Web intro offer', who: 'system', maxPercent: 15, maxMonths: 3,  terms: ['monthly', 'contract12'], defaultDays: 7,  maxDays: 14 },
  winback:   { label: 'Win-back offer',  who: 'admin',  maxPercent: 25, maxMonths: 6,  terms: ['monthly', 'contract12'], defaultDays: 14, maxDays: 30 },
  referral:  { label: 'Referral offer',  who: 'system', maxPercent: 20, maxMonths: 3,  terms: ['monthly', 'contract12'], defaultDays: 30, maxDays: 60 },
  seasonal:  { label: 'Seasonal event',  who: 'admin',  maxPercent: 20, maxMonths: 6,  terms: ['contract12'],            defaultDays: 14, maxDays: 21 },
};

/** Month-to-month offers are capped shorter than 12-month ones: the longest deals buy a longer customer. */
export const MAX_MONTHS_MONTHLY = 3;

type Preset = { kind: Offer['kind']; mode: Offer['mode']; title: string; percentOff?: number; months: number; terms: BillingTerm[]; days?: number };

/** One-click presets for the admin console and for automatic offers. */
export const PRESETS: Record<string, Preset> = {
  'demo-day':        { kind: 'demo', mode: 'base', title: 'Demo-day price: the original rate, locked for your full 12-month agreement', months: 12, terms: ['contract12'], days: 3 },
  'demo-monthly':    { kind: 'demo', mode: 'base', title: 'Demo-day price: the original rate for your first 3 months, month-to-month', months: 3, terms: ['monthly'], days: 3 },
  'web-intro':       { kind: 'web_intro', mode: 'base', title: 'Welcome offer: your first month at the original rate', months: 1, terms: ['monthly'] },
  'web-intro-annual':{ kind: 'web_intro', mode: 'base', title: 'Welcome offer: your first 3 months at the original rate with a 12-month agreement', months: 3, terms: ['contract12'] },
  'winback':         { kind: 'winback', mode: 'base', title: 'Come back to Landwell: the original rate for 3 months', months: 3, terms: ['monthly', 'contract12'] },
  'referral':        { kind: 'referral', mode: 'base', title: 'Referred by a friend: the original rate for your first 3 months', months: 3, terms: ['monthly', 'contract12'] },
  'spring-leasing':  { kind: 'seasonal', mode: 'base', title: 'Spring Leasing Event: the original rate for 6 months with a 12-month agreement', months: 6, terms: ['contract12'], days: 14 },
  'year-end':        { kind: 'seasonal', mode: 'percent', percentOff: 20, title: 'Year-End Event: 20% off 2 months with a 12-month agreement', months: 2, terms: ['contract12'], days: 14 },
};

/** Referrers get this much account credit after the referred owner's first paid month. */
export const REFERRAL_CREDIT_CENTS = 5000;

const clean = (e?: string) => (e ?? '').trim().toLowerCase() || undefined;

/** Per-door monthly price while the offer applies. */
export function offerPrice(o: Pick<Offer, 'mode' | 'percentOff'>, plan: Plan, term: BillingTerm): number {
  return o.mode === 'base' ? BASE_PRICE[plan][term] : Math.round(LIST_PRICE[plan][term] * (1 - o.percentOff / 100));
}


export interface IssueInput {
  kind: Offer['kind'];
  mode?: Offer['mode'];
  title: string;
  percentOff?: number;
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
  const mode = i.mode ?? 'percent';
  if (r.who === 'system' && i.issuedBy !== 'system') return `${r.label}s are issued automatically, not by hand`;
  if (!i.ownerId && !clean(i.email)) return 'An offer must be for one owner or one email address';
  if (mode === 'percent' && !(Number(i.percentOff) >= 1 && Number(i.percentOff) <= r.maxPercent)) return `${r.label}: discount must be 1–${r.maxPercent}% off the standard price`;
  const terms = i.terms?.length ? i.terms : r.terms;
  if (terms.some((t) => !r.terms.includes(t))) return `${r.label}: only allowed with ${r.terms.map(termLabel).join(' or ')}`;
  const maxMonths = terms.includes('monthly') ? Math.min(r.maxMonths, MAX_MONTHS_MONTHLY) : r.maxMonths;
  if (!(Number.isInteger(i.months) && i.months >= 1 && i.months <= maxMonths)) return `${r.label}: 1–${maxMonths} months${terms.includes('monthly') && maxMonths < r.maxMonths ? ' when month-to-month is allowed' : ''}`;
  const days = i.days ?? r.defaultDays;
  if (!(days >= 1 && days <= r.maxDays)) return `${r.label}: must expire within ${r.maxDays} days`;
  for (const plan of (i.plans?.length ? i.plans : (Object.keys(LIST_PRICE) as Plan[]))) {
    for (const t of terms) {
      const price = offerPrice({ mode, percentOff: Number(i.percentOff) || 0 }, plan, t);
      if (price < PRICE_FLOOR[plan]) return `That would put ${plan} (${termLabel(t)}) at $${(price / 100).toFixed(2)}/door, below the $${(PRICE_FLOOR[plan] / 100).toFixed(2)} floor. Lower the discount or limit it to other plans.`;
    }
  }
  return undefined;
}

export function issueOffer(store: Store, i: IssueInput, now: Date): Offer {
  const reason = checkOfferRules(i);
  if (reason) throw new Error(reason);
  const r = OFFER_RULES[i.kind];
  const mode = i.mode ?? 'percent';
  return store.insert('offers', {
    kind: i.kind, mode, ownerId: i.ownerId, email: clean(i.email), title: i.title.trim(),
    percentOff: mode === 'base' ? 0 : Number(i.percentOff), months: i.months,
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

/** Total saving in cents per door over the offer, for picking the best one (never stacked). */
export const offerValue = (o: Offer, plan: Plan, term: BillingTerm) => (LIST_PRICE[plan][term] - offerPrice(o, plan, term)) * o.months;

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

/** Short description of the deal, e.g. "$35/door for 3 months (standard $45)". */
export function dealText(o: Offer, plan: Plan, term: BillingTerm): string {
  const d = (c: number) => '$' + (c / 100).toFixed(c % 100 ? 2 : 0);
  return `${d(offerPrice(o, plan, term))}/door for ${o.months} month${o.months > 1 ? 's' : ''} (standard ${d(LIST_PRICE[plan][term])})`;
}

/** Personal referral code for an owner (created once). */
export function referralCodeFor(store: Store, owner: Owner): string {
  if (owner.referralCode) return owner.referralCode;
  const base = owner.name.split(' ')[0].toUpperCase().replace(/[^A-Z]/g, '').slice(0, 6) || 'OWNER';
  let code = '';
  do code = `${base}-${Math.floor(1000 + Math.random() * 9000)}`; while (store.find('owners', (o) => o.referralCode === code));
  store.update('owners', owner.id, { referralCode: code });
  return code;
}

/** First-year cost with and without the offer. */
export function quote(plan: Plan, term: BillingTerm, doors: number, o?: Offer) {
  const list = LIST_PRICE[plan][term];
  const months = o ? Math.min(o.months, 12) : 0;
  const discounted = o ? offerPrice(o, plan, term) : list;
  return { listPerDoor: list, offerPerDoor: discounted, discountedMonths: months, firstYearTotal: doors * (discounted * months + list * (12 - months)), firstMonthDueToday: doors * (months ? discounted : list) };
}
