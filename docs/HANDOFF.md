# Landwell: project handoff (as of Oct 11, 2026)

This file is the single source of truth for picking the project up in Claude Code.
Read it top to bottom before changing anything. `CLAUDE.md` at the repo root points here.

---

## 1. What we're building

**Landwell** (working name) is software that does a property manager's job for rental
owners with 1–50 homes, starting in Colorado, for a flat price per door instead of the
8–12% of rent (plus leasing fees) managers charge. Owners stay the landlord.

**The core promise:** an owner can go a full month without answering a tenant, chasing a
late payment or booking a repair. They keep only four jobs:

1. Approve or deny applicants (screening report shown next to their written criteria; **no AI score or recommendation**).
2. Set up self-showings once (smart lock or lockbox).
3. Approve repairs over their spending limit.
4. Sign leases (they upload their own lease; it refills for every tenant and renewal).

**MVP is done when** the first real client runs one full month: every tenant message
answered, one repair from request to paid, rent reminders and late checks working,
and the owner spends under 30 minutes.

### Owner / founder
- Nate (nnicholson80112@gmail.com). Also owns **GlassHouse Exteriors** (window cleaning, house and pressure washing), 720-930-5782, glasshouseexteriors.com.
- **Solo founder** (no cofounder right now); Nate makes every decision. Does not own rentals yet; the first client is the real test.
- **How Nate likes to work:** plain language, short answers, tell him exactly what to click. Bright, inviting design with strong CTAs. Don't invent facts; flag legal items for an attorney. **Never ask him to paste keys or tokens into chat**; secrets go only into Railway Variables.

---

## 2. Firm decisions (don't undo these without asking Nate)

- **Software only.** No in-person services on any plan. No brokerage partner (New Age Real Estate / Leslie are NOT involved).
- **Landwell never collects, holds or moves rent, deposits or vendor payments.** Tenants pay the owner directly. Landwell sends reminders and late notices, asks the owner "Did rent arrive?" before calling anything late, and lets the owner decide on a Colorado-capped late fee. Deposits: Landwell sends the itemized statement and reminds the owner of the 30-day deadline; the owner sends the refund. (Avoids money-transmitter / broker licensing.)
- **The only money Landwell charges is its own subscription** (Stripe), per door per month.
- **Fair housing: stay out of the gray areas.** The AI never discusses neighborhoods, safety, schools, religion, protected traits or who a home is "good for". Accommodation requests, screening-decision questions, complaints and legal topics go straight to the owner.
- **In-house AI service** (its own Railway service) with Claude underneath; can be swapped for a self-hosted model later. Built-in rules are the fallback.
- **Hosting:** Railway. **Billing:** Stripe. **Email:** Postmark. **Texts + calls:** Twilio (one number). **Onboarding calls:** Calendly.
- **Brand:** bright and inviting. Sky-white `#F6F9FF`, navy text `#0E1B33`, Landwell blue `#1B4DFF` (main buttons), sunny yellow `#FFC83D` (highlights), mint `#0E9F6E` (success). Fonts: Bricolage Grotesque (headlines), Figtree (body). A website + color-scheme refresh is coming; Nate will share prompts later.
- **Name:** "Landwell" is a placeholder. Renaming is easy in code (`docs/RENAMING.md`) but hard after Twilio registration, domain and Stripe profile, so **pick the name before those.**
- **Leslie (leslieleasing.com)** was used only as a reference for how to sell (sales console, live text demo, savings calculator). Different name, colors and customers. Don't copy its brand.
- **Demo calls:** a few slides, then mostly a hands-on product demo.

---

## 3. Pricing and billing (current)

Per door per month. First month charged at checkout. **No setup fee.** Month-to-month or a 12-month agreement (billed monthly).

| Plan | Standard month-to-month | Standard 12-month | Offer price month-to-month | Offer price 12-month |
| --- | --- | --- | --- | --- |
| Essentials | $20 | $15 | $15 | $10 |
| Autopilot (most popular) | $45 | $35 | $35 | $30 |
| Autopilot Plus | $70 | $60 | $60 | $50 |

