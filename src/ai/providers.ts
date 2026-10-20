import type { AICall, AIInput, AIResult, CommunicationAI, Intent } from './types.ts';
import { INTENTS, RESULT_SCHEMA, SYSTEM_PROMPT, parseJson, systemPrompt, userPrompt } from './prompt.ts';
import { RuleBasedAI } from './rules.ts';
import { callFromResponse, promptTokens, sumCalls, usageFrom } from './cost.ts';
import { ESCALATE_BELOW, chooseRoute, escalationReason, modelConfig, type Effort } from './route.ts';

const ROUTES = ['routine', 'complex', 'escalated'];
const isCost = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x < 100;
const shortId = (x: unknown) => typeof x === 'string' && x.length > 0 && x.length <= 100;

/** Model and cost details a trusted service may attach to its answer. Bad values are dropped. */
function metaFrom(raw: any): Partial<AIResult> {
  const out: Partial<AIResult> = {};
  if (shortId(raw?.model)) out.model = raw.model;
  if (ROUTES.includes(raw?.route)) out.route = raw.route;
  if (typeof raw?.routeReason === 'string') out.routeReason = raw.routeReason.slice(0, 300);
  if (raw?.usage && typeof raw.usage === 'object' && !Array.isArray(raw.usage)) out.usage = usageFrom(raw.usage);
  if (isCost(raw?.costUsd)) out.costUsd = raw.costUsd;
  if (Array.isArray(raw?.calls)) {
    const calls: AICall[] = raw.calls
      .filter((c: any) => c && typeof c === 'object' && shortId(c.model))
      .slice(0, 4)
      .map((c: any) => ({ model: c.model, usage: usageFrom(c.usage), ...(isCost(c.costUsd) ? { costUsd: c.costUsd } : {}) }));
    if (calls.length) out.calls = calls;
  }
  return out;
}

/** Coerce whatever a model or service returned into a safe AIResult. */
export function normalize(raw: any, provider: string, input: AIInput): AIResult {
  const intent: Intent = INTENTS.includes(raw?.intent) && input.allowedIntents.includes(raw.intent) ? raw.intent : 'general';
  return {
    intent,
    confidence: typeof raw?.confidence === 'number' && Number.isFinite(raw.confidence) ? Math.max(0, Math.min(1, raw.confidence)) : 0.5,
    reply: typeof raw?.reply === 'string' ? raw.reply.trim() : '',
    entities: raw?.entities && typeof raw.entities === 'object' ? raw.entities : {},
    handoff: Boolean(raw?.handoff) || intent === 'general' && raw?.intent !== 'general',
    handoffReason: typeof raw?.handoffReason === 'string' ? raw.handoffReason : undefined,
    provider,
    ...metaFrom(raw),
  };
}

/** Only the fields a model writes. A model can't set its own cost, route or usage. */
function modelFields(raw: any) {
  if (!raw || typeof raw !== 'object') return {};
  const { intent, confidence, reply, entities, handoff, handoffReason } = raw;
  return { intent, confidence, reply, entities, handoff, handoffReason };
}

export type AIErrorKind = 'http' | 'timeout' | 'network' | 'refusal' | 'max_tokens' | 'bad_output';

