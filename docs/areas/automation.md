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
      (structured output, effort, fallbacks). The code drops a rejected setting and retries. In the **ai**
      service logs, search `rejected` (the line reads "rejected effort; sending without it from now on";
      a dropped setting stays off until the ai service restarts) and `failed, trying the next one` (Claude
      failed and the rules answered). Each message should log a line like
      `[ai] tenant → rent_question (0.90) by claude-haiku-5-5`. Then run the Live check with conversations
      (live-testing.md). It passes even when the rules answer, so the log lines are the real proof.
      Replies should now say "KeyHelm", not "Landwell".
- [ ] Read the first real `/stats` cost numbers (hourly `[ai] cost so far` log line on the **ai**
      service) and compare with the estimate (about 0.4 to 0.6 cents per message blended). The estimate
      counts only messages a model answered, so divide the total by the "used a model" count. The line's
      "per message" also counts free guardrail and rules replies. The totals reset on every deploy; the
      JSONL logs in `/data/ai-logs` keep each message's cost. Also check caching: send two rent questions
      within 5 minutes, and the second `[ai] tenant` line should show `cache read` above 0.
- [ ] Workflow edits through the owner app: check that editing a home, tenant, vendor or lease,
      marking a tenant former, or removing a home or vendor while a workflow is waiting on it can't crash
      the run or text the wrong person (part of the code review, live-testing.md). The app can't delete
      tenants or leases. It blocks removing a home or vendor with open work, but a listed home or a vendor
      who already said no can still be removed.
- [ ] **Fix before launch: removing a vendor mid-repair books the wrong vendor.** `src/workflows/maintenance.ts`
      rebuilds `candidates` from the store outside a step. If the owner removes vendor 1 (who said no or
      didn't answer) while vendor 2 is being asked, vendor 2's YES books vendor 3. Vendor 3 then gets the
      tenant's name and phone, and the tenant is told vendor 3 is coming (checked locally on 5449d87). Keep
      each vendor at its recorded place in the list (skip a removed one, don't filter it out) and add a test.
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
  inside `ctx.step(...)`. Side effects only through `ctx.step`, `ctx.approval`,
  `ctx.waitFor`, `ctx.sleepUntil`/`ctx.sleep`, `ctx.emit`, `ctx.log` and the send helpers in `lib.ts`
  (`send`, `tellTenant`, `noticeTenant`, `tellOwner`, `tellVendor`); there is no `ctx.send`. A replay must
  make the same ctx calls in the same order. Repeated step names are numbered automatically (`name#2`),
  so a list that changes between runs shifts every later step.
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
out from under the dishwasher" (emergency repair, shut-off help, no 911) · "We'd like to renew" · "STOP" then
"START" (texts off, then back on; the owner is told). "HELP" gets no reply from KeyHelm on purpose (Twilio
answers it), so in /play it only shows in the activity log. Locally the built-in rules answer, not Claude
(the key lives only in Railway), so these test the rules and guardrails; Claude is checked on the live site.