- **Standard** = what anyone without an offer pays, and what everyone pays after their offer months end. **Offer price** = what private offers bring it back to (Stripe coupon with an exact dollar amount off per door).
- **Legal guardrail:** the standard price must stay a real, regularly charged price (FTC 16 CFR 233.1, former-price comparisons). So offers are private, time-limited and month-limited. Don't give every customer an offer forever, and don't put "was $45, now $35" on the public site unless people really pay $45. **Attorney to review pricing copy and the 12-month agreement** (early cancellation, renewal, cancellation method) before selling it.
- Plan contents: **Essentials** (rent reminders + late notices, repair requests + vendor list, lease fill + e-sign, books). **Autopilot** (+ 24/7 AI receptionist for texts and email, automatic vendor booking, renewals, move-outs, deposit statements, owner statements). **Plus** (+ 24/7 emergency dispatch, smart-lock self-showings, listings on Zillow etc., priority support).
- Code: `src/billing/offers.ts` (`BASE_PRICE` = offer prices, `LIST_PRICE` = standard; must match Stripe), `src/billing/stripe.ts`.

### Private offers (`docs/OFFERS.md` has the research and the full rules)
Modeled on Housecall Pro, Jobber, West Shore Home, Nike and Hulu. ("Flyra" from Nate's list couldn't be identified; Jobber stood in.)
- Every offer belongs to **one person** (owner id or email), is applied server-side at checkout as a **single-use Stripe coupon**, **expires**, **never stacks** (best eligible one wins), and can't push any plan below `PRICE_FLOOR` (placeholders: $9 / $20 / $35; set from real cost to serve).
- Types: **Demo-day** (admin; can lock the offer price for the full 12-month agreement, or 3 months month-to-month; expires ≤7 days), **Web intro** (automatic for self-serve buyers; month 1 at offer price, or 3 months on 12-month), **Win-back** (admin; canceled owners only), **Referral** (automatic from a friend's `?ref=CODE` link; referrer gets $50 Stripe credit after the friend's first paid month), **Seasonal** (admin; named events, 12-month only). Admins can also do a custom % within per-type caps.
- Month-to-month offers are capped at 3 months.

### Signup → pay → onboarding flow
Website **Get started** → `POST /api/public/signup` (creates owner, attaches any offers, issues web intro offer) → Stripe Checkout → webhook marks subscription active, starts the onboarding workflow → `/billing/done` redirects to **Calendly** with name/email prefilled and `utm_content=<ownerId>` → Calendly webhook (optional) marks onboarding "booked".

---

## 4. Live infrastructure

| Thing | Where | State |
| --- | --- | --- |
| Code | GitHub **`nnicholson80112/landwellv2`** (**PUBLIC**, not private; see issue 7), branch `main` | Up to date. Claude GitHub App installed on this repo. Old repo `Landwell` deleted. |
| App (api service) | Railway → `https://api-production-66895.up.railway.app` | Online. **Not deploying new commits; see issue #1.** Running commit `ba5fce2`. |
| AI service (ai) | Railway, private only, `http://ai.railway.internal:8788` | Online, Claude answering (confirmed by live tests). |
| Storage | Railway volume `/data` on each service (`/data/landwell.json`, `/data/ai-logs`) | JSON file store; fine for testing, **not for real customers**. |
| Billing | Stripe sandbox **"New business"** (`acct_1Sf7x1EtnoC4AY9t`, test mode) | 6 prices live; webhook `we_1UP4h5EtnoC4AY9taQqSEmsP` → `/webhooks/stripe` with the 5 events. **No successful test payment yet.** |
| Onboarding | Calendly `calendly.com/nnicholson80112` | `CALENDLY_URL` set. Webhook tracking not connected (needs a paid Calendly plan + `CALENDLY_TOKEN`). |
| Email | Postmark | **Not set up.** |
| Texts + calls | Twilio | **Not set up.** Needs A2P 10DLC registration (takes weeks). |
| Old account | Old Railway project (`api-production-5859`) | Deleted. |

