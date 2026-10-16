// Fair-housing and safety guardrails. These run BEFORE the AI sees a message
// (to route sensitive topics straight to the owner) and AFTER the AI drafts a
// reply (to block anything it should not say). They are deliberately simple,
// readable lists so the owner's attorney can review them.

import type { Fact, Intent } from './types.ts';

export interface PreCheck {
  intent?: Intent;
  route: boolean; // owner must handle
  reason?: string;
  emergency: boolean;
  /** A person may be in danger (gas, fire, smoke, CO, sparks, break-in): tell them to call 911. */
  danger?: boolean;
}

const EMERGENCY = /\b(gas (smell|leak)|smell(s)? (like )?gas|carbon monoxide|co alarm|fire|smoke|sparks?|flood(ing|ed)?|burst pipe|water (is |keeps )?(everywhere|pouring|gushing|spraying|flooding)|sewage|no heat|furnace (is )?out|heat (is )?out|locked out|break[- ]?in|broken (front |back )?door|power (is )?out|electrical burning)\b/i;
const ACCOMMODATION = /\b(disab\w*|accommodat\w*|modification|service (dog|animal)|assistance animal|support animal|\besa\b|emotional support|wheelchair|ramp|grab bar|hearing (impair\w*|aid|loss)|hard of hearing|deaf|blind|sign language|medical (need|condition))\b/i;
const FAIR_HOUSING = /\b(neighbou?rhood|area) (like|safe|good)|\bsafe (area|neighbou?rhood|for)|\bcrime\b|\bschools?\b|family[- ]friendly|good for (kids|families|singles|couples|seniors)|\b(kids|children)\b.*\b(allowed|ok|okay)\b|\b(church|mosque|synagogue|temple)\b|\b(race|racial|ethnic\w*|religio\w*|national origin|immigra\w*|citizen\w*)\b|who (lives|are the neighbors)|what kind of (people|neighbors)|\bdiverse\b|\bsection 8\b|\bvoucher\b/i;
const SCREENING = /\b(will i (get|be) (approved|accepted)|why (was|were) (i|we) (denied|rejected|declined)|(denied|rejected|declined) (my|our) application|application (was |been |got )?(denied|rejected|declined)|my (credit score|chances)|do i qualify|am i (approved|qualified))\b/i;
const LEGAL = /\b(lawyer|attorney|su(e|ing) (you|them|him|her|the|my|your|landlord|owner|management)|lawsuit|small claims|(take|taking|took) (you|them|him|her|it|this) to court|(go|going) to court|court (date|case|order|hearing|filing)|legal action|hud\b|discriminat\w*|retaliat\w*|harass\w*|complaint|code enforcement|habitability|withhold(ing)? rent|escrow)\b/i;

const DANGER = /\b(gas|carbon monoxide|co alarm|fire|smoke|sparks?|break[- ]?in|electrical burning|injur\w*|hurt)\b/i;

export function precheck(message: string, extraOwnerKeywords: string[] = []): PreCheck {
  if (EMERGENCY.test(message)) return { intent: 'emergency', route: false, emergency: true, danger: DANGER.test(message) };
  if (ACCOMMODATION.test(message)) return { intent: 'accommodation_request', route: true, reason: 'Accommodation or disability-related request. The owner handles these personally.', emergency: false };
  if (SCREENING.test(message)) return { intent: 'screening_decision_question', route: true, reason: 'Question about an application decision.', emergency: false };
  if (LEGAL.test(message)) return { intent: 'complaint_or_legal', route: true, reason: 'Complaint or legal topic.', emergency: false };
  if (FAIR_HOUSING.test(message)) return { intent: 'fair_housing_sensitive', route: true, reason: 'Question touching on neighbors, area or protected characteristics. Neutral answer sent.', emergency: false };
  for (const k of extraOwnerKeywords) {
    if (k && message.toLowerCase().includes(k.toLowerCase())) return { route: true, reason: `Owner asked to handle "${k}" personally.`, emergency: false };
  }
  return { route: false, emergency: false };
}