/** A failed model call. `calls` holds anything that was billed before it failed (a refusal can be). */
export class AIError extends Error {
  kind: AIErrorKind;
  status?: number;
  calls: AICall[];
  constructor(kind: AIErrorKind, message: string, opts: { status?: number; calls?: AICall[] } = {}) {
    super(message);
    this.name = 'AIError';
    this.kind = kind;
    this.status = opts.status;
    this.calls = opts.calls ?? [];
  }
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function postJson(url: string, headers: Record<string, string>, body: unknown, timeoutMs: number): Promise<any> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: ctl.signal });
    const text = await res.text();
    if (!res.ok) throw new AIError('http', `${url} → ${res.status}: ${text.slice(0, 300)}`, { status: res.status });
    try {
      return JSON.parse(text);
    } catch {
      throw new AIError('bad_output', `${url} → ${res.status}: not JSON`);
    }
  } catch (e) {
    if (e instanceof AIError) throw e;
    if (ctl.signal.aborted) throw new AIError('timeout', `${url} timed out after ${timeoutMs} ms`);
    throw new AIError('network', `${url}: ${errText(e)}`);
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------- Claude ---------------- */

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
/** Beta header for `fallbacks: "default"` (the scalar form; the array form uses a different header). */
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

const baseId = (m: string) => m.replace(/^anthropic\./, '').replace(/-\d{8}$/, '');
/** Models that take output_config.effort (Claude Haiku 4.5 and older reject it). */
export const supportsEffort = (m: string) => /^claude-(haiku-5-5|sonnet-5(-5)?|sonnet-4-6|opus-5(-5)?|opus-4-[678]|fable-5(-1)?|mythos-5(-1)?)$/.test(baseId(m));
/** Models with structured outputs (output_config.format), per Anthropic's list. */
export const supportsStructuredOutput = (m: string) => /^claude-(haiku-5-5|haiku-4-5|sonnet-5(-5)?|opus-5(-5)?|opus-4-[158]|fable-5(-1)?|mythos-5(-1)?)$/.test(baseId(m));
/**
 * Models that accept `fallbacks: "default"`: if a safety check declines a message, the API
 * retries it on another model in the same call. Claude Haiku 5.5 has no server-side
 * fallback (a fallbacks list is a 400 there), so it never gets the parameter.
 */
export const hasServerFallback = (m: string) => /^claude-(sonnet-5-5|opus-5(-5)?|fable-5-1)$/.test(m);

type Feature = 'effort' | 'format' | 'fallbacks';

export interface ClaudeAnswer {
  raw: ReturnType<typeof modelFields>;
  call: AICall;
  ms: number;
}

/**
 * One Claude model through Anthropic's Messages API (raw fetch, no SDK).
 *  - The system prompt is one cached block, byte-identical for every message.
 *  - output_config.format asks for JSON in AIResult's shape (parseJson stays as a fallback).
 *  - output_config.effort keeps thinking short (thinking can't be turned off on the
 *    current models, and we never send `thinking` or sampling parameters).
 *  - Usage and cost come back with every answer.
 */
export class AnthropicAI implements CommunicationAI {
  name = 'anthropic';
  readonly model: string;
  readonly effort: Effort;
  private apiKey: string;
  private timeoutMs: number;
  private maxTokens: number;
  private url: string;
  /** Request features the API rejected once; left out from then on. */
  private off = new Set<Feature>();
  log?: (line: string) => void;

  constructor(opts: { apiKey: string; model: string; effort?: Effort; timeoutMs?: number; maxTokens?: number; url?: string; log?: (line: string) => void }) {
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.effort = opts.effort ?? 'low';
    this.timeoutMs = opts.timeoutMs ?? 25_000;
    // Thinking counts toward max_tokens; replies are a few hundred tokens. A backstop, not a target.
    this.maxTokens = opts.maxTokens ?? 4000;
    this.url = opts.url ?? ANTHROPIC_URL;
    this.log = opts.log;
  }

  uses(f: Feature): boolean {
    if (this.off.has(f)) return false;
    return f === 'effort' ? supportsEffort(this.model) : f === 'format' ? supportsStructuredOutput(this.model) : hasServerFallback(this.model);
  }

  /** The exact request body. Nothing in `system` (or the schema) changes between messages. */
  requestBody(input: AIInput): Record<string, unknown> {
    const output: Record<string, unknown> = {};
    if (this.uses('effort')) output.effort = this.effort;
    if (this.uses('format')) output.format = { type: 'json_schema', schema: RESULT_SCHEMA };
    return {
      model: this.model,
      max_tokens: this.maxTokens,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userPrompt(input) }],
      ...(Object.keys(output).length ? { output_config: output } : {}),
      ...(this.uses('fallbacks') ? { fallbacks: 'default' } : {}),
    };
  }

  requestHeaders(): Record<string, string> {
    return { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01', ...(this.uses('fallbacks') ? { 'anthropic-beta': FALLBACK_BETA } : {}) };
  }

  /** Which of our optional request features a 400 complains about, if any. */
  private rejected(message: string): Feature | undefined {
    const m = message.toLowerCase();
    if (this.uses('format') && /output_config\.format|json_schema|schema|\bformat\b/.test(m)) return 'format';
    if (this.uses('fallbacks') && /fallback/.test(m)) return 'fallbacks';
    if (this.uses('effort') && /effort/.test(m)) return 'effort';
    return undefined;
  }

  /** One call. Throws AIError on any failure, with the billed call attached when there was one. */
  async ask(input: AIInput, timeoutMs = this.timeoutMs): Promise<ClaudeAnswer> {
    const t0 = Date.now();
    let data: any;
    try {
      data = await postJson(this.url, this.requestHeaders(), this.requestBody(input), timeoutMs);
    } catch (e) {
      // A 400 that names one of our optional features: drop it for good and retry once,
      // so a change on Anthropic's side can't turn every message into a rules fallback.
      const f = e instanceof AIError && e.status === 400 ? this.rejected(e.message) : undefined;
      if (!f) throw e;
      this.off.add(f);
      this.log?.(`[ai] ${this.model} rejected ${f}; sending without it from now on (${errText(e).slice(0, 200)})`);
      data = await postJson(this.url, this.requestHeaders(), this.requestBody(input), Math.max(1000, timeoutMs - (Date.now() - t0)));
    }
    const call = callFromResponse(this.model, data);
    // A safety decline is a normal 200: check it before reading content.
    if (data?.stop_reason === 'refusal') throw new AIError('refusal', `${call.model} declined the message (${data?.stop_details?.category ?? 'no category'})`, { calls: [call] });
    // Read blocks by type: a response can start with thinking blocks.
    const text = (Array.isArray(data?.content) ? data.content : []).filter((c: any) => c?.type === 'text' && typeof c.text === 'string').map((c: any) => c.text).join('');
    let raw: any;
    try {
      raw = parseJson(text);
    } catch {
      throw new AIError(data?.stop_reason === 'max_tokens' ? 'max_tokens' : 'bad_output', `${call.model} gave no usable JSON (stop: ${data?.stop_reason ?? 'unknown'})`, { calls: [call] });
    }
    return { raw: modelFields(raw), call, ms: Date.now() - t0 };
  }

  async respond(input: AIInput): Promise<AIResult> {
    const a = await this.ask(input);
    return withCalls(normalize(a.raw, `anthropic:${a.call.model}`, input), { calls: [a.call], model: a.call.model });
  }
}

