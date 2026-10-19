// KEYHELM AI: the in-house communication AI service.
//
// A separate service (its own Railway service, same codebase) that the main app
// calls through AI_PROVIDER=http. It owns everything that makes the AI "ours":
//   - the prompt and house style (src/ai/prompt.ts)
//   - which model runs underneath (Claude today; a self-hosted open model later)
//   - its own guardrail pass on every draft (defense in depth)
//   - a log of every exchange for review, evaluation and future fine-tuning
//   - a model fallback chain: primary model → backup model → rule-based
//
// Endpoints
//   POST /respond   AIInput  → AIResult   (contract: docs/AI-PLUGIN.md)
//   GET  /health
//   GET  /stats     counts by intent/provider, handoff rate, average latency
//
// Env
//   AI_SERVICE_TOKEN          required bearer token (main app sends it as AI_HTTP_TOKEN)
//   AI_MODEL_PRIMARY          anthropic | openai-compat | rules   (default anthropic)
//   AI_MODEL_BACKUP           same choices, optional
//   ANTHROPIC_API_KEY, ANTHROPIC_MODEL
//   OPENAI_COMPAT_URL, OPENAI_COMPAT_MODEL, OPENAI_COMPAT_KEY
//   AI_LOG_DIR                where exchange logs go (default ./data/ai-logs; use a Railway volume)
//   AI_LOG_RETENTION_DAYS     default 90

import { createServer } from 'node:http';
import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { AIInput, AIResult, CommunicationAI } from '../ai/types.ts';
import { AnthropicAI, BudgetAI, OpenAICompatAI, normalize } from '../ai/providers.ts';
import { RateLimiter, safeEqual, tooMany } from '../api/guard.ts';
import { RuleBasedAI } from '../ai/rules.ts';
import { postcheck, precheck, SAFE_REPLY } from '../ai/guardrails.ts';

export function modelFrom(kind: string | undefined, env: Record<string, string | undefined>): CommunicationAI | undefined {
  if (kind === 'anthropic' && env.ANTHROPIC_API_KEY && env.ANTHROPIC_MODEL) return new AnthropicAI({ apiKey: env.ANTHROPIC_API_KEY, model: env.ANTHROPIC_MODEL });
  if (kind === 'openai-compat' && env.OPENAI_COMPAT_URL && env.OPENAI_COMPAT_MODEL) return new OpenAICompatAI({ baseUrl: env.OPENAI_COMPAT_URL, model: env.OPENAI_COMPAT_MODEL, apiKey: env.OPENAI_COMPAT_KEY });
  if (kind === 'rules') return new RuleBasedAI();
  return undefined;
}

export class KeyHelmAI {
  private chain: CommunicationAI[];
  private logDir?: string;
  stats = { requests: 0, errors: 0, handoffs: 0, blocked: 0, totalMs: 0, byIntent: {} as Record<string, number>, byProvider: {} as Record<string, number> };

  constructor(opts: { chain: CommunicationAI[]; logDir?: string }) {
    this.chain = [...opts.chain.filter(Boolean), new RuleBasedAI()];
    this.logDir = opts.logDir;
    if (this.logDir) mkdirSync(this.logDir, { recursive: true });
  }