### Railway services
- **api**: start `npm start` (builds the site, then `src/api/server.ts`). Public domain. Volume `/data`.
- **ai**: start `npm run ai` (`src/ai-service/server.ts`). No public domain. Volume `/data`.
- One `Dockerfile` (node:22-slim, no runtime dependencies). `railway.json` sets healthcheck `/health`.

### Railway variables (names only; values live in Railway, never in chat or git)
**api:** `PORT=8787`, `PUBLIC_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}`, `DATA_FILE=/data/landwell.json`, `TZ_DEFAULT=America/Denver`, `OWNER_API_TOKEN`, `ADMIN_API_TOKEN`, `AI_PROVIDER=http`, `AI_HTTP_URL=http://ai.railway.internal:8788/respond`, `AI_HTTP_TOKEN=${{ai.AI_SERVICE_TOKEN}}`, `DEV_TOOLS=true`, `SEED_DEMO=true`, `DEMO_OWNER_NAME=Nate`, `DEMO_OWNER_PHONE=+17209305782`, `DEMO_TENANT_PHONE=+13037481671`, `DEMO_VENDOR_NAME=GlassHouse Exteriors`, `DEMO_VENDOR_PHONE=+17209305782`, `DEMO_ADDRESS=7610 S Rosemary Cir`, `DEMO_CITY=Centennial`, `DEMO_ZIP=80112`, `DEMO_BEDS=3`, `DEMO_BATHS=2`, `DEMO_RENT=2750`, `STRIPE_SECRET_KEY` (sk_test), `STRIPE_WEBHOOK_SECRET` (whsec), `CALENDLY_URL`. Later: `CALENDLY_TOKEN`, `CALENDLY_WEBHOOK_SECRET`, `POSTMARK_TOKEN`, `EMAIL_FROM`, `EMAIL_WEBHOOK_SECRET`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`, `SEAM_API_KEY`.
**ai:** `PORT=8788`, `AI_SERVICE_TOKEN`, `AI_MODEL_PRIMARY=anthropic`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL=claude-sonnet-5-5`, `AI_LOG_DIR=/data/ai-logs`, `AI_LOG_RETENTION_DAYS=90`.
Random secret values: use the **Landwell Key Maker** page (link below) or a password manager. Anthropic key: 1-year expiry + a monthly spend limit in the Anthropic console.

### Stripe objects (sandbox)
- Products: Essentials `prod_VPtx6nniLpHo6w`, Autopilot `prod_VPtx79krZyWbO5`, Plus `prod_VPtxH4SJnH2U4F` (unit label "door").
- Active prices (found by lookup key `landwell_<plan>_<monthly|contract12>`): essentials monthly `price_1UP64XEtnoC4AY9tjidFr6K5` ($20), essentials contract12 `price_1UP64ZEtnoC4AY9twhNYocal` ($15), autopilot monthly `price_1UP64bEtnoC4AY9txWhFILVg` ($45), autopilot contract12 `price_1UP64eEtnoC4AY9tj1o9zoKe` ($35), plus monthly `price_1UP64gEtnoC4AY9tjS1hk5xT` ($70), plus contract12 `price_1UP64iEtnoC4AY9t43dRDXqO` ($60). Older prices are archived.
- To change a price: create a new price in Stripe, move the lookup key to it (`transfer_lookup_key`), and update `LIST_PRICE`/`BASE_PRICE`.

---

## 5. The codebase (`landwellv2`)

TypeScript on **Node 22.6+**, run with `--experimental-strip-types`. **No runtime dependencies** (Node built-ins only). ~4,750 lines in `src/`. **25 tests pass.**

