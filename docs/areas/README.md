# KeyHelm work areas (start here in a new chat)

The project is split into five areas. Each one has its own doc (goals, where it stands, files,
rules, how to check the work) and its own subagents in `.claude/agents/`. A new chat reads
`docs/HANDOFF.md` (the big picture), then this page, then the doc for the area it's working on.

| Area | Doc | Subagents | What it covers |
| --- | --- | --- | --- |
| 1. Website | [website.md](website.md) | `site-builder`, `site-copywriter`, `site-qa` | Marketing site, legal pages, `/sms` page, everything Twilio's reviewers look at |
| 2. Automation (workflows + AI) | [automation.md](automation.md) | `workflow-engineer`, `ai-frontdesk` | The 16 workflows, texting rules, the AI front desk, guardrails |
| 3. Signup, billing and owner app | [owner-app-billing.md](owner-app-billing.md) | `owner-app-engineer`, `billing-engineer` | Get started → Stripe → set password → `/app`, the admin page |
| 4. GitHub, Railway and data | [infrastructure.md](infrastructure.md) | `release-engineer` | CI, deploys, Railway services and variables, Postgres, backups, alerts, account setup (Twilio, Postmark, domain) |
| 5. Live testing and review | [live-testing.md](live-testing.md) | `live-tester`, `code-reviewer` | Checking the live site after each deploy, test-mode payments, code review before launch |

Why it's split this way:
- **Product workflows and GitHub/Railway are separate areas.** Changing what a text says or when a
  repair gets booked (area 2) and fixing a deploy (area 4) touch different files and need different
  checks. Every change still ships the same way: commit → push to `main` → Railway deploys → live check.
- **AI sits with the workflows**, because every tenant text goes through both, and the guardrails
  and the workflow that acts on the reply have to agree.
- **Billing sits with the owner app**, because signup, payment and first sign-in are one flow a
  customer walks through in two minutes, and most bugs live in the hand-offs between them.
- **Legal pages sit with the website** (Nate handles legal review himself). Fair-housing rules sit
  with the AI.
- **Code review sits with live testing**: both answer "is it safe to sell?"

---

## Right now (Oct 21, 2026): do these first, in order

1. **The last deploy didn't go live (area 4).** `main` is at `270af79` (the whole KeyHelm launch
   build), but the live app still runs `9292002` from Oct 19. The post-deploy Live check
   (GitHub Actions run 39491336427) waited 15 minutes and failed: "live is 9292002", and `/sms`
   returned 404 because the old code has no `/sms` page. Railway either failed to build, the new
   code didn't answer `/health` in time on boot, or Railway never started (or skipped) the deploy; either way it
   kept the old version. If the newest deploy says **Skipped** or isn't there, say so. **Nate:** Railway →
   project → **api** → **Deployments** → the newest (failed) one → **View logs** (Build and Deploy).
   Paste what the log says (not any secrets) into the chat. Check the **ai** service's deployments too.
   A local try on Oct 21 found the new code boots fine against old data, so Railway's own deploy list and
   logs are the place to look (infrastructure.md, "The stuck deploy").
2. **Fixed on `kh/owner-dashboard`:** removing a vendor mid-repair could book the wrong vendor (area 2). Found by the
   Oct 21 doc check and confirmed in code (`src/workflows/maintenance.ts`, the `candidates` list is rebuilt
   outside a step). The wrong vendor then gets the tenant's name and phone. Details in automation.md.
3. **Code review before selling (area 5).** The six-angle review never finished (the agents hit the
   session usage limit). Rerun it in small batches: see live-testing.md.
4. **Live test with conversations (area 5)** once `270af79` (or later) is live.
5. Then the go-live clicks for Nate in `docs/HANDOFF.md` section 5 (Postgres, business email, domain,
   Postmark, Twilio, Stripe live, demo data off).

Uncommitted work from the last chat: none. These docs, the subagents and a small fix so uptime monitors'
`HEAD` requests get 200 are all on `main` (pushed Oct 21; like every push, that started a deploy and a Live
check, which will hit the same stuck-deploy problem until it's fixed).

---

## How to run the agents

- In a new chat, say for example: "Use the `site-qa` agent to audit the website" or "Have
  `workflow-engineer` and `ai-frontdesk` work on automation.md goals 3 and 4 in parallel".
- Agents that change code should each work in their **own git worktree** (ask for worktree
  isolation) when more than one runs at a time, then the main chat merges, runs the checks and pushes.
- **Only the main chat pushes to `main`** (pushing deploys). Agents commit on their own branch.
- **Run at most 2 to 3 agents at once.** Six at once hit the session usage limit last time and
  all of them were lost.
- A saved review workflow lives at `.claude/workflows/keyhelm-review.js` (say "run the
  keyhelm-review workflow").

## Rules every area follows

- Plain language for Nate, tell him exactly what to click. Never ask him to paste keys or tokens into
  chat; secrets go only into Railway Variables.
- KeyHelm never collects, holds or moves rent, deposits or vendor payments.
- Fair housing: the AI never discusses neighborhoods, safety, schools or protected traits, and never
  scores or recommends applicants.
- No runtime dependencies (Node 22 built-ins only), TypeScript via `--experimental-strip-types`.
- Tests never call real Stripe, Twilio, Postmark, Anthropic or Railway (they mock `fetch`).
- Never buy phone numbers, send real texts or emails to real people, or charge real cards from a
  chat. Test mode only.
- The repo is public: never commit secrets.
- Before every commit: `npm test`, `npm run typecheck`, `npm run demo` (0 failed). After editing
  `apps/site/site.body.html` run `npm run build:site`; after workflow changes run `npm run build:review`.

## Paste this into a new chat

> Read `docs/HANDOFF.md`, then `docs/areas/README.md`, and work through its "Right now" list in order:
> find out why commit 270af79 didn't go live on Railway (my Railway deploy log is below), fix it, push,
> and confirm the Live check passes; fix the wrong-vendor repair bug; then rerun the code review in small
> batches and fix what it confirms. Use the subagents in `.claude/agents/` for each area, at most 2 to 3
> at a time. Don't ask me for help unless you need something only I can click; tell me exactly what to
> click. Notify me when it's done.
>
> Railway deploy log:
