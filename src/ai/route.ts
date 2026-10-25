// Which Claude model answers a message.
//
//   routine  everyday questions (rent, lease, tours, listings, simple vendor replies)
//            → a small, fast, cheap model (Claude Haiku 5.5 by default)
//   complex  repair conversations, vendor messages with money in them, long or
//            many-question messages → a stronger model (Claude Sonnet 5.5 by default)
//
// A routine answer that turns out to be about a repair or an emergency, or that the
// model isn't sure of, is asked again ONCE on the stronger model ("escalated").
// Everything here is pure (no network, no clock) so it can be tested line by line.

import type { AIInput, Intent } from './types.ts';
import { guessTrade } from './rules.ts';

export type Route = 'routine' | 'complex';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const DEFAULT_ROUTINE_MODEL = 'claude-haiku-5-5';
export const DEFAULT_COMPLEX_MODEL = 'claude-sonnet-5-5';
/** Autopilot Pro's top model ("our best AI model, upgraded as it improves"). */
export const DEFAULT_BEST_MODEL = 'claude-opus-5-5';

export type Tier = 'essentials' | 'autopilot' | 'pro';

/**
 * Which model answers each route, by plan:
 *   essentials  routine model for everything (the in-house AI; no stronger second ask)
 *   autopilot   routine model, complex model for repairs and harder messages
 *   pro         complex model for everyday messages, best model for repairs and harder ones
 */
export function modelsForTier<T>(tier: Tier | undefined, m: { routine: T; complex: T; best: T }): { low: T; high: T } {
  if (tier === 'essentials') return { low: m.routine, high: m.routine };
  if (tier === 'pro') return { low: m.complex, high: m.best };
  return { low: m.routine, high: m.complex };
}
/** Below this confidence a routine answer is asked again on the stronger model. */
export const ESCALATE_BELOW = 0.6;
/** The fact the front desk adds while a tenant and the AI are talking a repair through. */
export const REPAIR_CHAT_FACT = 'Problem we are talking through now';

// The same "something is wrong" words the rule-based AI uses to spot a repair, plus a few more.
const PROBLEM = /\b(broken|broke|not working|isn'?t working|doesn'?t work|won'?t|stopped|leak\w*|drip\w*|clog\w*|crack\w*|torn|stuck|(is|are|went|goes|keeps going|has gone|burn(ed|t)) out|out of order|fix|repair|problem|issue|damage\w*|noise|noisy|dirty|filthy|no (hot )?water|no heat|no power|no a\/?c|not (draining|heating|cooling|turning on|flushing|closing|locking)|backed up|overflow\w*|keeps running|running constantly|tripp\w*|beep\w*|flicker\w*|smell\w*)\b/i;
// Words that mean a repair on their own, whatever the trade.
const REPAIR_ALONE = /\b(leak\w*|clogg?\w*|mou?ld|flood\w*|repair\w*|water damage|maintenance request)\b/i;
const MONEY = /\$\s?\d|\b\d[\d,]*(\.\d{1,2})?\s*(dollars|bucks|usd)\b/i;
const MONEY_WORDS = /\b(quote\w*|invoice\w*|estimate\w*|bill\w*|total|parts|labor|labour|cost\w*|charg\w*|price\w*)\b/i;

/** Long messages and several questions at once are where a small model slips first. */
export const LONG_MESSAGE = 500;
export const MANY_QUESTIONS = 3;

/** Does this text read like a repair problem? Uses the rule-based AI's trade words. */
export function looksLikeRepair(text: string): boolean {
  return (guessTrade(text) !== 'general' && PROBLEM.test(text)) || REPAIR_ALONE.test(text);
}

/** A vendor message with an amount in it (a quote or an invoice): the numbers must be read right. */
export function vendorAmount(text: string): boolean {
  return MONEY.test(text) || (MONEY_WORDS.test(text) && /\d/.test(text));
}

export interface RouteDecision {
  route: Route;
  reason: string;
}

/** Pick the model for one message. Pure: same input, same answer. */
export function chooseRoute(input: AIInput): RouteDecision {
  const t = input.message ?? '';
  if (input.facts.some((f) => f.label.startsWith(REPAIR_CHAT_FACT))) return { route: 'complex', reason: 'repair conversation' };
  if (input.senderRole === 'tenant' && looksLikeRepair(t)) return { route: 'complex', reason: 'looks like a repair' };
  if (input.senderRole === 'vendor' && vendorAmount(t)) return { route: 'complex', reason: 'vendor update with an amount' };
  if (t.length > LONG_MESSAGE) return { route: 'complex', reason: 'long message' };
  if ((t.match(/\?/g) ?? []).length >= MANY_QUESTIONS) return { route: 'complex', reason: 'several questions' };
  return { route: 'routine', reason: 'routine message' };
}

const STRONGER: Intent[] = ['maintenance_request', 'maintenance_update', 'emergency'];

/**
 * Should a routine answer be asked again on the stronger model? Returns the reason, or
 * undefined to keep it. `raw` is what the model wrote, `confidence` the clamped value.
 */
export function escalationReason(raw: any, confidence: number, input: AIInput, below = ESCALATE_BELOW): string | undefined {
  const intent = typeof raw?.intent === 'string' ? raw.intent : undefined;
  if (intent && STRONGER.includes(intent as Intent)) return `intent ${intent}`;
  if (intent && !input.allowedIntents.includes(intent as Intent)) return `intent ${intent} not allowed here`;
  if (confidence < below) return `low confidence ${confidence}`;
  return undefined;
}

export interface ModelConfig {
  routine: string;
  complex: string;
  best: string;
  effortRoutine: Effort;
  effortComplex: Effort;
  /** Settings that were ignored or look wrong, for the startup log. */
  warnings: string[];
}

const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Read the model settings from Railway Variables (all optional). */
export function modelConfig(env: Record<string, string | undefined>): ModelConfig {
  const warnings: string[] = [];
  const id = (name: string) => {
    const v = env[name]?.trim();
    if (v && /-\d{8}$/.test(v)) warnings.push(`${name}=${v} has a date suffix; use the plain model id (e.g. ${v.replace(/-\d{8}$/, '')})`);
    return v || undefined;
  };
  const effort = (name: string): Effort => {
    const v = env[name]?.trim().toLowerCase();
    if (!v) return 'low';
    if ((EFFORTS as string[]).includes(v)) return v as Effort;
    warnings.push(`${name}=${v} is not one of ${EFFORTS.join(', ')}; using low`);
    return 'low';
  };
  return {
    routine: id('AI_MODEL_ROUTINE') ?? DEFAULT_ROUTINE_MODEL,
    complex: id('AI_MODEL_COMPLEX') ?? id('ANTHROPIC_MODEL') ?? DEFAULT_COMPLEX_MODEL,
    best: id('AI_MODEL_BEST') ?? DEFAULT_BEST_MODEL,
    effortRoutine: effort('AI_EFFORT_ROUTINE'),
    effortComplex: effort('AI_EFFORT_COMPLEX'),
    warnings,
  };
}