/** Pre-written replies for routed topics. Same words for everyone. */
export const SAFE_REPLY: Partial<Record<Intent | 'gas' | 'water' | 'urgent_repair', string>> = {
  accommodation_request: "Thank you for letting us know. I've passed this directly to the owner, who handles every accommodation request personally. They'll follow up with you soon.",
  screening_decision_question: 'Application decisions are made by the owner, using the same written criteria for every applicant. I\'ve passed your question to them.',
  complaint_or_legal: "Thank you. I've shared this with the owner so they can respond to you directly.",
  fair_housing_sensitive: "I can share facts about the home itself, like the price, size, features and availability. For information about the area, the city's website and public resources are the best source. Is there anything about the home I can help with?",
  gas: "Please leave the home right away and, once you're outside, call 911 or the gas company's emergency line. Don't use light switches or flames. I'm alerting the owner and the emergency vendor now.",
  emergency: "That sounds urgent. If anyone is in danger, please call 911 first. I'm contacting the emergency repair vendor and the owner right now.",
  water: "Oh no, let's stop the water first. If you can do it safely, turn the shut-off valve under the sink or behind the appliance clockwise, or use the home's main water shut-off. I'm getting an emergency plumber and letting the owner know right now.",
  urgent_repair: "That needs fast help. I'm contacting the emergency repair vendor and letting the owner know right now. I'll text you as soon as someone is on the way.",
};

// Phrases an ad or reply must never contain (HUD advertising guidance examples).
const BANNED_OUTPUT = [
  /\b(no|not for) (kids|children|families)\b/i, /\badults only\b/i, /\bperfect for (singles|couples|families|professionals|students|seniors|retirees)\b/i,
  /\b(ideal|great) for (singles|couples|families|professionals|seniors)\b/i, /\bfamily[- ]friendly\b/i, /\bsafe (neighbou?rhood|area)\b/i,
  /\b(christian|muslim|jewish|catholic)\b/i, /\bable[- ]bodied\b/i, /\bno (section 8|vouchers)\b/i, /\bexclusive (neighbou?rhood|community)\b/i,
  /\bmature (person|couple|tenant)s?\b/i, /\bwalking distance (to|of) (church|synagogue|mosque|temple)\b/i, /\bgood (schools|school district)\b/i,
];
const PROMISES = [/\byou('| a)re (approved|accepted)\b/i, /\byou (will|should) (be )?(approved|qualify)\b/i, /\bguarantee/i, /\blegal advice\b/i, /\byou (can|should) (sue|withhold)\b/i];

export interface PostCheck {
  ok: boolean;
  problems: string[];
}

/** Check an AI draft. Dollar amounts must come from the facts the AI was given. */
export function postcheck(reply: string, facts: Fact[]): PostCheck {
  const problems: string[] = [];
  for (const r of BANNED_OUTPUT) if (r.test(reply)) problems.push(`fair-housing phrase: ${r.source}`);
  for (const r of PROMISES) if (r.test(reply)) problems.push(`promise or advice: ${r.source}`);
  const factText = facts.map((f) => f.value + ' ' + f.label).join(' ');
  const amounts = reply.match(/\$\s?\d[\d,]*(\.\d{2})?/g) ?? [];
  for (const a of amounts) {
    const plain = a.replace(/[$,\s]/g, '').replace(/\.00$/, '');
    const inFacts = (factText.replace(/,/g, '').match(/\$\s?\d+(\.\d{2})?/g) ?? []).some((f) => f.replace(/[$\s]/g, '').replace(/\.00$/, '') === plain);
    if (!inFacts) problems.push(`amount not in facts: ${a}`);
  }
  if (reply.length > 1200) problems.push('reply too long');
  return { ok: problems.length === 0, problems };
}

/** Listing copy check, used before any ad is published. */
export function checkAdCopy(text: string): PostCheck {
  const problems: string[] = [];
  for (const r of BANNED_OUTPUT) if (r.test(text)) problems.push(`fair-housing phrase: ${r.source}`);
  return { ok: problems.length === 0, problems };
}