function withCalls(r: AIResult, o: { calls: AICall[]; model: string; route?: AIResult['route']; routeReason?: string }): AIResult {
  const { usage, costUsd } = sumCalls(o.calls);
  return { ...r, model: o.model, ...(o.route ? { route: o.route } : {}), ...(o.routeReason ? { routeReason: o.routeReason } : {}), usage, ...(costUsd !== undefined ? { costUsd } : {}), calls: o.calls };
}

/** Escalating needs at least this much of the time budget left. */
const MIN_ESCALATION_MS = 4000;

/**
 * Claude with two models: the routine one (Haiku 5.5) for everyday messages, the complex
 * one (Sonnet 5.5) for repair conversations, vendor amounts and long messages. A routine
 * answer about a repair or an emergency, or one the model isn't sure of, is asked again
 * once on the complex model. The whole thing stays under `budgetMs` so the main app's
 * 30-second timeout never fires first.
 */
export class ClaudeRouter implements CommunicationAI {
  name = 'anthropic';
  readonly routine: AnthropicAI;
  readonly complex: AnthropicAI;
  private routineTimeoutMs: number;
  private complexTimeoutMs: number;
  private budgetMs: number;
  private escalateBelow: number;
  log?: (line: string) => void;

  constructor(opts: {
    apiKey: string; routineModel: string; complexModel: string; effortRoutine?: Effort; effortComplex?: Effort;
    routineTimeoutMs?: number; complexTimeoutMs?: number; budgetMs?: number; escalateBelow?: number; url?: string; log?: (line: string) => void;
  }) {
    this.log = opts.log;
    const log = (l: string) => this.log?.(l);
    this.routine = new AnthropicAI({ apiKey: opts.apiKey, model: opts.routineModel, effort: opts.effortRoutine, url: opts.url, log });
    this.complex = new AnthropicAI({ apiKey: opts.apiKey, model: opts.complexModel, effort: opts.effortComplex, url: opts.url, log });
    this.routineTimeoutMs = opts.routineTimeoutMs ?? 12_000;
    this.complexTimeoutMs = opts.complexTimeoutMs ?? 20_000;
    this.budgetMs = opts.budgetMs ?? 26_000;
    this.escalateBelow = opts.escalateBelow ?? ESCALATE_BELOW;
  }

