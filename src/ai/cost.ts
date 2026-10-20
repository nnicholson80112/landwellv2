// What each Claude call costs, and running totals for the AI service's /stats.
//
// Prices are US dollars per million tokens, from Anthropic's published prices for
// these models (checked Oct 2026). If Anthropic changes a price, change it here;
// nothing else depends on the numbers. A model missing from the table still works,
// its calls are just counted as "unpriced" instead of guessed.

import type { AICall, AIUsage } from './types.ts';

export interface Price {
  input: number;
  output: number;
  cacheWrite: number; // 5-minute cache write (1.25x input); the only cache lifetime KeyHelm uses
  cacheRead: number;
}

interface PriceRow extends Price {
  /** Some models bill a higher rate card when the whole prompt is longer than this. */
  longOver?: number;
  long?: Price;
}

export const PRICES: Record<string, PriceRow> = {
  // Two rate cards, picked by prompt length (KeyHelm prompts are a few thousand tokens).
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01, longOver: 100_000, long: { input: 0.5, output: 2.5, cacheWrite: 0.625, cacheRead: 0.05 } },
  'claude-haiku-4-5': { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  // Sonnet 5 is also where a declined Sonnet 5.5 message can be handed by the server-side fallback.
  'claude-sonnet-5': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  // Opus 5.5 cache reads are 0.05x input, not 0.1x.
  'claude-opus-5-5': { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-opus-4-8': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-fable-5-1': { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 0.25 },
};

/** Look a model up by id, ignoring a cloud prefix or a date suffix. */
export function priceOf(model: string, promptTokens = 0): Price | undefined {
  const id = model.replace(/^anthropic\./, '').replace(/-\d{8}$/, '');
  const row = PRICES[id];
  if (!row) return undefined;
  return row.long && row.longOver !== undefined && promptTokens > row.longOver ? row.long : row;
}

export const ZERO_USAGE: AIUsage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

const count = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? Math.round(x) : 0);

/** Read the four token counts from a Messages API `usage` object (missing or bad fields count as 0). */
export function usageFrom(u: any): AIUsage {
  return {
    input_tokens: count(u?.input_tokens),
    output_tokens: count(u?.output_tokens),
    cache_creation_input_tokens: count(u?.cache_creation_input_tokens),
    cache_read_input_tokens: count(u?.cache_read_input_tokens),
  };
}

export function addUsage(a: AIUsage, b: AIUsage): AIUsage {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_creation_input_tokens: a.cache_creation_input_tokens + b.cache_creation_input_tokens,
    cache_read_input_tokens: a.cache_read_input_tokens + b.cache_read_input_tokens,
  };
}

/** The whole prompt: uncached input + cache writes + cache reads. */
export const promptTokens = (u: AIUsage) => u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens;

/** Dollars for one call. Undefined if the model isn't in the price table. */
export function costUsd(model: string, u: AIUsage): number | undefined {
  const p = priceOf(model, promptTokens(u));
  if (!p) return undefined;
  return (u.input_tokens * p.input + u.output_tokens * p.output + u.cache_creation_input_tokens * p.cacheWrite + u.cache_read_input_tokens * p.cacheRead) / 1_000_000;
}

/**
 * One Messages API response → one AICall. With a server-side safety fallback the
 * response can hold several attempts (`usage.iterations`): declined attempts are billed
 * at the requested model's price, the attempt that answered at the serving model's.
 * Top-level `usage` covers only the attempt that answered, so iterations win when present.
 */
export function callFromResponse(requested: string, data: any): AICall {
  const served = typeof data?.model === 'string' && data.model ? data.model : requested;
  const its: any[] = Array.isArray(data?.usage?.iterations) ? data.usage.iterations : [];
  const priced = its.filter((it) => it && typeof it === 'object' && typeof it.input_tokens === 'number');
  if (priced.length > 1) {
    let usage = ZERO_USAGE;
    let total: number | undefined = 0;
    for (const it of priced) {
      const u = usageFrom(it);
      usage = addUsage(usage, u);
      const c = costUsd(it.type === 'fallback_message' ? served : requested, u);
      total = c === undefined || total === undefined ? undefined : total + c;
    }
    return { model: served, usage, costUsd: total };
  }
  const usage = usageFrom(data?.usage);
  return { model: served, usage, costUsd: costUsd(served, usage) };
}

