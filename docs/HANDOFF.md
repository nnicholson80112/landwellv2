# KeyHelm: project handoff (as of Oct 21, 2026)

This file is the single source of truth for picking the project up in Claude Code.
Read it top to bottom before changing anything. `CLAUDE.md` at the repo root points here.
**Work is split into five areas** (website; workflows + AI; signup, billing and owner app; GitHub, Railway
and data; live testing and review). Each has a doc with goals in `docs/areas/` and subagents in
`.claude/agents/`; start at `docs/areas/README.md`, which also lists what to do first right now.
Each feature has deeper notes in `docs/notes/` (owner-api, owner-ui, billing, postgres, ai-cost, ops,
site-and-sms, twilio-a2p).

---

## 1. What we're building

**KeyHelm** (KeyHelm LLC) is software that does a property manager's job for rental owners with
1–50 homes, starting in Colorado, for a flat price per door instead of the 8–12% of rent (plus
leasing fees) managers charge. Owners stay the landlord.

**The core promise:** an owner can go a full month without answering a tenant, chasing a late
payment or booking a repair. They keep only four jobs:

1. Approve or deny applicants (screening report shown next to their written criteria; **no AI score or recommendation**).
2. Set up self-showings once (smart lock or lockbox).
3. Approve repairs over their spending limit.
4. Sign leases (they upload their own lease; it refills for every tenant and renewal).

**MVP is done when** the first real client runs one full month: every tenant message answered,
one repair from request to paid, rent reminders and late checks working, and the owner spends
under 30 minutes.

### Owner / founder
- Nate (nnicholson80112@gmail.com). Also owns **GlassHouse Exteriors** (window cleaning, house and pressure washing), 720-930-5782. A partner is building a website for the Twilio registration.
- Nate makes every decision. He knows Colorado landlord law well: **no attorney review is needed**; legal pages are owner-approved.
- **How Nate likes to work:** plain language, short answers, tell him exactly what to click. Bright, inviting design with strong CTAs. Don't invent facts. **Never ask him to paste keys or tokens into chat**; secrets go only into Railway Variables. He has said: make every change needed, don't ask for help, assume he agrees.

---

## 2. Firm decisions (don't undo these without asking Nate)

- **Name:** KeyHelm, legal name **KeyHelm LLC**.
- **Software only.** No in-person services on any plan. No brokerage partner.
- **KeyHelm never collects, holds or moves rent, deposits or vendor payments.** Tenants pay the owner directly. KeyHelm sends reminders and late notices, asks the owner "Did rent arrive?" before calling anything late, and lets the owner decide on a Colorado-capped late fee. Deposits: KeyHelm sends the itemized statement and reminds the owner of the 30-day deadline; the owner sends the refund.
- **The only money KeyHelm charges is its own subscription** (Stripe), per door per month.
- **Fair housing: stay out of the gray areas.** The AI never discusses neighborhoods, safety, schools, religion, protected traits or who a home is "good for". Accommodation requests, screening-decision questions, complaints and legal topics go straight to the owner.
- **In-house AI service** (its own Railway service) with Claude underneath: Claude Haiku 5.5 for routine messages, Claude Sonnet 5.5 for repairs. Built-in rules are the fallback.
- **Hosting:** Railway. **Database:** Postgres on Railway (code ready; see go-live). **Billing:** Stripe. **Email:** Postmark. **Texts + calls:** Twilio, one shared number to start. **Onboarding calls:** Calendly.
- **Brand:** bright and inviting. Sky-white `#F6F9FF`, navy text `#0E1B33`, KeyHelm blue `#1B4DFF` (main buttons), sunny yellow `#FFC83D` (highlights), mint `#0E9F6E` (success). Fonts: Bricolage Grotesque (headlines), Figtree (body), self-hosted. Rules in `docs/LAUNCH-CHECKLIST.md`: no pills, gradients, em dashes, fake claims, testimonials or stats.
- **Demo calls:** a few slides, then mostly a hands-on product demo.

---

## 3. Pricing and billing (current; Stripe is the source of truth)

Per door per month. First month charged at checkout. **No setup fee.** Month-to-month or a 12-month agreement (billed monthly).

| Plan | Month-to-month | 12-month agreement | Offer price (private offers bring it to) |
| --- | --- | --- | --- |
| Essentials | $10 | $8 | $8 / $6 |
| Autopilot (recommended) | $15 | $12 | $12 / $10 |
| Autopilot Pro | $20 | $16 | $16 / $13 |

