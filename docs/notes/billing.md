# Billing that matches the KeyHelm Stripe catalog, and sets Stripe up by itself

Branch `kh/billing` (from `kh/integrate`). KeyHelm's code now uses Nate's Stripe catalog (plans, prices,
lookup keys), and when a Stripe key is set the api service creates whatever catalog objects are missing.
**Nothing here charges anyone.** The setup only creates products, prices, a webhook endpoint and customer
portal settings. KeyHelm still never touches rent, deposits or vendor payments.

## Plans and prices

| Plan id | Shown as | Standard, month-to-month | Standard, 12-month | Offer price, month-to-month | Offer price, 12-month | Floor |
| --- | --- | --- | --- | --- | --- | --- |
| `essentials` | Essentials | $10 | $8 | $8 | $6 | $5 |
| `autopilot` | Autopilot | $15 | $12 | $12 | $10 | $8 |
| `pro` | Autopilot Pro | $20 | $16 | $16 | $13 | $10 |

Per door per month, cents in code: `LIST_PRICE` (standard, must match Stripe), `BASE_PRICE` (offer price,
what "original price" offers land on), `PRICE_FLOOR` in `src/billing/offers.ts`. The FTC guardrails are
unchanged: offers are private, capped, time-limited and never stack; the standard price stays the real price.

**Old id `plus`.** The plan id `plus` is now `pro` everywhere in code and tests. `plus` (and the names
"Autopilot Plus" / "Autopilot Pro", any case) is still accepted as input on `POST /api/public/signup`,
`POST /api/billing/checkout`, `GET /api/offers?plan=`, `POST /api/admin/offers` (`plans`), and when reading
old records (owner plan, billing plan, offer plans, subscription metadata). It is never written: billing
events write `pro` back to the owner. The term `annual` is accepted as an alias for `contract12` the same way.
All of this lives in `src/billing/plans.ts` (`asPlanId`, `asTermId`, `PLAN_NAMES`, `PLAN_CONTENTS`).

## Stripe lookup keys

`keyhelm_<essentials|autopilot|pro>_<monthly|annual>`. Inside KeyHelm the 12-month agreement is still
`BillingTerm = 'contract12'`; in Stripe it's `annual` (billed monthly). Checkout picks the active price in this
order, so old prices keep working until new ones exist: `keyhelm_<plan>_<monthly|annual>`, then
`keyhelm_<plan>_contract12`, then (pro only) `keyhelm_plus_<term>`, then `landwell_<plan>_<term>`
(`landwell_plus_*` = pro). Webhooks read all of these keys too (`planTermFromLookupKey`).

## What happens at boot (`src/billing/catalog.ts`)

`src/api/server.ts` calls `startStripeSetup()` once, without waiting for it. It runs only when
`STRIPE_SECRET_KEY` is set and `STRIPE_AUTO_SETUP` isn't `false`. Each step is independent: a failure is
logged (`Stripe setup (live): catalog failed: ...`) and the server keeps running. When done it logs one line,
e.g. `Stripe setup (live): ready; 11 thing(s) created.` The last report (no secrets) is saved in kv
`stripe/setupReport` and returned as `stripeSetup` by `GET /api/admin/overview`.

1. **ensureCatalog.** Reads the prices that hold the 6 lookup keys (active or archived).
   - Active price there: nothing is made. If its amount isn't `LIST_PRICE` (or it isn't USD monthly), a warning is
     logged; nothing is changed, and checkout charges what Stripe has.
   - Archived price holds the key: warning, nothing made (a lookup key can't be reused while an archived price
     holds it, and KeyHelm never edits existing prices). Fix: unarchive it or remove its lookup key in Stripe.
   - No price: KeyHelm uses the plan's product (the one its other price uses, or a product with metadata
     `brand=keyhelm`, `plan=<id>`), or creates it: name "KeyHelm Essentials" / "KeyHelm Autopilot" /
     "KeyHelm Autopilot Pro", unit label `door`, description = the plan contents, metadata `brand`, `plan`
     (type is Stripe's default, service; the parameter isn't sent because newer API versions dropped it). Then it
     creates a recurring monthly USD price at `LIST_PRICE` with the lookup key, a nickname like
     "Autopilot, 12-month agreement, per door", and metadata `brand`, `plan`, `term` (`monthly`/`annual`).
   - Never modifies, archives or deletes a price or product. A second run creates nothing.
