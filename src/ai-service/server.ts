// KEYHELM AI: the in-house communication AI service.
//
// A separate service (its own Railway service, same codebase) that the main app
// calls through AI_PROVIDER=http. It owns everything that makes the AI "ours":
//   - the prompt and house style (src/ai/prompt.ts)
//   - which model runs underneath (Claude today; a self-hosted open model later)
//   - model routing: Claude Haiku 5.5 for everyday messages, a stronger Claude model
//     for repair conversations (src/ai/route.ts, docs/notes/ai-cost.md)
//   - its own guardrail pass on every draft (defense in depth)
//   - a log of every exchange for review, evaluation and future fine-tuning
//   - a model fallback chain: primary model → backup model → rule-based
//   - what every message cost (tokens, cache hits, dollars) in the log and /stats
//
// Endpoints
//   POST /respond   AIInput  → AIResult   (contract: docs/AI-PLUGIN.md)
//   GET  /health   { ok, commit }, no token needed
//   GET  /stats     counts by intent/provider, handoff rate, average latency, AI spend
//
// Env
//   AI_SERVICE_TOKEN          required bearer token (main app sends it as AI_HTTP_TOKEN)
//   AI_MODEL_PRIMARY          anthropic | openai-compat | rules   (default anthropic)
//   AI_MODEL_BACKUP           same choices, optional
//   ANTHROPIC_API_KEY         Claude; the model settings below are optional
//   AI_MODEL_ROUTINE          default claude-haiku-5-5
//   AI_MODEL_COMPLEX          default ANTHROPIC_MODEL, else claude-sonnet-5-5
//   AI_EFFORT_ROUTINE, AI_EFFORT_COMPLEX   low (default) | medium | high | xhigh | max
//   OPENAI_COMPAT_URL, OPENAI_COMPAT_MODEL, OPENAI_COMPAT_KEY
//   AI_LOG_DIR                where exchange logs go (default ./data/ai-logs; use a Railway volume)
//   AI_LOG_RETENTION_DAYS     default 90

import { createServer, type Server } from 'node:http';
import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { AICall, AIInput, AIResult, CommunicationAI } from '../ai/types.ts';
import { AIError, BudgetAI, ClaudeRouter, OpenAICompatAI, claudeFromEnv, normalize, warmUpClaude } from '../ai/providers.ts';
import { CostMeter, sumCalls } from '../ai/cost.ts';
import { RateLimiter, safeEqual, tooMany } from '../api/guard.ts';
import { RuleBasedAI } from '../ai/rules.ts';
import { postcheck, precheck, SAFE_REPLY } from '../ai/guardrails.ts';

export function modelFrom(kind: string | undefined, env: Record<string, string | undefined>, log?: (line: string) => void): CommunicationAI | undefined {
  if (kind === 'anthropic') return claudeFromEnv(env, log);
  if (kind === 'openai-compat' && env.OPENAI_COMPAT_URL && env.OPENAI_COMPAT_MODEL) return new OpenAICompatAI({ baseUrl: env.OPENAI_COMPAT_URL, model: env.OPENAI_COMPAT_MODEL, apiKey: env.OPENAI_COMPAT_KEY });
  if (kind === 'rules') return new RuleBasedAI();
  return undefined;
}

export class KeyHelmAI {
  private chain: CommunicationAI[];
  private logDir?: string;
  private log?: (line: string) => void;
  stats = { requests: 0, errors: 0, handoffs: 0, blocked: 0, totalMs: 0, byIntent: {} as Record<string, number>, byProvider: {} as Record<string, number> };
  /** Model calls and spend since the service started. */
  meter = new CostMeter();

  constructor(opts: { chain: CommunicationAI[]; logDir?: string; log?: (line: string) => void }) {
    this.chain = [...opts.chain.filter(Boolean), new RuleBasedAI()];
    this.logDir = opts.logDir;
    this.log = opts.log;
    if (this.logDir) mkdirSync(this.logDir, { recursive: true });
  }