- Plan ids in code: `essentials`, `autopilot`, `pro` (`plus` is accepted as an old alias). Code: `src/billing/plans.ts`, `offers.ts` (`LIST_PRICE` = Stripe, `BASE_PRICE` = offer price, `PRICE_FLOOR` $5/$8/$10), `stripe.ts`, `catalog.ts`.
- Stripe lookup keys: `keyhelm_<plan>_monthly` and `keyhelm_<plan>_annual` (the 12-month agreement). Old `landwell_*` keys are still read for old subscriptions.
- Plan contents: **Essentials** = rent reminders and late notices, repair requests and vendor list, guided tenant fixes, applications and screening, lease fill-in and e-sign, income and expense books. **Autopilot** = + 24/7 tenant text and email assistant, automatic dispatch to vendors, renewals, move-outs and deposit statements, monthly statements. **Autopilot Pro** = + 24/7 emergency dispatch, smart-lock self-showings, listings on Zillow and more (manual paste until the feed is approved), priority support.
- **12-month agreement terms** (in `/terms` and `/refunds`): email 30 days before the term ends; then continues month to month at the agreement price. Early cancellation: service runs to the end of the paid month, plus a one-time charge = (month-to-month price − agreement price) × months used, so it never costs more than month-to-month. That charge is invoiced by hand in Stripe for now.
- **Referral credit** is still $50; large next to the new per-door prices. Nate's call whether to lower it (`src/billing/offers.ts`).
- Private offers (`docs/OFFERS.md`): one person each, single-use Stripe coupon, expire, never stack, never below the floor.

### Signup → pay → sign in → onboarding
Website **Get started** → `POST /api/public/signup` → Stripe Checkout → webhook marks the subscription active and starts the onboarding workflow → `/billing/done` gives a brand-new paying owner a one-time link to **set a password** → the **owner app** at `/app`, which shows a 6-step setup checklist and **Book your onboarding call** (Calendly). Owners sign in later at `/login`; "Forgot password" emails a link once Postmark is connected.

---

## 4. Live infrastructure

