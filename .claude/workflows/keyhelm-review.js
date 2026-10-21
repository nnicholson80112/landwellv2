export const meta = {
  name: 'keyhelm-review',
  description: 'Read-only multi-angle review of the KeyHelm launch code, two reviewers at a time, every serious finding checked by a skeptic',
  whenToUse: 'Before selling or after a big merge. Args (optional): {"base": "<commit>", "lenses": ["security", ...]}',
  phases: [
    { title: 'Find', detail: 'one reviewer per angle, two at a time' },
    { title: 'Verify', detail: 'a skeptic tries to disprove each critical or high finding' },
  ],
}

// 9292002 is the last commit before the KeyHelm launch build landed on main.
const BASE = args?.base ?? '9292002'
const COMMON = `You are reviewing KeyHelm in the current repository checkout. The change set is everything in "git diff ${BASE}...HEAD" plus the existing code it touches. KeyHelm is property-management software for small Colorado landlords: Node 22, TypeScript via --experimental-strip-types, no runtime dependencies, JSON-file or Postgres store, durable workflow engine (src/engine), owner app at /app with cookie sessions (src/api/auth.ts, owner-routes.ts), Stripe subscription billing (src/billing), Twilio/Postmark adapters, AI front desk (src/ai, src/ai-service). docs/areas/*.md and docs/notes/*.md say what each part intends.
READ-ONLY: do not edit files, do not commit, never call real Stripe/Twilio/Postmark/Anthropic/Railway. You may run local tests (npm test) and small local scripts.
Report only real, concrete defects with file:line and a specific failure scenario (input/state -> wrong outcome). No style nits, no "could be better". Severity: critical (data loss, security hole, money/legal exposure, a core customer flow broken), high (a core flow breaks in a realistic case), medium (a real bug in a less common path).`

const FINDINGS = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'number' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium'] },
          scenario: { type: 'string', description: 'concrete inputs/state -> wrong outcome' },
          fix: { type: 'string', description: 'the smallest correct fix' },
        },
        required: ['title', 'file', 'line', 'severity', 'scenario', 'fix'],
      },
    },
  },
  required: ['findings'],
}
const VERDICT = {
  type: 'object',
  properties: { real: { type: 'boolean' }, reasoning: { type: 'string' }, corrected_fix: { type: 'string' } },
  required: ['real', 'reasoning'],
}

