import type { AIInput, AIResult, CommunicationAI, Intent } from './types.ts';
import { parseJson, systemPrompt, userPrompt } from './prompt.ts';
import { RuleBasedAI } from './rules.ts';

const INTENTS: Intent[] = ['emergency', 'maintenance_request', 'maintenance_update', 'rent_question', 'showing_request', 'listing_question', 'application_question', 'lease_question', 'renewal_response', 'move_out_notice', 'vendor_update', 'accommodation_request', 'fair_housing_sensitive', 'screening_decision_question', 'complaint_or_legal', 'general'];

/** Coerce whatever a model or service returned into a safe AIResult. */
export function normalize(raw: any, provider: string, input: AIInput): AIResult {
  const intent: Intent = INTENTS.includes(raw?.intent) && input.allowedIntents.includes(raw.intent) ? raw.intent : 'general';
  return {
    intent,
    confidence: typeof raw?.confidence === 'number' ? Math.max(0, Math.min(1, raw.confidence)) : 0.5,
    reply: typeof raw?.reply === 'string' ? raw.reply.trim() : '',
    entities: raw?.entities && typeof raw.entities === 'object' ? raw.entities : {},
    handoff: Boolean(raw?.handoff) || intent === 'general' && raw?.intent !== 'general',
    handoffReason: typeof raw?.handoffReason === 'string' ? raw.handoffReason : undefined,
    provider,
  };
}

async function postJson(url: string, headers: Record<string, string>, body: unknown, timeoutMs: number): Promise<any> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: ctl.signal });
    const text = await res.text();
    if (!res.ok) throw new Error(`${url} → ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

/** Claude through Anthropic's Messages API. */
export class AnthropicAI implements CommunicationAI {
  name = 'anthropic';
  private apiKey: string;
  private model: string;
  private timeoutMs: number;
  constructor(opts: { apiKey: string; model: string; timeoutMs?: number }) {
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }
  async respond(input: AIInput): Promise<AIResult> {
    const data = await postJson(
      'https://api.anthropic.com/v1/messages',
      { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' },
      { model: this.model, max_tokens: 600, system: systemPrompt(input), messages: [{ role: 'user', content: userPrompt(input) }] },
      this.timeoutMs,
    );
    const text = (data.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('');
    return normalize(parseJson(text), `anthropic:${this.model}`, input);
  }
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
    return normalize(parseJson(data.choices?.[0]?.message?.content ?? ''), `openai-compat:${this.model}`, input);
  }
}

/**
 * Your own AI service (in-house model, a voice-agent vendor, anything).
 * Landwell POSTs the AIInput JSON and expects an AIResult JSON back.
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
    this.timeoutMs = opts.timeoutMs ?? 15_000;
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