| Thing | Where | State |
| --- | --- | --- |
| Code | GitHub `nnicholson80112/landwellv2` (public), branch `main` | Pushing to `main` deploys both Railway services in about a minute. |
| Checks | GitHub Actions | **CI** (tests, typecheck, demo, Postgres tests) on every push. **Live check** after every push to `main`: waits for Railway to deploy that exact commit, then checks the live pages. Run it by hand (Actions → Live check → Run workflow) to also test live conversations through the phone-line webhook. |
| App (api service) | Railway → `https://api-production-66895.up.railway.app` | Online. `/health` shows the live commit, data version, storage and AI mode. |
| AI service (ai) | Railway, private only, `http://ai.railway.internal:8788` | Online; Claude answering (live check Oct 19: 10/10). |
| Storage | Railway volume `/data` (`/data/landwell.json`, daily backups in `/data/backups`) | JSON file today. Postgres code is ready: add the database (go-live step 2). The pre-KeyHelm test data was set aside on Oct 19 (`dataVersion: 2`). |
| Billing | Stripe sandbox "New business" (`acct_1Sf7x1EtnoC4AY9t`, test mode) | KeyHelm products: Essentials `prod_VTEcGmLz6x8tim`, Autopilot `prod_VTEcsEfed26xMm`, Autopilot Pro `prod_VTEcNv6XWoqCs3`, each with monthly + annual prices. Old Landwell products/prices still active (archive after this deploy is live; they're unused). |
| Onboarding | Calendly `calendly.com/nnicholson80112` | Works. A dedicated "KeyHelm onboarding" event couldn't be created from here; optional (go-live step 9). |
| Email | Postmark | **Not set up.** |
| Texts + calls | Twilio | **Not set up.** Registration guide: `docs/notes/twilio-a2p.md`. |

### Railway services
- **api**: start `npm start` (builds the site, then `src/api/server.ts`). Public domain. Volume `/data`.
- **ai**: start `npm run ai` (`src/ai-service/server.ts`). No public domain. Volume `/data`.
- One `Dockerfile` (node:22-slim, no runtime dependencies). `railway.json` sets healthcheck `/health`.

### Railway variables (names only; values live in Railway, never in chat or git)
**api (set today):** `PORT`, `PUBLIC_URL`, `DATA_FILE=/data/landwell.json`, `TZ_DEFAULT=America/Denver`, `OWNER_API_TOKEN`, `ADMIN_API_TOKEN`, `AI_PROVIDER=http`, `AI_HTTP_URL`, `AI_HTTP_TOKEN`, `DEV_TOOLS=true`, `SEED_DEMO=true`, `DEMO_*`, `STRIPE_SECRET_KEY` (sk_test), `STRIPE_WEBHOOK_SECRET`, `CALENDLY_URL`.
**api (add for launch):** `DATABASE_URL=${{Postgres.DATABASE_URL}}`, `BUSINESS_EMAIL`, `BUSINESS_ADDRESS` (optional; registered agent or mailbox, never a home), `BUSINESS_PHONE` (optional), `ADMIN_ALERT_PHONE`, `ADMIN_ALERT_EMAIL`, then `POSTMARK_TOKEN`, `EMAIL_FROM`, `EMAIL_WEBHOOK_SECRET`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`. Optional: `STRIPE_AUTO_SETUP=false` (turns off Stripe self-setup), `RL_*` limits, `SEAM_API_KEY`, `CALENDLY_TOKEN`.
**ai:** `PORT=8788`, `AI_SERVICE_TOKEN`, `AI_MODEL_PRIMARY=anthropic`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL=claude-sonnet-5-5` (used for repairs), `AI_LOG_DIR=/data/ai-logs`, `AI_LOG_RETENTION_DAYS=90`. Optional: `AI_MODEL_ROUTINE` (default `claude-haiku-5-5`), `AI_MODEL_COMPLEX`, `AI_EFFORT_ROUTINE`, `AI_EFFORT_COMPLEX` (default `low`). Keep the Anthropic console's monthly spend limit on.

---

## 5. Go-live checklist (Nate's clicks, in order)

1. **Sign in to the owner app.** Open `https://api-production-66895.up.railway.app/admin` → paste the admin token → Connect → in **Sign-in link**, pick the owner → **Make sign-in link** → open it, choose a password. From then on: `/login`. On a phone: Share → Add to Home Screen.
2. **Database.** Railway → your project → **Create** → **Database** → **Add PostgreSQL**. Then **api** → **Variables** → **New Variable**: `DATABASE_URL` = `${{Postgres.DATABASE_URL}}` → **Deploy**. Check `/health` shows `"storage":{"kind":"postgres"...}`.
3. **Business details.** **api** → **Variables**: `BUSINESS_EMAIL` (a real inbox), optionally `BUSINESS_ADDRESS` and `BUSINESS_PHONE`; `ADMIN_ALERT_PHONE` (+1…) and `ADMIN_ALERT_EMAIL` for new-customer, failure and emergency alerts.
4. **Domain.** Buy the domain → Railway **api** → **Settings** → **Networking** → **Custom Domain** → add it and the DNS record Railway shows → set `PUBLIC_URL` to `https://<domain>`.
5. **Postmark (email).** Create a server → verify the domain (DNS records) → **api** variables `POSTMARK_TOKEN`, `EMAIL_FROM` (e.g. help@<domain>), `EMAIL_WEBHOOK_SECRET` (random) → set the inbound webhook to `https://<domain>/webhooks/email?key=<EMAIL_WEBHOOK_SECRET>`. This turns on "Forgot password", setup-link emails and email alerts.
6. **Twilio (texts + calls).** Follow `docs/notes/twilio-a2p.md` step by step: buy a Colorado number, register the A2P 10DLC brand (KeyHelm LLC, EIN) and campaign (paste-ready text inside), set Advanced Opt-Out replies, point SMS to `/webhooks/twilio/sms` and voice to `/webhooks/twilio/voice`, then set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`. 10DLC approval can take weeks; a **toll-free number with toll-free verification** is usually faster to start texting.
7. **Stripe live.** Finish activating the Stripe account (business details, bank). Then **api** → **Variables**: set `STRIPE_SECRET_KEY` to the `sk_live_…` key and **delete** `STRIPE_WEBHOOK_SECRET` → Deploy. The app creates the live products, prices, webhook and billing portal by itself; the Deploy Logs say "Stripe setup (live): ready". Set the statement descriptor and branding in Stripe settings.
8. **Before the first real customer:** set `SEED_DEMO=false` and `DEV_TOOLS=false` on **api**. The demo owner uses Nate's own phone number (720-930-5782) as owner and vendor; if Nate also signs up as a real owner with that phone, use a different phone or remove the demo data first.
9. **Optional:** in Calendly create a "KeyHelm onboarding" event (45 min) and set `CALENDLY_URL` to its link; in Stripe sandbox archive the old "Landwell …" products.

---

## 6. The codebase (`landwellv2`)

TypeScript on **Node 22.6+**, run with `--experimental-strip-types`. **No runtime dependencies** (Node built-ins only).

```
npm test              # all tests (Postgres tests start a throwaway local cluster when the binaries exist, else skip)
npm run demo          # every workflow on sample data with a simulated month (0 failed)
npm start             # API + website on http://localhost:8787 (token: dev-token locally)
npm run ai            # AI service on :8788 (needs AI_SERVICE_TOKEN)
npm run typecheck     # tsc --noEmit (run `npm install` once for the dev types)
npm run build:site    # apps/site/site.body.html → apps/site/index.html
npm run build:review  # rebuilds apps/review/review.html from a fresh demo run
node scripts/live-check.mjs <url> [--conversations]   # check a live deploy from outside
```

| Path | What it is |
| --- | --- |
| `src/engine/` | Durable workflow engine (waits for people, dates and events; survives restarts; prunes old runs) |
| `src/workflows/` | The 16 workflows (`docs/WORKFLOWS.md`) |
| `src/ai/` | Guardrails, prompt, providers (Claude via raw fetch), model routing (`route.ts`), cost math (`cost.ts`), rule-based fallback |
| `src/ai-service/server.ts` | The in-house AI service (`/respond`, `/stats` with cost per message) |
| `src/api/server.ts` | HTTP server, webhooks (Twilio SMS + voice, Postmark, screening, identity), apply form, signing page, `/play`, `/health` |
| `src/api/auth.ts`, `owner-routes.ts`, `owner-data.ts`, `owner-pages.ts` | Owner sign-in (scrypt passwords, hashed sessions, one-time links, CSRF) and the full owner API |
| `src/api/billing-routes.ts`, `src/billing/` | Signup, checkout, webhook, billing portal, offers, Stripe self-setup |
| `src/api/legal.ts` | Privacy, terms, `/sms` (Twilio program page), cookies, refunds, accessibility |
| `src/ops/` | Admin alerts, shared-number routing, daily backups, `/api/admin/status` |
| `src/store/` | JSON-file store and the Postgres store (own wire-protocol client, no dependencies) |
| `apps/owner/` | **The owner app** at `/app`: Today, Rent, Repairs, Messages, Homes, Settings |
| `apps/site/` | Marketing website (edit `site.body.html`, then `npm run build:site`) |
| `apps/admin/` | `/admin`: customers, sign-in links, private offers, Calendly connect (admin token) |
| `apps/play/` | `/play` test console (owner token) |
| `docs/notes/` | Per-feature notes with every variable and setup step |

### How messages flow (text, email, voice)
Inbound webhook on **api** → `message.received` → Front desk workflow → STOP/START/HELP → **guardrails** (emergencies, fair housing, accommodations, legal → owner) → **ai service** (Haiku, or Sonnet for repairs) drafts a reply using only the owner's FACTS → **guardrails check the draft** → reply sent + the right workflow starts. If the AI is down, built-in rules answer. One shared Twilio number serves every owner: known tenants/vendors/prospects route by who they are, new people by the home they name, otherwise KeyHelm asks which address.

### Demo data (seeded when the store is empty and `SEED_DEMO` is not `false`)
Owner **Nate** (`DEMO_OWNER_PHONE`, Autopilot). Home **7610 S Rosemary Cir, Centennial**, tenant **Lisa Chen** (`DEMO_TENANT_PHONE`), lease to 2027-02-14. Vacant listed home **88 Aspen Ct, Aurora**. Vendor **GlassHouse Exteriors** (same phone as the owner). Once Twilio is live, repair jobs **really text 720-930-5782**.

---

## 7. What was done (history)

- **Oct 9–11:** research and plan, website, durable engine, 15 workflows, AI plug-in, guardrails, Colorado rules, API + webhooks, lease signing, `/play`, Railway deploy, rent collection removed, Stripe subscriptions, private offers, Calendly, pricing model.
- **Oct 16:** repair chat with safe self-fixes; site, legal and protection pass; Stripe test payment succeeded; workflow polish pass (STOP/START, quiet hours, decision codes, renewal and deposit by text, smarter showings, duplicate repairs, partial rent, decision reminders) and several real bugs fixed.
- **Oct 19–20 (KeyHelm launch build):**
  - Merged to `main`; Railway auto-deploy confirmed working; GitHub Actions CI + post-deploy live check; `/health` shows the live commit; old test data set aside on deploy; live conversations retested 10/10.
  - Renamed to **KeyHelm / KeyHelm LLC** everywhere; Stripe sandbox products renamed.
  - **Owner app** (`/app`) with real sign-in: decisions with inputs, rent, repairs, messages and replies, homes/tenants/vendors/lease, rules, billing portal, setup checklist, onboarding call button. Admin sign-in links.
  - **Billing** aligned to the KeyHelm Stripe catalog ($10/$15/$20, $8/$12/$16), Autopilot Pro, self-setup of live products/prices/webhook/portal, "Manage billing" portal.
  - **Postgres** storage with no dependencies (journals the in-memory store; survives outages; imports the JSON file once).
  - **AI cost:** Haiku 5.5 for routine, Sonnet 5.5 for repairs, cached prompt, structured output, cost per message in `/stats` and logs (estimate ~0.4–0.6¢ blended vs ~2¢ before; real numbers after deploy).
  - **Website** rebuilt for KeyHelm with the Stripe prices, calculator and FAQ; `/sms` program page and texting clauses for Twilio A2P; Twilio registration guide (`docs/notes/twilio-a2p.md`); terms and refund pages finished (12-month agreement terms, liability, disputes).
  - **Ops:** alerts to Nate (new customer, failures, emergencies with no vendor, AI fallback, past due, unrouted messages), shared-number routing, daily backups, `/api/admin/status`.
- **Oct 20 evening:** pushed the launch build (`270af79`) to `main`; CI passed but Railway kept running
  `9292002` (see current issue 1). Docs split into five work areas with subagents (`docs/areas/`, `.claude/agents/`).

---

## 8. Current issues (in priority order)

1. **The Oct 20 deploy (`270af79`, the whole launch build) never went live.** Railway still runs `9292002`
   from Oct 19, so the live site has none of the KeyHelm launch work yet. First job for the next chat:
   `docs/areas/infrastructure.md`, "The stuck deploy".
2. **Fix before launch: removing a vendor mid-repair can book the wrong vendor,** who then gets the tenant's
   name and phone (`src/workflows/maintenance.ts`; details in `docs/areas/automation.md`).
3. **The pre-launch code review never finished** (session usage limit). Rerun it: `docs/areas/live-testing.md`.
4. **Twilio and Postmark aren't connected,** so tenants can't text or email yet (replies only appear in `/play`). Go-live steps 5–6. Twilio 10DLC review takes weeks; toll-free verification is the faster start.
5. **Stripe is in test mode.** Go-live step 7 once the account is activated.
6. **Storage is still the JSON file** until the Postgres database is added (go-live step 2).
7. **New AI request settings are untested against the live API until this deploy.** If Anthropic rejects one (structured output, effort, fallbacks), the code drops it and retries; watch the **ai** logs and run the Live check with conversations after deploying.
8. **The repo is public.** Fine while there are no secrets in git; move to a private repo when convenient.
9. **Demo owner shares Nate's phone** (see go-live step 8).
10. **Early-cancellation charge for 12-month agreements** is invoiced by hand in Stripe (not automated).

---

## 9. How to test

**Owner app:** sign in (go-live step 1) and click through each tab. Decisions can be answered in the app or by text (`YES K4P`).
**AI in `/play`:** open `/play` → paste `OWNER_API_TOKEN` → Connect → choose who's texting → send. Good test messages: "The toilet won't stop running" (Lisa) · "Is the Aspen Court place available? Do you allow dogs?" (prospect) · "Are there good schools nearby?" (neutral answer) · "I smell gas" (911) · "Water is pouring out from under the dishwasher" (no 911) · "We'd like to renew".
**Live check:** GitHub → Actions → **Live check** → **Run workflow** (conversations on). Or `node scripts/live-check.mjs https://api-production-66895.up.railway.app --conversations`.
**Billing:** website **Get started** → card `4242 4242 4242 4242`, any future date and CVC → set password → `/app`.
**Health:** `/health` (public) and `/api/admin/status` (admin token).

---

## 10. Links

- **Live app:** `https://api-production-66895.up.railway.app` (`/`, `/app`, `/login`, `/sms`, `/health`, `/play`, `/admin`).
- **Repo:** `https://github.com/nnicholson80112/landwellv2` (Actions tab: CI and Live check).
- **Calendly:** `https://calendly.com/nnicholson80112`.
- **Key Maker** (random secret values, made in the browser): https://claude.ai/artifact/UHyKbTPkBVM5VAS8pBv2ka

**Colorado rules built in:** repairs start within 24h (health/safety) or 72h (SB24-094); late fee only after 7 days, capped at the greater of $50 or 5% (SB21-173); 10-day nonpayment demand (owner decides, software never files); all-in advertised rent and a free payment method (HB25-1090); deposit back within 30 days (HB25-1249); for-cause non-renewal with ~90 days' notice (HB24-1098); one rent increase per 12 months (HB21-1121).