```
npm test              # 25 tests: engine, guardrails, workflows end to end, API, billing, offers
npm run demo          # every workflow on sample data with a simulated month (86 runs, 0 failed)
npm start             # API + website on http://localhost:8787 (token: dev-token locally)
npm run ai            # AI service on :8788 (needs AI_SERVICE_TOKEN)
npm run typecheck     # tsc --noEmit (run `npm install` once for the dev types)
npm run build:site    # apps/site/site.body.html → apps/site/index.html
npm run build:review  # rebuilds apps/review/review.html from a fresh demo run
```

| Path | What it is |
| --- | --- |
| `src/engine/` | Durable workflow engine (waits for people, dates and events; survives restarts) + clock helpers |
| `src/workflows/` | The 15 workflows. `inbound-message.ts` (front desk: every text/email/call), `maintenance.ts`, `rent.ts`, `leasing.ts`, `tenancy.ts` (renewals, move-out, tenant welcome), `showings-listings.ts`, `owner.ts` (Monday report, onboarding, approval texts), `lib.ts` (messaging helpers, AI facts) |
| `src/ai/` | AI plug-in point: `guardrails.ts` (pre/post checks, fair housing, emergencies), `prompt.ts` (system prompt), `providers.ts` (Claude, HTTP, OpenAI-compatible), `rules.ts` (offline fallback) |
| `src/ai-service/server.ts` | The in-house AI service (`/respond`, `/stats`), logs to `/data/ai-logs` |
| `src/api/server.ts` | HTTP API, webhooks (Twilio SMS + voice, Postmark email, generic voice, screening, identity), apply form, lease signing page, `/play` |
| `src/api/billing-routes.ts` | Signup, Stripe checkout + webhook, `/offer/:id`, `/billing/done` → Calendly, Calendly webhook, `/admin` API |
| `src/billing/` | `stripe.ts` (Checkout, coupons, credits, event handling), `offers.ts` (prices, offer rules, floors, presets) |
| `src/adapters/` | Twilio, Postmark, Seam (locks), built-in e-sign, plus mocks |
| `src/config/` | `brand.ts`, `colorado.ts` (every Colorado rule with citations; **attorney review needed**) |
| `src/domain/types.ts` | All record types (Owner, Lease, Charge, Offer, …) |
| `src/store/store.ts` | JSON-file store (swap for Postgres: `db/schema.sql`) |
| `src/sim/` | Demo seed (7610 S Rosemary Cir, GlassHouse, Lisa Chen) and the end-to-end demo |
| `apps/site/` | Marketing website (edit `site.body.html`, then `npm run build:site`) |
| `apps/play/` | `/play` test console (owner token) |
| `apps/admin/` | `/admin` console: issue/revoke private offers, customers, Calendly connect (admin token) |
| `apps/review/` | Build review page (generated) |
| `docs/` | `WORKFLOWS.md`, `AI-PLUGIN.md`, `DEPLOY.md`, `OFFERS.md`, `RENAMING.md`, `demo-transcript.txt`, this file |

### The 15 workflows
Front desk (every inbound message) · Repair request · Daily rent check · Rent marked received · Late rent · Rental application · Lease and move-in · Showing · Listing · Renewal check · Renewal · Move-out and deposit · Tenant welcome · Monday owner report · New owner setup. Details: `docs/WORKFLOWS.md`.