  describe(): string {
    return `routine ${this.routine.model} (effort ${this.routine.effort}), complex ${this.complex.model} (effort ${this.complex.effort})`;
  }

  async respond(input: AIInput): Promise<AIResult> {
    const t0 = Date.now();
    const pick = chooseRoute(input);
    const first = pick.route === 'complex' ? this.complex : this.routine;
    // A failure here throws (with any billed call attached) and the caller falls back to rules.
    const a = await first.ask(input, pick.route === 'complex' ? this.complexTimeoutMs : this.routineTimeoutMs);
    const calls = [a.call];
    let result = normalize(a.raw, `anthropic:${a.call.model}`, input);
    let model = a.call.model;
    let route: AIResult['route'] = pick.route;
    let reason = pick.reason;

    const why = pick.route === 'routine' && this.complex.model !== this.routine.model ? escalationReason(a.raw, result.confidence, input, this.escalateBelow) : undefined;
    if (why) {
      const left = this.budgetMs - (Date.now() - t0);
      if (left < MIN_ESCALATION_MS) reason += `; kept (${why}, no time left to escalate)`;
      else {
        try {
          const b = await this.complex.ask(input, Math.min(this.complexTimeoutMs, left));
          calls.push(b.call);
          result = normalize(b.raw, `anthropic:${b.call.model}`, input);
          model = b.call.model;
          route = 'escalated';
          reason = `escalated: ${why}`;
        } catch (e) {
          // Keep the routine answer; it still goes through the guardrails.
          if (e instanceof AIError) calls.push(...e.calls);
          reason += `; escalation (${why}) failed: ${errText(e).slice(0, 120)}`;
        }
      }
    }
    const out = withCalls(result, { calls, model, route, routeReason: reason });
    this.log?.(summaryLine(input, out, Date.now() - t0));
    return out;
  }
}

/** One log line per message: who answered, why, what it cost. */
export function summaryLine(input: AIInput, r: AIResult, ms: number): string {
  const u = r.usage;
  const cache = u ? ` · cache read ${u.cache_read_input_tokens}/${promptTokens(u)} prompt tokens` : '';
  const cost = r.costUsd !== undefined ? `$${r.costUsd.toFixed(5)}` : 'cost unknown';
  return `[ai] ${input.senderRole} → ${r.intent} (${r.confidence.toFixed(2)}) by ${r.model ?? r.provider} [${r.route ?? 'single'}: ${r.routeReason ?? '-'}] · ${r.calls?.length ?? 0} call(s) · ${cost}${cache} · ${ms} ms`;
}

/** Claude from Railway Variables: ANTHROPIC_API_KEY plus the optional AI_MODEL_* / AI_EFFORT_* settings. */
export function claudeFromEnv(env: Record<string, string | undefined>, log: ((line: string) => void) | undefined = (l) => console.log(l)): ClaudeRouter | undefined {
  if (!env.ANTHROPIC_API_KEY) return undefined;
  const cfg = modelConfig(env);
  for (const w of cfg.warnings) log?.(`[ai] ${w}`);
  return new ClaudeRouter({ apiKey: env.ANTHROPIC_API_KEY, routineModel: cfg.routine, complexModel: cfg.complex, effortRoutine: cfg.effortRoutine, effortComplex: cfg.effortComplex, log });
}

/**
 * Any OpenAI-compatible chat endpoint: a self-hosted open model (vLLM, Ollama,
 * TGI on a GPU host) or a hosted one. Lets the in-house service run on a model
 * you control.
 */
