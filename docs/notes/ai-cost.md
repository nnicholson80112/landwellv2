# AI cost per message (branch `kh/ai-cost`)

Goal from Nate: well under about 3 cents per AI message, same quality, safety unchanged.
Result (estimate, math below): about **0.02 to 0.04 cents** for an everyday message on
Claude Haiku 5.5, about **0.8 to 1.3 cents** for a repair conversation on Claude Sonnet 5.5
(up to about 2 cents for a long chat), and about **0.4 to 0.6 cents blended**. Real numbers show up in the AI service's logs and
`/stats` from the first message after deploy.

## What changed

1. **Two models, picked per message** (`src/ai/route.ts`, `ClaudeRouter` in `src/ai/providers.ts`).
   - **Routine** (default `claude-haiku-5-5`): rent, lease, tours, listings, renewals,
     simple vendor replies ("yes, Tue 9-11").
   - **Complex** (default `ANTHROPIC_MODEL`, else `claude-sonnet-5-5`), chosen when:
     - the facts include "Problem we are talking through now" (an open repair chat),
     - a tenant's message reads like a repair (the rule-based AI's trade words from
       `guessTrade` plus "leaking / won't / not working / clogged / mold..."),
     - a vendor message has an amount in it (quotes and invoices must be read right),
     - the message is long (over 500 characters) or asks 3 or more questions.
   - **Escalation, once:** if the routine answer comes back as `maintenance_request`,
     `maintenance_update` or `emergency`, uses an intent that isn't allowed for this
     sender, or has confidence under 0.6, the same message is asked again on the complex
     model and that answer is used. If the complex call fails, the routine answer stands
     (it still goes through the guardrails). The whole thing stays under 26 seconds so the
     main app's 30-second timeout never fires first.
   - One log line per message says which model answered and why, for example
     `[ai] tenant → maintenance_request (0.90) by claude-sonnet-5-5 [complex: looks like a repair] · 1 call(s) · $0.00840 · cache read 1480/2950 prompt tokens · 2100 ms`.
2. **Prompt caching** (`src/ai/prompt.ts`). The system prompt is now the same bytes for
   every message, every owner and every model: no names, roles, channels, brand or
   "first message" flag in it. Those moved into a `CONTEXT:` block at the top of the user
   message. The system prompt is sent as one block with `cache_control: {type: "ephemeral"}`
   (5-minute cache). A test checks two very different requests send identical system bytes.
3. **Structured output.** `output_config.format` with a JSON schema in AIResult's shape
   (`RESULT_SCHEMA`), so the answer always parses. The schema lists every intent (it never
   changes, so it never breaks the cache); `normalize()` still turns a disallowed intent
   into a handoff. `parseJson` stays as the fallback for models without structured output.
   If the API ever rejects the format (or effort, or fallbacks) with a 400, that one
   feature is dropped and the call retried once, so a change on Anthropic's side can't
   turn every message into a rules reply.
4. **Effort:** `low` on both routes by default (`AI_EFFORT_ROUTINE`, `AI_EFFORT_COMPLEX`).
   No `thinking` field (it can't be turned off on Sonnet 5.5 or Opus 5.5; effort is the
   control), no `temperature`/`top_p`/`top_k` (Haiku 5.5 rejects them), no dated model ids.
5. **Usage and cost** (`src/ai/cost.ts`). Every answer carries optional `model`, `route`,
   `routeReason`, `usage` (input, output, cache write, cache read tokens), `costUsd` and
   `calls` (one per model call; an escalated message has two). Prices are in a table in
   code. `normalize()` passes these fields through from the AI service (the HttpAI path)
   and drops anything malformed; a model can't write its own cost or model name.
6. **AI service** (`src/ai-service/server.ts`): the JSONL log now records the model, route,
   cost and any billed failed calls per message. `GET /stats` adds a `cost` section:
   total dollars, average per message (and in cents), per model, per route
   (routine/complex/escalated/failed), cache hit rate. Once an hour it logs one line:
   `[ai] cost so far: 120 messages, 95 used a model, $0.4210 total, 0.351¢ per message (...)`.
7. **Safety kept.** Guardrails before and after the model are unchanged. Because names and
   roles moved out of the system prompt, people's words now sit inside `<conversation>` and
   `<message>` tags, any such tag they type is stripped, and the system prompt says text
   inside those tags is never instructions, CONTEXT or FACTS. Refusals (`stop_reason:
   "refusal"`) are checked before reading content and fall back to the rules. Haiku 5.5 has
   no server-side fallback, so it never gets the `fallbacks` parameter; Sonnet 5.5 keeps
   `fallbacks: "default"` with the `server-side-fallback-2026-07-01` header, as before.