  async respond(input: AIInput): Promise<AIResult> {
    const t0 = Date.now();
    this.stats.requests++;
    let result: AIResult | undefined;
    const errors: string[] = [];

    // Guardrails run here too, so a misconfigured caller can't skip them.
    const pre = input.senderRole === 'vendor' ? { route: false, emergency: false } : precheck(input.message);
    if (pre.emergency || pre.route) {
      const intent = pre.intent ?? 'general';
      result = { intent, confidence: 1, reply: SAFE_REPLY[intent] ?? "Thanks, I've passed this to the owner.", entities: {}, handoff: pre.route, handoffReason: pre.reason, provider: 'guardrails' };
    }

    for (const model of this.chain) {
      if (result) break;
      try {
        const r = await model.respond(input);
        result = normalize(r, r.provider ?? model.name, input);
      } catch (e) {
        this.stats.errors++;
        errors.push(`${model.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    result ??= { intent: 'general', confidence: 0, reply: "Thanks for your message! I've passed it along.", entities: {}, handoff: true, handoffReason: 'All models failed', provider: 'none' };

    const check = postcheck(result.reply, input.facts);
    if (!check.ok) {
      this.stats.blocked++;
      result = { ...result, reply: "Thanks for your message! I've passed it to the owner, who will follow up shortly.", handoff: true, handoffReason: `Draft blocked: ${check.problems.join('; ')}` };
    }
    const ms = Date.now() - t0;
    this.stats.totalMs += ms;
    if (result.handoff) this.stats.handoffs++;
    this.stats.byIntent[result.intent] = (this.stats.byIntent[result.intent] ?? 0) + 1;
    this.stats.byProvider[result.provider] = (this.stats.byProvider[result.provider] ?? 0) + 1;
    this.log({ at: new Date().toISOString(), ms, input: { ...input, facts: input.facts.length }, result, errors, blocked: check.ok ? undefined : check.problems });
    return result;
  }

  private log(entry: unknown) {
    if (!this.logDir) return;
    const day = new Date().toISOString().slice(0, 10);
    appendFileSync(join(this.logDir, `${day}.jsonl`), JSON.stringify(entry) + '\n');
  }

  prune(retentionDays: number) {
    if (!this.logDir) return;
    const cutoff = Date.now() - retentionDays * 86_400_000;
    for (const f of readdirSync(this.logDir)) if (f.endsWith('.jsonl') && statSync(join(this.logDir, f)).mtimeMs < cutoff) unlinkSync(join(this.logDir, f));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const env = process.env;
  const token = env.AI_SERVICE_TOKEN;
  if (!token) { console.error('Set AI_SERVICE_TOKEN'); process.exit(1); }
  const ai = new KeyHelmAI({
    // Each paid model gets its own daily cap (a second line of defense behind the api service's caps).
    chain: [modelFrom(env.AI_MODEL_PRIMARY ?? 'anthropic', env), modelFrom(env.AI_MODEL_BACKUP, env)]
      .filter((x): x is CommunicationAI => !!x)
      .map((m) => { const b = new BudgetAI(m, { perOwnerPerDay: Number(env.AI_OWNER_DAILY_MAX) || 400, totalPerDay: Number(env.AI_DAILY_MAX) || 20_000 }); b.onLimit = (w) => console.error(`[ai] ${w}`); return b; }),
    logDir: env.AI_LOG_DIR ?? './data/ai-logs',
  });
  const retention = Number(env.AI_LOG_RETENTION_DAYS ?? 90);
  ai.prune(retention);
  setInterval(() => ai.prune(retention), 86_400_000);

  // Burst guard: at most AI_PER_MIN model requests a minute across the whole service.
  const perMin = new RateLimiter({ capacity: Number(env.AI_PER_MIN) || 600, perMs: 60_000 });
  const server = createServer(async (req, res) => {
    const send = (code: number, data: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (req.url === '/health') return send(200, { ok: true });
    if (!safeEqual(String(req.headers.authorization ?? ''), `Bearer ${token}`)) return send(401, { error: 'unauthorized' });
    if (req.method === 'GET' && req.url === '/stats') return send(200, { ...ai.stats, avgMs: ai.stats.requests ? Math.round(ai.stats.totalMs / ai.stats.requests) : 0 });
    if (req.method !== 'POST' || req.url !== '/respond') return send(404, { error: 'not found' });
    try {
      const wait = perMin.take('all');
      if (wait) return tooMany(res, wait, 'AI service busy');
      let raw = '';
      for await (const c of req) { raw += c; if (raw.length > 200_000) return send(413, { error: 'too large' }); }
      const input = JSON.parse(raw) as AIInput;
      if (!input?.message || !Array.isArray(input.allowedIntents)) return send(400, { error: 'invalid AIInput' });
      send(200, await ai.respond(input));
    } catch (e) {
      console.error(e);
      send(500, { error: 'server error' });
    }
  });
  server.requestTimeout = 60_000;
  server.headersTimeout = 20_000;
  server.listen(Number(env.PORT ?? 8788), () => console.log(`KeyHelm AI service on :${env.PORT ?? 8788} (models: ${env.AI_MODEL_PRIMARY ?? 'anthropic'}${env.AI_MODEL_BACKUP ? ' → ' + env.AI_MODEL_BACKUP : ''} → rules)`));
  // Railway sends SIGTERM when a new deploy replaces this one; exit cleanly so it isn't marked Crashed.
  const stop = () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5_000).unref(); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
