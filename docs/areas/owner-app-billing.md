# Area 3: Signup, billing and the owner app

**Subagents:** `owner-app-engineer` (the owner app at `/app`, sign-in, the owner API, the admin page),
`billing-engineer` (Stripe: prices, checkout, webhook, billing portal, offers, referral credit).
The customer walks one path, so test it as one path: website **Get started** → Stripe Checkout →
`/billing/done` → set a password → `/app`.

**Deeper notes:** `docs/notes/owner-ui.md`, `docs/notes/owner-api.md`, `docs/notes/billing.md`,
`docs/OFFERS.md`.

## Goals

- [x] Owner app `/app` (phone first, add to home screen): Today, Rent, Repairs, Messages, Homes,
      Settings; decisions with inputs; rent received; replies to tenants; homes, tenants, vendors,
      rules, lease upload; setup checklist; **Book your onboarding call**.
- [x] Real sign-in: email and password (scrypt), hashed session cookie (`kh_session`, 30 days),
      one-time sign-in links, forgot password (needs Postmark), CSRF header `X-KeyHelm: 1` plus
      same-origin check, per-owner data isolation (another owner's records are 404).
- [x] Billing on the KeyHelm Stripe catalog: Essentials $10/$8, Autopilot $15/$12, Autopilot Pro
      $20/$16 per door (month-to-month / 12-month agreement). Lookup keys `keyhelm_<plan>_<monthly|annual>`.
      On boot the server creates any missing prices, the webhook and the billing portal
      (`src/billing/catalog.ts`); it never changes or archives existing prices.
- [x] **Manage billing** button → Stripe billing portal (`POST /api/billing/portal`).
- [x] Admin page `/admin`: customers, sign-in links, private offers, Calendly connect.
- [ ] **Not live yet** (deploy of `270af79`, infrastructure.md).
- [ ] **One full test-mode purchase on the live site** after the deploy: card `4242 4242 4242 4242`,
      then set a password, sign in, add a home, sign out, sign back in (live-testing.md).
- [ ] Nate signs in for the first time through `/admin` → **Sign-in link** (HANDOFF go-live step 1).
- [ ] Stripe live mode (Nate's clicks in HANDOFF go-live step 7). The server creates the live prices,
      webhook and portal itself.
- [ ] **12-month early-cancellation charge** is invoiced by hand in Stripe today. Optional: automate it
      (charge = (month-to-month price − agreement price) × months used).
- [ ] **Referral credit is $50** (`REFERRAL_CREDIT_CENTS` in `src/billing/offers.ts`), large next to
      $8 to $20 per door. Nate's call whether to lower it.
- [ ] Archive the old "Landwell" products and prices in the Stripe sandbox (unused; only confusing).
- [ ] Owner app gaps: PDF/Word lease upload (plain text only today), delete a lease, a "Publish listing"
      button, an `apple-touch-icon` PNG, two-step sign-in, email verification at signup.

## Where things stand (Oct 21)

On `main` (`270af79`), not live yet. Stripe sandbox (account `acct_1Sf7x1EtnoC4AY9t`, test mode) already
has the six KeyHelm prices at the right amounts (checked Oct 20) and one webhook endpoint pointing at
`https://api-production-66895.up.railway.app/webhooks/stripe` (5 events). Because `STRIPE_WEBHOOK_SECRET`
is set in Railway and that endpoint exists, the server's self-setup leaves the webhook alone.

## Files

| Path | What |
| --- | --- |
| `apps/owner/index.html`, `manifest.webmanifest`, `icon.svg` | The owner app (self-contained, no outside requests) |
| `apps/admin/index.html` | `/admin` |
| `src/api/auth.ts` | Passwords, sessions, sign-in links, CSRF, safe redirects |
| `src/api/owner-routes.ts`, `owner-data.ts`, `owner-pages.ts` | Owner API, decision checks, `/login` and other pages |
| `src/api/billing-routes.ts` | Signup, checkout, `/billing/done`, Stripe webhook, billing portal |
| `src/billing/plans.ts`, `offers.ts`, `stripe.ts`, `catalog.ts` | Plans, prices (`LIST_PRICE`, `BASE_PRICE`, `PRICE_FLOOR`), Stripe calls, self-setup |
| `scripts/check-owner-app.mjs` | Browser click-through of the owner app (local Chromium) |
| Tests | `owner-api`, `owner-ui`, `billing`, `billing-golive`, `offers` |

## Rules for this area

- KeyHelm bills only its own subscription. Never rent, deposits or vendor payments.
- `LIST_PRICE` and `BASE_PRICE` in `src/billing/offers.ts` must match Stripe and the website.
- Money in the API is cents; the app shows dollars. Dates in the owner's time zone.
- Every change request from the app sends `X-KeyHelm: 1`; the server refuses changes without it.
- A person must never get a sign-in link to someone else's account (`/billing/done` only hands a link to a
  brand-new paying account; everything else goes by email).
- Never charge real cards from a chat. Test mode only (`sk_test`), card 4242.

## How to check your work

```
npm test && npm run typecheck
npm start                                  # http://localhost:8787/app (sign in via /admin link locally)
node scripts/check-owner-app.mjs           # clicks through every screen in Chromium
```
Stripe sandbox reads (prices, webhooks, subscriptions) can be done with the Stripe connector in the chat
(account `acct_1Sf7x1EtnoC4AY9t`, livemode false).

## Questions only Nate can answer

- Lower the $50 referral credit? Automate the early-cancel charge, or keep it manual for now?