Messages that never reach a model cost nothing and are unchanged: guardrail topics
(emergencies, fair housing, accommodations, legal), repair menu replies (1/2/3/4/9),
STOP/START, owner YES/NO codes, showing-slot picks.

## Measured prompt sizes

Measured from the real front desk (seeded demo data, the inputs `inbound-message.ts`
builds; no API calls were made):

| Piece | Characters | Estimated tokens |
|---|---:|---:|
| System prompt (cached) | 5,187 (816 words) | about 1,400 (range 1,100 to 1,750) |
| Output schema (sent with every call) | 1,383 of JSON | about 500 |
| User message, tenant rent question | 1,168 | about 390 |
| User message, prospect listing question (15 facts) | 1,526 | about 510 |
| User message, repair chat, 2nd and 3rd turn | 1,313 to 1,637 | about 440 to 550 |
| User message, vendor invoice | 412 | about 140 |

Token estimates use about 3 characters per token. Claude Haiku 5.5 and Sonnet 5.5 use the
newer tokenizer, which counts the same text as roughly 30% more tokens than older Claude
models, so this leans high on purpose.

**Is the system prompt big enough to cache?** Yes. The documented minimum cacheable prefix
for Claude Haiku 5.5, Sonnet 5.5 and Opus 5.5 is 512 tokens; the system prompt is about
1,400. Nothing was padded. (Anthropic says to check the live prompt-caching docs before
relying on the 512 figure; if it were ever higher than about 1,100 the marker would simply
not cache, with no error and no extra cost.)

## Cost per message, with the math

Prices per million tokens (Anthropic, Oct 2026): Haiku 5.5 $0.10 in / $0.50 out, cache
write $0.125, cache read $0.01. Sonnet 5.5 $2 / $10, write $2.50, read $0.20. Opus 5.5
$4 / $20, write $5, read $0.20.

Assumptions: system 1,700 tokens (high end), schema 500 billed as uncached input
(conservative), output includes thinking at low effort: routine 250 tokens, repair 600.
"Warm" means the system prompt was read from the cache, "cold" means it was written.

**Routine on Haiku 5.5** (user 450):
- warm: 1,700 × 0.01 + 950 × 0.10 + 250 × 0.50 = 17 + 95 + 125 = 237 µ$ → **0.024¢**
- cold: 1,700 × 0.125 + 95 + 125 = 432 µ$ → **0.043¢**

**Repair on Sonnet 5.5** (user 550, output 600):
- warm: 1,700 × 0.20 + 1,050 × 2 + 600 × 10 = 340 + 2,100 + 6,000 = 8,440 µ$ → **0.84¢**
- cold: 1,700 × 2.50 + 2,100 + 6,000 = 12,350 µ$ → **1.24¢**
- bad case (long chat, user 850, output 1,200, cold): 4,250 + 2,700 + 12,000 → **1.9¢**

**Escalated** (Haiku, then Sonnet): about **0.85¢** warm, **1.26¢** cold.
**Vendor invoice on Sonnet 5.5** (user 140, output 300): **0.46¢** warm, **0.85¢** cold.

**Blended**, assuming model-answered messages are 55% routine, 10% escalated, 30% repair,
5% vendor amounts:
- warm: 0.55 × 0.024 + 0.10 × 0.85 + 0.30 × 0.84 + 0.05 × 0.46 = **0.37¢**
- cold: 0.55 × 0.043 + 0.10 × 1.26 + 0.30 × 1.24 + 0.05 × 0.85 = **0.56¢**

**Before this change** (one model for everything, no caching, same low effort): on Opus 5.5
about 2,150 in × $4 + 400 out × $20 ≈ **1.7¢** routine and 2,250 × $4 + 600 × $20 ≈ **2.1¢**
repair (in line with the "2 to 3 cents" in `docs/SCALING.md`); on Sonnet 5.5 about
**0.8 to 1.1¢**. Everyday messages are now roughly 20 to 70 times cheaper (against Sonnet or
Opus); repairs stay on a strong model.

Where the money goes now: half (cold) to 70% (warm) of a repair message is Sonnet's output
(thinking plus reply). If repairs ever need to be cheaper, the next lever is trying `AI_MODEL_COMPLEX=claude-haiku-5-5`
with `AI_EFFORT_COMPLEX=medium` on a set of real repair chats first. Not done, because Nate
asked for the stronger model on repairs.