### How messages flow (text, email, voice)
Inbound webhook on **api** → `message.received` → Front desk workflow → **guardrails** (emergencies, fair housing, accommodations, legal → owner) → **ai service** drafts a reply using only the owner's FACTS (Claude) → **guardrails check the draft** → reply sent + the right workflow starts (repair, showing, renewal…). If the AI is down, built-in rules answer.
- **Texts:** Twilio number → `POST /webhooks/twilio/sms`.
- **Calls:** same Twilio number → `POST /webhooks/twilio/voice` (speech-to-text, spoken replies, emergencies transferred to the owner's phone).
- **Email:** Postmark inbound → `POST /webhooks/email?key=EMAIL_WEBHOOK_SECRET`.
- Until Twilio/Postmark are connected, replies only appear in `/play`.

### Demo data (seeded on first start)
Owner **Nate** (phone `DEMO_OWNER_PHONE`, plan Autopilot). Home **7610 S Rosemary Cir, Centennial CO 80112**, 3 bed / 2 bath, $2,750, tenant **Lisa Chen** (`DEMO_TENANT_PHONE` = 303-748-1671), lease to 2027-02-14. Vacant listed home **88 Aspen Ct, Aurora** ($1,850, 2/1). Vendor **GlassHouse Exteriors** at 720-930-5782 (same phone as the owner; the code handles one phone being owner + vendor). Rent paid "by Zelle to the owner or check". Once Twilio is live, repair jobs **really text 720-930-5782**. Set `SEED_DEMO=false` when real owners sign up.

---

## 6. What was done (history)

**Old account (Oct 9–10):** research + plan doc (competitors: TurboTenant, RentRedi, Baselane, Avail, DoorLoop, Hemlane, Buildium, RentEngine, EliseAI; PM fee benchmarks; Colorado law), early dashboard mockup, first clickable demo, then the real build: website, durable engine, 15 workflows, AI plug-in, guardrails, Colorado rules, API + webhooks, lease signing, `/play`, Railway config. GitHub upload came through flattened; account move started.

**This account (Oct 10–11):**
1. Unpacked the handoff zip; verified 18 tests + demo + server locally.
2. Republished the website and a regenerated build review here; added `npm run build:review`.
3. Pushed the code to repo `landwellv2` (turned out to be public) with folders intact. Railway services `api` + `ai` deployed and online.
4. **Removed all rent collection** (Nate's decision): reminders with no pay links, owner confirms rent, owner decides on late fees, deposit statement + refund to-do. Website copy updated.
5. **Billing:** Stripe subscription checkout, webhook, month-to-month + 12-month plans, no setup fee.
6. **Private offers system** + `/admin` console + `/offer/:id` personal links + referral credits; research in `docs/OFFERS.md`.
7. **Calendly** redirect after checkout + optional booking webhook + one-click connect in `/admin`.
8. **Pricing model:** standard price above the offer price; then rounded to whole $5 amounts (table in section 3). Stripe prices updated, old ones archived.
9. **Live AI test** through the voice webhook: Claude answers repairs, rent, tours and pet questions well; fair-housing question safely deflected. Found and fixed (in code, **not yet deployed**): "Court" in street names / tenant named "Sue" / "hearing a noise" were wrongly routed to the owner; AI told a tenant to call 911 for a leak; listed homes weren't stated as available.
10. Name ideas (section 9).

---

## 7. Current issues (in priority order)

1. **Railway stopped auto-deploying.** The live app runs `ba5fce2`; commits `931e451`, `a95021d`, `931079a`, `bd20cc2`, `3740fa9` aren't live. **Cause found (Oct 14):** both services show the repo `landwellv2` + branch `main`, but say "Auto deploy unavailable" and "Could not load branches". Railway's GitHub app can't read the repo (it was likely only granted the deleted `Landwell` repo, and/or GitHub is asking Nate to verify his account). Fix: verify the GitHub account email, then GitHub → Settings → Applications → Railway → Configure → add `landwellv2`; then in Railway click Retry, and redeploy **api** and **ai**. A plain Redeploy rebuilds the old commit, so it doesn't help.
2. **Stripe payment never completed.** The test checkout (`cs_test_a1TN…`) expired unpaid. Redo: website Get started (or `/play` → Landwell subscription) → pay with `4242 4242 4242 4242` → confirm the webhook delivered, `/play` shows "active", and the redirect lands on Calendly.
3. **A test owner "Nate Test"** (`nnicholson80112+landwelltest@gmail.com`, `own_5ce576233a684a24`) exists from the signup test. Because there are now 2 owners, inbound messages with no matching line number can't pick an owner (real Twilio messages include the dialed number, so this only affects tests without `To`). Fine to keep for billing tests; remove before real use.
4. **Unprotected webhooks until Twilio/Postmark are connected:** with no `TWILIO_AUTH_TOKEN`, anyone can post to `/webhooks/twilio/*`. Acceptable for testing; set the token as soon as Twilio exists.
5. **AI says "I'm an automated assistant" in almost every reply.** Fine legally; consider saying it once per conversation.
6. **`OWNER_API_TOKEN` was the placeholder text** at one point; confirm it and `AI_SERVICE_TOKEN` are real random values now.

7. **The GitHub repo is public.** Fine for now (early prototype, no secrets in git), but **before anything is published or launched**, recreate it as a **private** repo. This happens as part of the account move below.
8. **Move everything to a new business identity before launch.** When the idea is fully fleshed out (and the name is picked), Nate will create a new business email/domain and move **GitHub, Railway, Stripe, Calendly, Anthropic, Postmark, Twilio** and any other integrations to it. Do the new GitHub repo as **private** at that time. Today's accounts (Nate's personal Gmail) are for testing only.

---

## 8. What's next (future state)

**This week (testing):**
1. Fix Railway auto-deploy (issue 1), then re-run the AI tests (section 10).
2. Finish the Stripe test (issue 2).
3. **Website + color refresh**: Nate will share his prompts later (save them as `docs/DESIGN-PROMPTS.md`). Edit `apps/site/site.body.html`, run `npm run build:site`, republish.
4. Pick the **name** → USPTO search (classes 9, 42, 36) → attorney knockout search → buy domain.

**To go live with real tenants:**
5. **Twilio**: buy a number, start **A2P 10DLC** registration now (weeks). Point SMS → `/webhooks/twilio/sms`, voice → `/webhooks/twilio/voice`; set `TWILIO_*`.
6. **Postmark**: account, verify domain, `POSTMARK_TOKEN`, `EMAIL_FROM`, inbound → `/webhooks/email?key=…`.
7. **Owner app (phone + browser)**: the biggest build left. The API it uses already exists (`/api/dashboard`, `/api/approvals`, `/api/charges/:id/received`, `/api/billing`, …).
8. **Postgres** (`db/schema.sql`) instead of the JSON file, **real login** instead of bearer tokens, backups, error alerts.
9. **Attorney review**: `src/config/colorado.ts`, `src/ai/guardrails.ts`, the sample lease, the signing page, the 12-month agreement, pricing/offer copy.
10. Partners: screening (adverse-action flow exists), ID check (e.g. Stripe Identity), Seam smart locks, Zillow listing feed.
11. **Founding client**: one full month on text + email before turning on voice.

**Phase 2:** listing syndication, smart-lock self-showings, voice line, Monday report polish, owner statements, Stripe live mode.

**Funding notes:** no forgivable SBA loans exist in 2026; grants (NSF SBIR, Colorado Advanced Industries) fund R&D, not ads; SBA microloans (≤$50k, repaid) can fund ads; talk to the local SBDC.

---

## 9. Name ideas (pick 2–3, then search)

| Style | Names (tagline) |
| --- | --- |
| Playful | **Keyfellow** ("Your rentals' right-hand guy"), **Porchbird** ("Your rentals, sorted before you wake up"), **Doorbuddy** ("The landlord's sidekick") |
| To the point | **Perdoor** ("One flat price per door"), **Doorkeep** ("Rentals, kept"), **OwnerDesk** ("Your front desk for every rental") |
| Hyper-memorable | **Okeydoor** ("Okey-dokey, it's handled"; top pick, no conflict found), **Tapprove** ("Tap. Approve. Done."; no conflict found), **Yesly** ("You just say yes"; likely crowded) |
| Artistic | **Lintel** ("The quiet beam over every door"; check an App Store app of that name), **Hearthwell** ("Rentals that run warm"; near Perchwell, Colorado real-estate software, and Hearth, home-services finance), **Quietdoor** ("Nothing to hear about") |

Quick web checks only. Next: USPTO search at tmsearch.uspto.gov in classes 9, 42, 36, then an attorney's search before buying a domain or registering Twilio.

---

## 10. How to test

**AI in `/play`:** open `<api domain>/play` → paste `OWNER_API_TOKEN` → Connect → choose **Send as** (Tenant · Lisa Chen, You (owner), a vendor, or New prospect + a made-up number) → type or pick a sample → Send. Replies appear under **Conversation**; decisions under **Waiting for you** (click, or text `YES CODE` as the owner); **Partner events** fake ID checks, screening reports and "owner marks rent received".

Good test messages: "The toilet won't stop running" (Lisa) · "Is the Aspen Court place available? Do you allow dogs?" (prospect: should answer, not route to owner) · "This is Sue, the dryer stopped working" (should book a repair) · "Are there good schools nearby?" (neutral answer + owner to-do) · "I smell gas" (emergency + 911) · "Water is pouring out from under the dishwasher" (emergency repair, no 911) · "We'd like to renew".

**Without a token** (what Claude did): `POST /webhooks/twilio/voice/turn` with form fields `From`, `To=+17205550199`, `CallSid`, `SpeechResult`; the response is TwiML whose `<Say>` is the AI's reply. Works only while `TWILIO_AUTH_TOKEN` is unset.

**Billing:** website Get started or `/play` → Landwell subscription → card `4242 4242 4242 4242`, any future date/CVC. `/admin` (admin token) → issue a Demo-day offer to `nate@example.com` → in `/play` pick the 12-month agreement and see the offer price.

---

## 11. Links and files

**Published pages (this Claude account, private until shared):**
- Landwell website: https://claude.ai/artifact/7MyLLQFsNM8xPgmkEnkwV1
- Landwell Build Review: https://claude.ai/artifact/JQ6zp9VgGQNWTtfk8tTs14
- Landwell Key Maker (random secret values, made in the browser): https://claude.ai/artifact/UHyKbTPkBVM5VAS8pBv2ka

**Old account (private to that account; superseded by this file):** product plan doc `claude.ai/code/artifact/11278c66-94ed-47d7-9a00-6dd0fe15edf0`, old website `claude.ai/artifact/26nzSnK5sZVwxK7vC9cnf5`, old build review `claude.ai/artifact/TRRKB4So6GwB3ZG8Qu2ess`, early clickable demo `claude.ai/artifact/JyrBo85Fsy8PUwjg7BMJqL`, early mockup canvas `claude.ai/artifact/KqcSEnBxZ1EYhwYxk54DAT`.

**Live app:** `https://api-production-66895.up.railway.app` (`/`, `/health`, `/play`, `/admin`).
**Repo:** `https://github.com/nnicholson80112/landwellv2`.
**Calendly:** `https://calendly.com/nnicholson80112` (consider a dedicated "Landwell onboarding" event).
**Original handoff zip** (`landwell-handoff.zip`): `00-START-HERE.md`, `PROJECT-BRIEF.md`, `CURRENT-STATUS-AND-ISSUES.md`, `CONVERSATION-SUMMARY.md`, `code/landwell/`, `demos/` (old website, build review, test console, early owner-app demo and mockup). Everything in it is reflected here; the code in this repo supersedes it.
**Screenshots shared so far:** Railway "Could not load public networking" (resolved; domain now loads) and the `OWNER_API_TOKEN` placeholder (issue 6). No design images yet.

**Colorado rules built in (attorney to review):** repairs start within 24h (health/safety) or 72h (SB24-094); late fee only after 7 days, capped at the greater of $50 or 5% (SB21-173); 10-day nonpayment demand (owner decides, software never files); all-in advertised rent and a free payment method (HB25-1090; the owner provides the free method); deposit back within 30 days (HB25-1249); for-cause non-renewal with ~90 days' notice (HB24-1098); one rent increase per 12 months (HB21-1121).