/** Totals over several calls. Cost is undefined if any call couldn't be priced (never guessed). */
export function sumCalls(calls: AICall[]): { usage: AIUsage; costUsd: number | undefined } {
  let usage = ZERO_USAGE;
  let total: number | undefined = 0;
  for (const c of calls) {
    usage = addUsage(usage, c.usage);
    total = c.costUsd === undefined || total === undefined ? undefined : total + c.costUsd;
  }
  return { usage, costUsd: total };
}

const round = (n: number, d = 6) => Number(n.toFixed(d));

interface Totals { calls: number; costUsd: number; unpricedCalls: number; cacheHits: number; input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number }
interface RouteTotals { messages: number; costUsd: number }

const blank = (): Totals => ({ calls: 0, costUsd: 0, unpricedCalls: 0, cacheHits: 0, ...ZERO_USAGE });

function addTo(t: Totals, call: AICall) {
  t.calls++;
  t.input_tokens += call.usage.input_tokens;
  t.output_tokens += call.usage.output_tokens;
  t.cache_creation_input_tokens += call.usage.cache_creation_input_tokens;
  t.cache_read_input_tokens += call.usage.cache_read_input_tokens;
  if (call.usage.cache_read_input_tokens > 0) t.cacheHits++;
  if (call.costUsd === undefined) t.unpricedCalls++;
  else t.costUsd += call.costUsd;
}

/**
 * Two cache numbers, because they answer different questions:
 *   cacheHitRate      share of model calls that read the system prompt from the cache
 *   cachedPromptShare share of all prompt tokens billed at the cache-read price
 * The per-message part of each prompt (facts, history, the message) never caches, so
 * cachedPromptShare tops out well below 100% even when every call is a hit.
 */
function view(t: Totals) {
  const prompt = t.input_tokens + t.cache_creation_input_tokens + t.cache_read_input_tokens;
  return {
    calls: t.calls,
    unpricedCalls: t.unpricedCalls,
    costUsd: round(t.costUsd),
    avgCostPerCallUsd: t.calls ? round(t.costUsd / t.calls) : 0,
    cacheHitRate: t.calls ? round(t.cacheHits / t.calls, 3) : 0,
    cachedPromptShare: prompt ? round(t.cache_read_input_tokens / prompt, 3) : 0,
    tokens: { input_tokens: t.input_tokens, output_tokens: t.output_tokens, cache_creation_input_tokens: t.cache_creation_input_tokens, cache_read_input_tokens: t.cache_read_input_tokens },
  };
}

/** Running totals of model calls and spend, for /stats. In memory: resets when the service restarts. */
export class CostMeter {
  private all = blank();
  private models: Record<string, Totals> = {};
  private routes: Record<string, RouteTotals> = {};
  /** Messages that made at least one model call (paid or not). */
  modelMessages = 0;

  /** Record every model call one message took (an escalated message has two). */
  record(calls: AICall[], route?: string) {
    if (!calls.length) return;
    this.modelMessages++;
    let spent = 0;
    for (const call of calls) {
      addTo(this.all, call);
      addTo((this.models[call.model] ??= blank()), call);
      spent += call.costUsd ?? 0;
    }
    const r = (this.routes[route ?? 'none'] ??= { messages: 0, costUsd: 0 });
    r.messages++;
    r.costUsd += spent;
  }

  get totalUsd() {
    return this.all.costUsd;
  }

  /** `messages` = every message the service answered, including ones guardrails or rules handled for free. */
  snapshot(messages: number) {
    const byModel: Record<string, ReturnType<typeof view>> = {};
    for (const [k, m] of Object.entries(this.models)) byModel[k] = view(m);
    const byRoute: Record<string, RouteTotals & { avgCostPerMessageUsd: number }> = {};
    for (const [k, r] of Object.entries(this.routes)) byRoute[k] = { messages: r.messages, costUsd: round(r.costUsd), avgCostPerMessageUsd: r.messages ? round(r.costUsd / r.messages) : 0 };
    const { costUsd, ...rest } = view(this.all);
    return {
      totalUsd: costUsd,
      messages,
      modelMessages: this.modelMessages,
      avgCostPerMessageUsd: messages ? round(costUsd / messages) : 0,
      avgCentsPerMessage: messages ? round((costUsd * 100) / messages, 4) : 0,
      avgCostPerModelMessageUsd: this.modelMessages ? round(costUsd / this.modelMessages) : 0,
      ...rest,
      byModel,
      byRoute,
    };
  }
}