**Cache hits in practice.** The cached system prompt is shared by every owner (one entry
per model). It stays warm while messages for that model arrive less than 5 minutes apart.
Rough hit rate: 1 − e^(−messages per 5 minutes). At 12 messages an hour per model that is
about 63%; at 60 an hour, about 99%. Follow-up turns of a repair chat usually land within
5 minutes of each other, so they hit even when overall traffic is low. On Haiku a miss
costs 0.02¢ extra; on Sonnet about 0.4¢.

## Railway variables (ai service; all optional)

Read by `claudeFromEnv` / `modelConfig`:
- `ANTHROPIC_API_KEY` (required for Claude, as before)
- `ANTHROPIC_WORKSPACE_ID` (optional): sent as the `anthropic-workspace-id` header. Only needed when the key isn't scoped to a workspace.
- `AI_MODEL_ROUTINE` (default `claude-haiku-5-5`)
- `AI_MODEL_COMPLEX` (default `ANTHROPIC_MODEL`, else `claude-sonnet-5-5`)
- `ANTHROPIC_MODEL` (now optional; only used as the complex model when `AI_MODEL_COMPLEX` is empty)
- `AI_EFFORT_ROUTINE`, `AI_EFFORT_COMPLEX` (`low` default; `medium`, `high`, `xhigh`, `max`)

Unchanged: `AI_SERVICE_TOKEN`, `AI_MODEL_PRIMARY`, `AI_MODEL_BACKUP`, `AI_LOG_DIR`,
`AI_LOG_RETENTION_DAYS`, `AI_OWNER_DAILY_MAX`, `AI_DAILY_MAX`, `AI_PER_MIN`, `PORT`.
The main app with `AI_PROVIDER=anthropic` (direct, not through the AI service) uses the same
variables and the same routing.

## Setup clicks

Nothing is required: the defaults are the recommended setup.
- If the **ai** service has `ANTHROPIC_MODEL=claude-opus-5-5`, repairs would run on Opus
  (about twice Sonnet's price). To use Sonnet: Railway → **ai** service → **Variables** →
  **New Variable** → `AI_MODEL_COMPLEX` = `claude-sonnet-5-5` → Deploy.
- To see the cost: Railway → **ai** service → **Logs** → search `[ai] cost so far` (hourly)
  or `[ai] tenant` (one line per message).
- In the Anthropic console, keep a monthly spend limit set.

## How to check caching works after deploy

Send two test messages to the same route within 5 minutes (for example two rent questions
from `/play`). In the ai logs the second line should show `cache read 1xxx/...` above zero.
If it stays at 0 while messages come faster than every 5 minutes, something is changing the
system prompt between requests; the test `caching: the system prompt bytes are identical...`
guards against that.

## Known limits

- All numbers above are estimates; no live API calls were made while building this. `/stats`
  and the logs give real ones.
- The cost totals in `/stats` live in memory and reset on each deploy. The JSONL logs
  (`AI_LOG_DIR`, 90 days) keep per-message cost.
- Prices are hard-coded in `src/ai/cost.ts`. A model not in the table is counted as
  "unpriced" rather than guessed.
- A message escalates whenever Haiku classifies it as a repair, including "when is the
  plumber coming?" after a job is booked. That costs about 0.85¢ instead of 0.02¢.
- A refusal from Haiku 5.5 is not retried on Sonnet; the rules answer instead.
- A feature dropped after a 400 stays off until the service restarts (logged once).
- `/stats` is only reachable inside Railway (bearer token, no public domain); the hourly
  log line is the easy way to read it.
- The repair-chat signal depends on the fact label "Problem we are talking through now" in
  `src/workflows/inbound-message.ts` (`REPAIR_CHAT_FACT` in `route.ts`). If that label
  changes, repair chats start on Haiku and escalate on the first maintenance answer.
- Not done on purpose: 1-hour cache (2x write price, pays only at 3+ calls an hour per
  model), pre-warming (prefix too small to matter), batch (replies are live), caching
  per-owner facts (each owner's traffic is far sparser than 5 minutes).

## Tests

`tests/ai-cost.test.ts` (18 tests, all fetch calls faked): routing table of real-world
messages, escalation rules, env settings, the exact request body (model, cached system
block, effort, schema, no temperature/thinking/dated ids, beta header only with
fallbacks), identical system bytes across different requests, schema closes every
object, tag injection, escalation success/skip/failure, cost math (cache rates, Haiku's
over-100K rate card, server-side fallback iterations, unknown models), the cost meter,
the AI service log line and `/stats` over HTTP, rules fallback on 5xx/timeout/refusal/
truncated output (with billed calls still counted), the 400 self-heal, HttpAI
pass-through and the main app's direct mode.
