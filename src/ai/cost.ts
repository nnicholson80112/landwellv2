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
  cacheWrite: number; // 5-minute cache write (1.25x input); the only TTL KeyHelm uses
  cacheRead: number;
}

interface PriceRow extends Price {
  /** Some models bill a higher rate card when the whole prompt is longer than this. */
  longOver?: number;
  long?: Price;
}

export const PRICES: Record<string, PriceRow> = {
  // Two rate cards, picked by prompt length. KeyHelm prompts are ~2K tokens.
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01, longOver: 100_000, long: { input: 0.5, output: 2.5, cacheWrite: 0.625, cacheRead: 0.05 } },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  'claude-sonnet-5': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  // Opus 5.5 cache reads are 0.05x input, not 0.1x.
  'claude-opus-5-5': { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
  // Older models a server-side safety fallback can hand a message to.
  'claude-opus-5': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-opus-4-8': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
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

/** Read the four token counts from a Messages API `usage` object (missing fields count as 0). */
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

/** Dollars for one call. Undefined if the model isn't in the price table. */
export function costUsd(model: string, u: AIUsage): number | undefined {
  const p = priceOf(model, u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens);
  if (!p) return undefined;
  return (u.input_tokens * p.input + u.output_tokens * p.output + u.cache_creation_input_tokens * p.cacheWrite + u.cache_read_input_tokens * p.cacheRead) / 1_000_000;
}

/**
 * One Messages API response → one AICall. With a server-side safety fallback the
 * response can hold several attempts (`usage.iterations`): declined attempts are billed
 * at the requested model's price, the attempt that answered at the serving model's.
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

const round = (n: number, d = 6) => Number(n.toFixed(d));

interface ModelTotals { calls: number; costUsd: number; unpricedCalls: number; input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number }

/** Running totals of model calls for /stats. */
export class CostMeter {
  calls = 0;
  unpricedCalls = 0;
  costUsd = 0;
  usage: AIUsage = { ...ZERO_USAGE };
  byModel: Record<string, ModelTotals> = {};

  add(call: AICall) {
    this.calls++;
    this.usage = addUsage(this.usage, call.usage);
    const m = (this.byModel[call.model] ??= { calls: 0, costUsd: 0, unpricedCalls: 0, ...ZERO_USAGE });
    m.calls++;
    m.input_tokens += call.usage.input_tokens;
    m.output_tokens += call.usage.output_tokens;
    m.cache_creation_input_tokens += call.usage.cache_creation_input_tokens;
    m.cache_read_input_tokens += call.usage.cache_read_input_tokens;
    if (call.costUsd === undefined) { this.unpricedCalls++; m.unpricedCalls++; }
    else { this.costUsd += call.costUsd; m.costUsd += call.costUsd; }
  }

  /**
   * cacheHitRate: share of all prompt tokens that were read from the cache
   * (cache reads / (uncached input + cache writes + cache reads)).
   */
  snapshot(messages: number, modelMessages: number) {
    const u = this.usage;
    const prompt = u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens;
    const byModel: Record<string, ModelTotals & { avgCostPerCallUsd: number; cacheHitRate: number }> = {};
    for (const [k, m] of Object.entries(this.byModel)) {
      const p = m.input_tokens + m.cache_creation_input_tokens + m.cache_read_input_tokens;
      byModel[k] = { ...m, costUsd: round(m.costUsd), avgCostPerCallUsd: m.calls ? round(m.costUsd / m.calls) : 0, cacheHitRate: p ? round(m.cache_read_input_tokens / p, 3) : 0 };
    }
    return {
      calls: this.calls,
      unpricedCalls: this.unpricedCalls,
      totalUsd: round(this.costUsd),
      avgCostPerMessageUsd: messages ? round(this.costUsd / messages) : 0,
      avgCostPerModelMessageUsd: modelMessages ? round(this.costUsd / modelMessages) : 0,
      cacheHitRate: prompt ? round(u.cache_read_input_tokens / prompt, 3) : 0,
      tokens: { ...u },
      byModel,
    };
  }
}