export class OpenAICompatAI implements CommunicationAI {
  name = 'openai-compat';
  private url: string;
  private key?: string;
  private model: string;
  private timeoutMs: number;
  constructor(opts: { baseUrl: string; model: string; apiKey?: string; timeoutMs?: number }) {
    this.url = opts.baseUrl.replace(/\/$/, '') + '/chat/completions';
    this.key = opts.apiKey;
    this.model = opts.model;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
  }
  async respond(input: AIInput): Promise<AIResult> {
    const data = await postJson(
      this.url,
      this.key ? { authorization: `Bearer ${this.key}` } : {},
      { model: this.model, temperature: 0.2, max_tokens: 600, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: systemPrompt(input) }, { role: 'user', content: userPrompt(input) }] },
      this.timeoutMs,
    );
    return normalize(modelFields(parseJson(data.choices?.[0]?.message?.content ?? '')), `openai-compat:${this.model}`, input);
  }
}

/**
 * Your own AI service (in-house model, a voice-agent vendor, anything).
 * KeyHelm POSTs the AIInput JSON and expects an AIResult JSON back.
 * Contract: docs/AI-PLUGIN.md
 */
export class HttpAI implements CommunicationAI {
  name = 'http';
  private url: string;
  private token?: string;
  private timeoutMs: number;
  constructor(opts: { url: string; token?: string; timeoutMs?: number }) {
    this.url = opts.url;
    this.token = opts.token;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }
  async respond(input: AIInput): Promise<AIResult> {
    const data = await postJson(this.url, this.token ? { authorization: `Bearer ${this.token}` } : {}, input, this.timeoutMs);
    return normalize(data, `http:${new URL(this.url).host}`, input);
  }
}

/** Wraps any provider: if it errors or times out, the rule-based AI answers instead. */
export class ResilientAI implements CommunicationAI {
  name: string;
  private primary: CommunicationAI;
  private fallback = new RuleBasedAI();
  onError?: (err: unknown) => void;
  constructor(primary: CommunicationAI) {
    this.primary = primary;
    this.name = primary instanceof RuleBasedAI ? 'rules' : `${primary.name} (rules fallback)`;
  }
  async respond(input: AIInput): Promise<AIResult> {
    if (this.primary instanceof RuleBasedAI) return this.primary.respond(input);
    try {
      return await this.primary.respond(input);
    } catch (err) {
      this.onError?.(err);
      const r = await this.fallback.respond(input);
      return { ...r, provider: `rules(fallback from ${this.primary.name})` };
    }
  }
}

/**
 * Spending guard for any paid model. Caps model calls per owner per day and for the
 * whole service per day, and trims very long messages before they reach the model.
 * Over a cap it throws, so ResilientAI answers with the free rule-based AI instead:
 * tenants still get a reply, and nobody can run up the AI bill by flooding messages.
 */
export class BudgetAI implements CommunicationAI {
  name: string;
  private inner: CommunicationAI;
  private perOwner: number;
  private total: number;
  private day = '';
  private counts = new Map<string, number>();
  private all = 0;
  onLimit?: (what: string) => void;
  constructor(inner: CommunicationAI, opts: { perOwnerPerDay: number; totalPerDay: number }) {
    this.inner = inner;
    this.name = inner.name;
    this.perOwner = opts.perOwnerPerDay;
    this.total = opts.totalPerDay;
  }
  async respond(input: AIInput): Promise<AIResult> {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.day) { this.day = today; this.counts.clear(); this.all = 0; }
    const key = input.ownerId ?? 'none';
    const used = this.counts.get(key) ?? 0;
    if (this.all >= this.total) { if (this.all === this.total) this.onLimit?.(`service-wide daily AI limit (${this.total}) reached`); this.all++; throw new Error('AI daily limit reached'); }
    if (used >= this.perOwner) { if (used === this.perOwner) this.onLimit?.(`owner ${key} reached the daily AI limit (${this.perOwner})`); this.counts.set(key, used + 1); throw new Error('owner AI daily limit reached'); }
    this.counts.set(key, used + 1);
    this.all++;
    return this.inner.respond(trimInput(input));
  }
}

/** Long messages cost more and are rarely needed in full: keep the first part of each. */
export function trimInput(input: AIInput): AIInput {
  const cut = (t: string, max: number) => (t.length > max ? t.slice(0, max) + ' [trimmed]' : t);
  return { ...input, message: cut(input.message, 1500), history: input.history.slice(-8).map((h) => ({ ...h, body: cut(h.body, 600) })) };
}