const ALL_LENSES = [
  { key: 'security', prompt: 'Security: authentication, sessions, CSRF, login links, password reset, admin token checks, owner data isolation (one owner reading/changing another owner\'s records through ANY route, including older routes in server.ts and billing-routes.ts), XSS in every server-rendered page and in apps/owner/index.html, apps/admin, apps/play (unescaped data into HTML), webhook signature checks (Stripe, Twilio, Postmark), open redirects, secrets in responses or logs, SSRF, injection in the Postgres client (src/store/pg.ts parameter handling), rate limits.' },
  { key: 'billing', prompt: 'Billing and money: plan ids (essentials/autopilot/pro with legacy plus), lookup keys, LIST_PRICE/BASE_PRICE/PRICE_FLOOR vs the Stripe catalog (Essentials $10 m2m / $8 12-month, Autopilot $15/$12, Pro $20/$16), checkout params, coupons and offers math, webhook event handling and idempotency, catalog self-provisioning (never modifies existing prices; idempotent), webhook secret storage and verification, billing portal, /billing/done -> setup link flow (a non-payer or another person must never get a sign-in link to someone else\'s account). Also the rule that KeyHelm never collects rent/deposits.' },
  { key: 'workflows', prompt: 'Workflow engine correctness and the 16 workflows: durable replay determinism (anything read from the store or clock that can change between the first run and a replay must be recorded in ctx.step), step-key collisions, waits that can never wake, approvals decided with invalid data through the owner API (src/api/owner-data.ts checkDecision) that then crash or misbehave a workflow, owner-API edits that break running workflows (deleting a property/tenant/vendor/lease mid-workflow, marking a tenant former), new owners without rules, quiet hours, STOP handling, texts that would go to the wrong person.' },
  { key: 'storage', prompt: 'Storage and ops: PgStore change tracking (every MemoryStore mutation path must mark changes; any code that mutates objects returned by the store without calling update), flush timing and shutdown, first-boot import and data-version fresh start (must never wipe real customer data), JSON file atomic writes and backups, the ops alerts (spam, recursion if alert sending itself fails), shared Twilio number routing (a message routed to the wrong owner is a privacy breach), /health and /api/admin/status leaking data. Also: anything that could make the server crash or hang on boot with a data file written by older code (commit 9292002).' },
  { key: 'ai', prompt: 'AI front desk: model routing (claude-haiku-5-5 routine / claude-sonnet-5-5 for repairs), request body correctness for the Claude Messages API (no temperature/top_p on these models, no thinking field, effort in output_config, structured output format, cache_control placement, no date-suffixed model ids), refusal and error fallback to rules, cost accounting math, the api->ai service HTTP contract (normalize), and the guardrails before and after the model (fair housing: never discuss neighborhoods/schools/safety/protected traits; emergencies; amounts only from facts).' },
  { key: 'product', prompt: 'Product and UX correctness from a paying customer\'s point of view: walk the real flows in code (website -> signup -> Stripe checkout -> /billing/done -> set password -> /app; add homes/tenants/vendors/rules/lease; decide approvals in the app; mark rent received; reply to a tenant; sign out/in; forgot password) and find broken steps: wrong field names between apps/owner/index.html and the API (compare every fetch call body and every response field the UI reads with src/api/owner-routes.ts/owner-data.ts), dollars vs cents mistakes, missing CSRF header, dead buttons, plan names/prices on the site that do not match billing code, links that 404, text that says Landwell, em dashes, invented claims.' },
]
const LENSES = Array.isArray(args?.lenses) ? ALL_LENSES.filter((l) => args.lenses.includes(l.key)) : ALL_LENSES

const confirmed = []
const mediums = []
const rejected = []
// Two reviewers at a time: six at once hit the session usage limit before (Oct 20).
for (let i = 0; i < LENSES.length; i += 2) {
  const batch = LENSES.slice(i, i + 2)
  log(`Reviewing: ${batch.map((l) => l.key).join(', ')}`)
  const results = await pipeline(
    batch,
    (l) => agent(`${COMMON}\n\nYour angle: ${l.prompt}\nRead the actual code paths end to end. Return at most 8 findings, most severe first.`, { label: `find:${l.key}`, phase: 'Find', schema: FINDINGS }),
    (r, l) => {
      const found = r?.findings ?? []
      for (const f of found) if (f.severity === 'medium') mediums.push({ lens: l.key, ...f })
      return parallel(found.filter((f) => f.severity !== 'medium').map((f, j) => () =>
        agent(`${COMMON}\n\nAn earlier reviewer (${l.key} angle) reported this defect. Try hard to REFUTE it by reading the actual code (and running a quick local test or script if useful). Answer real=false if the scenario cannot happen as described (another check prevents it, the input can't reach that code, or it's intended behavior documented in docs/areas or docs/notes). If it IS real, say so and give the smallest correct fix.\n\nFinding: ${JSON.stringify(f)}`, { label: `verify:${l.key}:${j + 1}`, phase: 'Verify', schema: VERDICT })
          .then((v) => ({ lens: l.key, ...f, verdict: v }))))
    },
  )
  for (const f of results.flat().filter(Boolean)) {
    if (f.verdict?.real) confirmed.push(f)
    else rejected.push({ lens: f.lens, title: f.title, why: f.verdict?.reasoning ?? 'reviewer did not finish' })
  }
  const missing = batch.filter((l, k) => results[k] == null).map((l) => l.key)
  if (missing.length) log(`No result from: ${missing.join(', ')} (rerun with {"lenses": ${JSON.stringify(missing)}})`)
}
log(`${confirmed.length} confirmed, ${mediums.length} medium (unverified), ${rejected.length} rejected`)
return { confirmed, mediums, rejected }