2. **ensureWebhook.** Endpoint URL = `PUBLIC_URL/webhooks/stripe` (skipped unless `PUBLIC_URL` is a public https
   address). Events = exactly `BILLING_EVENTS`, the five `applyBillingEvent` handles: `checkout.session.completed`,
   `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`.
   - `STRIPE_WEBHOOK_SECRET` set and a hand-made endpoint points at this URL: does nothing (today's sandbox setup).
   - Otherwise it manages its own endpoint (metadata `keyhelm=true`): if that endpoint's secret is stored, it's
     kept (its events are put back if someone changed them). If not (new key, new database), a new endpoint is
     made, its signing secret is stored in kv `stripe/webhookSecret` (endpoint id in `stripe/webhookEndpoint`),
     and KeyHelm's older endpoints for this URL are deleted. Endpoints KeyHelm didn't make are never touched.
   - The webhook route accepts a signature from `STRIPE_WEBHOOK_SECRET` or the stored secret.
   - One small addition to the brief: if `STRIPE_WEBHOOK_SECRET` is set but no endpoint at all points at this URL in
     the key's mode (what happens right after switching to a live key), it still makes its own. Otherwise a
     forgotten sandbox `whsec_` would silently break live billing.
3. **ensurePortal.** If the account has default portal settings (saved in the Stripe dashboard), those are used.
   Otherwise KeyHelm's own settings are found (metadata `keyhelm=true`) or created: headline "KeyHelm billing",
   update payment method, invoice history, cancel at the end of the period, return to `PUBLIC_URL/app`, links to
   `/privacy` and `/terms`. No plan switching in the portal. The id is kept in kv `stripe/portalConfiguration`
   (with its mode, so a sandbox id is never used with a live key).

## Owner API addition

`POST /api/billing/portal` (owner auth like the other `/api/billing` routes: bearer token, or cookie +
`X-KeyHelm: 1`). No body.
- 200 `{ url }`: a Stripe billing portal page for the owner's own Stripe customer; it returns to `PUBLIC_URL/app`.
- 409 `{ error: "There is no KeyHelm subscription on this account yet. Choose a plan first, then you can manage billing here." }` when the owner has no Stripe customer.
- 503 without `STRIPE_SECRET_KEY`; 502 `{ error }` when Stripe refuses (for example a sandbox customer after the switch to live).

`GET /api/billing` also returns `planNames` and `canManageBilling` (true when the portal works). Plans in its
response are always `essentials | autopilot | pro`. `GET /api/admin/overview` adds `planNames` and `stripeSetup`.

## Checkout wording

Shown above Stripe's pay button (`checkoutTerms()` in `src/billing/stripe.ts`), same meaning as before with the
new names:
- 12-month: "KeyHelm Autopilot Pro, 12-month agreement: you are agreeing to a 12-month KeyHelm agreement, billed
  monthly per door. Your first month is charged today and each month after until the agreement ends."
- Month-to-month: "KeyHelm Essentials, month-to-month: your first month is charged today, then this plan renews
  automatically every month at the price shown until you cancel. Cancel anytime by emailing us; it takes effect at
  the end of the paid month."

Coupons, private offers, referrals and credits work as before (coupon = Stripe price minus `BASE_PRICE`, per door).

## Railway variables this reads (api service; names only)

- `STRIPE_SECRET_KEY`: turns billing on, and the boot setup.
- `STRIPE_WEBHOOK_SECRET`: optional now. Leave it empty and the server makes the webhook and keeps the secret.
- `STRIPE_AUTO_SETUP`: optional. `false` = never create anything in Stripe at boot.
- `PUBLIC_URL`: the webhook address, portal return address, checkout return addresses.
- `ADMIN_API_TOKEN`: unchanged (admin routes).

## Switching from the sandbox (sk_test) to live (sk_live)

Exact clicks:
1. Stripe: finish activating the account first (see "Stays manual" below), then switch the dashboard to live
   mode, Developers, API keys, reveal the **Secret key** (`sk_live_...`). Don't paste it anywhere but Railway.
2. Railway: project, **api** service, **Variables**. Set `STRIPE_SECRET_KEY` to the live key. **Delete**
   `STRIPE_WEBHOOK_SECRET` (it belongs to the sandbox endpoint). Railway redeploys.
3. Railway, api, **Deployments**, newest, **View logs**, search `Stripe setup`. Expect
   `Stripe setup (live): ready; 11 thing(s) created.` (3 products, 6 prices, 1 webhook, 1 portal setup).

What the server does by itself on that boot: live mode starts empty, so it creates the three KeyHelm products,
the six prices at `LIST_PRICE` with the right lookup keys, the live webhook endpoint (and stores its secret), and
the portal settings. Next boots find everything and create nothing. If step 2's delete is forgotten, it still
works: no endpoint points at the server in live mode, so it makes its own and both secrets are accepted.

Before real customers: the sandbox owners keep sandbox Stripe ids (`customerId`, `subscriptionId`) that don't exist
in live mode. Clear the test data (HANDOFF issue 9) or `SEED_DEMO=false` on a fresh database.

A restricted key (`rk_live_...`) also works if it can write Products, Prices, Webhook Endpoints, Customer portal,
Checkout Sessions, Coupons and Customers.

## Stays manual in Stripe (the code can't or shouldn't do these)

- **Activate the account**: business details (KeyHelm LLC, EIN, address), identity verification of the
  representative, the **bank account for payouts**, and accepting Stripe's terms. Live charges can't happen
  before this.
- **Statement descriptor** (what appears on card statements, e.g. `KEYHELM`) and the shortened descriptor:
  Settings, Business, Public details.
- **Branding** for Checkout, the portal, invoices and receipts: logo, icon, brand color (`#1B4DFF`), accent
  (`#FFC83D`): Settings, Branding.
- **Public business info**: support email/phone, website, terms and privacy URLs (Settings, Public details).
- **Customer emails** (receipts, failed-payment and card-expiring emails) and **Revenue recovery** (Smart Retries,
  what happens after failed payments): Settings, Billing.
- Tax settings, if KeyHelm ever needs to collect sales tax on the subscription.
- Saving portal settings in the dashboard is optional: if Nate does, those become the default and win.

## Files

| File | What |
| --- | --- |
| `src/billing/plans.ts` (new) | Plan ids, names, contents, `plus`/`annual` aliases, lookup keys (current and old) |
| `src/billing/catalog.ts` (new) | `ensureCatalog`, `ensureWebhook`, `ensurePortal`, `startStripeSetup`, `webhookSecrets`, `portalConfiguration` |
| `src/billing/stripe.ts` | `pro` plan, new lookup keys + old ones, `stripeCall` (shared, 20 s timeout), `portalSession`, `checkoutTerms`, `plus` → `pro` on events |
| `src/billing/offers.ts` | New prices and floors, plan aliases in offer rules, display names in messages |
| `src/api/billing-routes.ts` | Aliases on inputs, `POST /api/billing/portal`, webhook route accepts the stored secret, plan names on the offer page, overview additions. `GET /billing/done` untouched. |
| `apps/admin/index.html` | Plan names only (Autopilot Pro, `prices.pro`, customer plan names) |
| `tests/billing-golive.test.ts` (new) | 9 tests, every Stripe call to an in-memory fake |

Shared-file edits: `src/domain/types.ts` (three `'plus'` → `'pro'` literals), `src/api/server.ts` (one import +
one `void startStripeSetup(...)` call in the main block, after seeding), `tests/offers.test.ts` and
`tests/billing.test.ts` (new prices and `pro`), `docs/OFFERS.md` (price table, keys), `docs/DEPLOY.md` (webhook
row, keys), `.env.example` (`STRIPE_AUTO_SETUP`, comments).

## Known limits

- The website (`apps/site`) and `/play` still show the old prices and send `plus`; `plus` works as an alias, but
  the site's prices and the name "Autopilot Plus" need the site owner's update.
- The portal lets a 12-month-agreement owner cancel at the end of the paid month; the agreement's early-cancel terms
  aren't enforced by Stripe.
- The referral reward is still a $50 credit (`REFERRAL_CREDIT_CENTS`), large next to $8-$20 per door. Nate's call.
- Two api instances sharing one database during a deploy: if the new one makes a new webhook, the old one refuses
  those events until it stops; Stripe retries them, so nothing is lost.
- The Stripe API version is the account's default (not pinned), same as before.
