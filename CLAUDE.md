# KeyHelm: notes for Claude Code

Read `docs/HANDOFF.md` first. It has the goals, firm decisions, pricing, live infrastructure,
current issues (in priority order) and what's next. Then `docs/areas/README.md`: the five work areas,
each with a goals doc and its own subagents in `.claude/agents/`, and what to do first right now.

## Working with Nate
- Plain language, short answers, tell him exactly what to click.
- Bright, inviting design with strong CTAs (brand colors and fonts in `docs/HANDOFF.md`).
- Don't invent facts. Nate handles legal review himself (he knows Colorado law); don't block on an attorney.
- **Never ask him to paste API keys, tokens or secrets into chat.** They go only into Railway Variables.

## Hard rules for the code
- KeyHelm never collects, holds or moves rent, deposits or vendor payments. Stripe bills only KeyHelm's own subscription.
- Fair housing: the AI never discusses neighborhoods, safety, schools or protected traits, and never scores or recommends applicants.
- No runtime dependencies (Node 22 built-ins only). TypeScript runs with `--experimental-strip-types`.
- `LIST_PRICE` / `BASE_PRICE` in `src/billing/offers.ts` must match the Stripe prices (lookup keys `keyhelm_<plan>_<monthly|annual>`, plans `essentials|autopilot|pro`). `src/billing/catalog.ts` creates any missing Stripe prices, the webhook and the portal on boot.

## Before every commit
`npm test` (all must pass; CI also runs the Postgres tests), `npm run typecheck`, and `npm run demo` should show 0 failed runs.
After editing `apps/site/site.body.html` run `npm run build:site`; after workflow changes run `npm run build:review`.
Pushing to `main` deploys to Railway (both `api` and `ai` services).
