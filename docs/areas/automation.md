# Area 2: Automation (the workflows and the AI front desk)

**Subagents:** `workflow-engineer` (the engine and the 16 workflows: what happens, when, who gets
which text), `ai-frontdesk` (how replies are written: guardrails, Claude prompts, model routing, cost).
They often need each other: a new kind of tenant message usually needs a guardrail or AI intent
(`ai-frontdesk`) and a workflow step that acts on it (`workflow-engineer`).

**Deeper notes:** `docs/WORKFLOWS.md` (every workflow, step by step), `docs/AI-PLUGIN.md`,
`docs/notes/ai-cost.md`, `docs/notes/ops.md` (shared-number routing).

## Goals

- [x] 16 durable workflows: front desk (`inbound-message`), repairs (`maintenance`), daily rent check
      (`rent-cycle`), rent received (`payment-received`), late rent (`late-rent`), applications
      (`application`), lease and move-in (`lease`), showings (`showing`), listings (`listing`),
      renewals (`renewal-sweep` → `renewal`), move-out and deposit (`move-out`), tenant welcome
      (`tenant-welcome`), Monday owner report (`weekly-report`), new owner setup (`onboarding`),
      decision reminders (`approval-reminders`).
- [x] Texting polish: STOP/START/HELP, quiet hours, decision codes (`YES K4P`), numbered options,
      renewal and deposit by text, partial rent, duplicate repairs, vendor quotes, photo waits.
- [x] AI cost: Claude Haiku 5.5 for routine messages, Sonnet 5.5 for repairs, cached prompt,
      structured output, cost per message in the AI service's `/stats`.
- [x] Guardrails before and after the model (emergencies → 911 for gas/fire/CO, fair housing,
      accommodations, legal topics → owner, amounts only from facts).
- [ ] **Confirm the new AI request settings work against the real Claude API** once `270af79` is live
      (structured output, effort, fallbacks). The code drops a rejected setting and retries, so watch
      the **ai** service logs for "dropping" lines and run the Live check with conversations
      (live-testing.md). Replies should now say "KeyHelm", not "Landwell".
- [ ] Read the first real `/stats` cost numbers (hourly `[ai] cost so far` log line on the **ai**
      service) and compare with the estimate (about 0.4 to 0.6 cents per message blended).
- [ ] Workflow edits through the owner app: check that deleting a home, tenant, vendor or lease
      while a workflow is waiting on it can't crash the run (part of the code review, live-testing.md).
- [ ] "When is the plumber coming?" after a job is booked escalates to Sonnet (costs ~0.85¢ instead
      of 0.02¢). Optional: keep status questions on Haiku.
- [ ] After Twilio is live: one full real month with the founding client (the MVP test in HANDOFF
      section 1). Watch for messages the rules answer instead of the AI.
- [ ] Voice calls: built (`/webhooks/twilio/voice`), but stay text and email only for the first month.

## Where things stand (Oct 21)

All of the above is on `main` (`270af79`) but not live yet (infrastructure.md). `npm run demo` runs
every workflow over a simulated month: 88 runs, 0 failed. 157 tests pass.

How a message flows: inbound webhook (Twilio SMS/voice, Postmark email) → `message.received` →
`inbound-message` workflow → STOP/START/HELP → guardrails → AI service (`/respond`) drafts a reply
from the owner's FACTS only → guardrails check the draft → reply sent and the right workflow starts.
If the AI service is down, the built-in rules (`src/ai/rules.ts`) answer. One shared Twilio number
serves every owner; `src/ops/lines.ts` routes each sender to the right owner.

## Files

| Path | What |
| --- | --- |
| `src/engine/engine.ts`, `clock.ts` | Durable engine: steps, waits for people, dates and events; replays after restarts |
| `src/workflows/*.ts` | The workflows (`index.ts` installs them; `lib.ts` shared helpers) |
| `src/workflows/inbound-message.ts` | The front desk: keywords, routing, AI call, repair chat |
| `src/config/colorado.ts` | Colorado rules (late fee cap, notice days, repair deadlines) |
| `src/ai/guardrails.ts` | Fair housing, emergencies, legal, accommodation checks (before and after the model) |
| `src/ai/prompt.ts`, `providers.ts`, `route.ts`, `cost.ts`, `rules.ts` | Prompt, Claude calls (raw fetch), Haiku/Sonnet routing, cost math, rule-based fallback |
| `src/ai-service/server.ts` | The separate **ai** Railway service (`/respond`, `/stats`, JSONL logs) |
| `src/sim/demo.ts`, `seed.ts` | The simulated month and demo data |
| Tests | `engine`, `workflows-polish`, `repair-chat`, `rules`, `ai-cost`, `ai-service`, `e2e` |

## Rules for this area

- Anything that reads the store or the clock and can change between the first run and a replay goes
  inside `ctx.step(...)`. Side effects only through `ctx.step`, `ctx.send`, `ctx.approval`,
  `ctx.waitFor`, `ctx.sleepUntil`. Step keys must be unique per run.
- Fair housing: the AI never discusses neighborhoods, safety, schools, religion or protected traits,
  never says who a home is "good for", and never scores or recommends applicants.
- KeyHelm never sends rent pay links or handles money. The owner marks rent received.
- Claude requests: no `temperature`/`top_p`/`top_k`, no `thinking`, no dated model ids; effort goes in
  `output_config`. Haiku 5.5 gets no `fallbacks`. Read the `claude-api` skill before changing them.
- Tests fake `fetch`; never call the real Claude API from tests.
- After workflow changes run `npm run build:review` (rebuilds `apps/review/review.html`) and refresh
  `docs/demo-transcript.txt` from `npm run demo` (strip colors).

## How to check your work

```
npm test && npm run typecheck && npm run demo     # demo must show 0 failed
npm start   # then /play with the owner token (dev-token locally): text as Lisa, a prospect, the vendor
```
Good test messages: "The toilet won't stop running" · "Is the Aspen Court place available? Do you allow
dogs?" · "Are there good schools nearby?" (neutral, no opinion) · "I smell gas" (911) · "Water is pouring
out from under the dishwasher" (urgent, no 911) · "We'd like to renew" · "HELP" · "STOP".