  async respond(input: AIInput): Promise<AIResult> {
    const t0 = Date.now();
    this.stats.requests++;
    let result: AIResult | undefined;
    const errors: string[] = [];
    const failedCalls: AICall[] = [];

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
        // A declined message can still be billed: keep its cost.
        if (e instanceof AIError) failedCalls.push(...e.calls);
        errors.push(`${model.name}: ${e instanceof Error ? e.message : String(e)}`);
        this.log?.(`[ai] ${model.name} failed, trying the next one: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`);
      }
    }
    result ??= { intent: 'general', confidence: 0, reply: "Thanks for your message! I've passed it along.", entities: {}, handoff: true, handoffReason: 'All models failed', provider: 'none' };

    const check = postcheck(result.reply, input.facts);
    if (!check.ok) {
      this.stats.blocked++;
      result = { ...result, reply: "Thanks for your message! I've passed it to the owner, who will follow up shortly.", handoff: true, handoffReason: `Draft blocked: ${check.problems.join('; ')}` };
    }
    const calls = [...failedCalls, ...(result.calls ?? [])];
    this.meter.record(calls, result.route ?? (calls.length ? 'failed' : undefined));
    const ms = Date.now() - t0;
    this.stats.totalMs += ms;
    if (result.handoff) this.stats.handoffs++;
    this.stats.byIntent[result.intent] = (this.stats.byIntent[result.intent] ?? 0) + 1;
    this.stats.byProvider[result.provider] = (this.stats.byProvider[result.provider] ?? 0) + 1;
    const spent = sumCalls(calls).costUsd;
    this.writeLog({ at: new Date().toISOString(), ms, input: { ...input, facts: input.facts.length }, result, errors, blocked: check.ok ? undefined : check.problems, costUsd: calls.length ? spent ?? null : 0, failedCalls: failedCalls.length ? failedCalls : undefined });
    return result;
  }

  /** What GET /stats returns. */
  statsSnapshot() {
    return { ...this.stats, avgMs: this.stats.requests ? Math.round(this.stats.totalMs / this.stats.requests) : 0, cost: this.meter.snapshot(this.stats.requests) };
  }

  private writeLog(entry: unknown) {
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

/** One plain line for the Railway logs (search "[ai] cost so far"). */
export function costSummaryLine(s: ReturnType<KeyHelmAI['statsSnapshot']>): string {
  const c = s.cost;
  const cents = (usd: number) => `${(usd * 100).toFixed(3)}¢`;
  const routes = Object.entries(c.byRoute).map(([k, r]) => `${k} ${r.messages} at ${cents(r.avgCostPerMessageUsd)}`).join(', ');
  return `[ai] cost so far: ${s.requests} messages, ${c.modelMessages} used a model, $${c.totalUsd.toFixed(4)} total, ${cents(c.avgCostPerMessageUsd)} per message (${routes || 'no model calls yet'}), cache hits ${Math.round(c.cacheHitRate * 100)}% of calls`;
}

/** The HTTP side of the service. Every route but /health needs the bearer token. */
export function aiServer(ai: KeyHelmAI, opts: { token: string; perMin?: number; warming?: () => boolean }): Server {
  // Burst guard: at most AI_PER_MIN model requests a minute across the whole service.
  const perMin = new RateLimiter({ capacity: opts.perMin || 600, perMs: 60_000 });
  const server = createServer(async (req, res) => {
    const send = (code: number, data: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    // Which commit is live (Railway sets this), so the Live check can wait for this service after a deploy.
    // While warming up it reports unhealthy, so Railway and the Live check wait for it (at most warmUpClaude's maxMs).
    if (req.url === '/health' && opts.warming?.()) return send(503, { ok: false, warming: true });
    if (req.url === '/health') return send(200, { ok: true, commit: (process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.GIT_COMMIT ?? 'unknown').slice(0, 7) });
    if (!safeEqual(String(req.headers.authorization ?? ''), `Bearer ${opts.token}`)) return send(401, { error: 'unauthorized' });
    if (req.method === 'GET' && req.url === '/stats') return send(200, ai.statsSnapshot());
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
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const env = process.env;
  const token = env.AI_SERVICE_TOKEN;
  if (!token) { console.error('Set AI_SERVICE_TOKEN'); process.exit(1); }
  const log = (line: string) => console.log(line);
  const models = [modelFrom(env.AI_MODEL_PRIMARY ?? 'anthropic', env, log), modelFrom(env.AI_MODEL_BACKUP, env, log)].filter((x): x is CommunicationAI => !!x);
  const ai = new KeyHelmAI({
    // Each paid model gets its own daily cap (a second line of defense behind the api service's caps).
    chain: models.map((m) => { const b = new BudgetAI(m, { perOwnerPerDay: Number(env.AI_OWNER_DAILY_MAX) || 400, totalPerDay: Number(env.AI_DAILY_MAX) || 20_000 }); b.onLimit = (w) => console.error(`[ai] ${w}`); return b; }),
    logDir: env.AI_LOG_DIR ?? './data/ai-logs',
    log,
  });
  const retention = Number(env.AI_LOG_RETENTION_DAYS ?? 90);
  ai.prune(retention);
  setInterval(() => ai.prune(retention), 86_400_000);
  // Once an hour, if anything came in, one line with the running cost per message.
  let reported = 0;
  setInterval(() => { if (ai.stats.requests > reported) { reported = ai.stats.requests; log(costSummaryLine(ai.statsSnapshot())); } }, 3_600_000).unref();

  let warming = models.some((m) => m instanceof ClaudeRouter);
  if (warming) void warmUpClaude({ log }).finally(() => { warming = false; });
  const server = aiServer(ai, { token, perMin: Number(env.AI_PER_MIN) || 600, warming: () => warming });
  const names = models.map((m) => (m instanceof ClaudeRouter ? `claude: ${m.describe()}` : m.name));
  server.listen(Number(env.PORT ?? 8788), () => console.log(`KeyHelm AI service on :${env.PORT ?? 8788} (models: ${[...names, 'rules'].join(' → ')})`));
  // Railway sends SIGTERM when a new deploy replaces this one; exit cleanly so it isn't marked Crashed.
  const stop = () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5_000).unref(); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
