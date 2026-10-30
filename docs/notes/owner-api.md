# Owner sign-in and the owner API

Branch `kh/owner-api`. Owners can now sign in with an email and password, and the owner app
(`apps/owner/`, built next) has a complete, checked JSON API to work from.

## What was built

| File | What it does |
| --- | --- |
| `src/api/auth.ts` | Password hashing (scrypt), sessions (cookie `kh_session`), one-time links, CSRF check, sign-in limits |
| `src/api/owner-routes.ts` | Sign-in pages, admin sign-in link, after-checkout handling, and every owner API route |
| `src/api/owner-data.ts` | Input checks with plain-words errors, setup checklist, default rules, decision forms, message threads |
| `src/api/owner-pages.ts` | Branded server pages: sign in, set password, forgot password, after checkout, `/app` placeholder |
| `tests/owner-api.test.ts` | 12 tests (see the bottom) |

Small edits to shared files:
- `src/domain/types.ts`: `Owner` gets optional `passwordHash`, `passwordSetAt`, `lastLoginAt`.
- `src/api/server.ts`: `Req.auth` field; `ownerOf()` accepts a bearer token (as before) or the session cookie
  (+ CSRF rule); only a request that presented credentials counts toward the failed-sign-in limit; dashboard
  never returns `passwordHash`; one `registerOwnerRoutes({ route, json, html })` call. The old owner POST/PUT
  handlers (approvals, charges received, properties, tenants, vendors, rules, lease templates, work orders)
  moved into `owner-routes.ts`, with checks added.
- `src/api/billing-routes.ts`: only `GET /billing/done` (see "After checkout").
- `apps/admin/index.html`: a new "Sign-in link" card plus its own small script (nothing existing changed).
- `apps/play/index.html`: `decide()` shows the server's reason when a decision is refused and asks for a showing
  time or deposit deductions (the API now requires them).
- `tests/offers.test.ts`: the `/billing/done` assertions now expect the new flow (changed on purpose).

## How sign-in works

- **Passwords**: salted scrypt (N=16384, r=8, p=1, 64-byte key), compared in constant time. At least 10 characters.
  A wrong email takes as long as a wrong password (a dummy hash is checked), and the message is the same.
- **Sessions**: a random 32-byte token in cookie `kh_session` (`HttpOnly; SameSite=Lax; Path=/`, plus `Secure` when
  `PUBLIC_URL` starts with https). Only a SHA-256 of the token is stored (kv `sessions`). Lasts 30 days and slides:
  using the app extends it (at most once a day, the cookie is re-sent). Setting or resetting a password signs out
  every other device.
- **One-time links** (kv `loginLinks`, stored hashed): `/login/link/:token`. Single use (used up only when the
  password form is submitted, so email link scanners can't burn them). 7 days for setup and admin links, 1 hour for
  "forgot password" links. A new link cancels the owner's older unused ones.
- **CSRF**: when a request is signed in with the cookie and changes something (anything but GET/HEAD), it must
  send `X-KeyHelm: 1`, and `Origin` (or `Referer` when there's no Origin) must be this site. Otherwise 403.
  Bearer-token calls (`/play`, scripts) work exactly as before and don't need the header.
- **Sign-in limits**: per IP (`RL_LOGIN_IP_PER_HOUR`, default 30) and per email (`RL_LOGIN_EMAIL_PER_HOUR`,
  default 10), using the existing `RateLimiter`. Also used for forgot-password and link posts.
- **No account enumeration**: sign-in errors, forgot-password answers and timing are the same whether or not an
  email has an account.

## After checkout (`GET /billing/done?session=cs_...`)

1. Owner found by their checkout session. Already has a password → `303 /app`.
2. Payment not confirmed yet (webhook hasn't arrived and Stripe's API doesn't say `complete` + `paid` for this owner)
   → a "Finishing up" page that refreshes itself every 3 seconds for about a minute, then says to check email.
3. New account (no homes, tenants, vendors or lease yet, paid in the last 14 days) → a fresh one-time setup link is
   made on the server and the browser goes straight to it (`303 /login/link/<token>`). They pick a password and land
   in `/app`.
4. Account that already has data (or an old checkout) → the link is **emailed** to the address on file instead (or
   "email support" if email isn't set up), so a checkout URL alone can never open an account with someone's data.

The Calendly link the handler used to redirect to is now `onboarding.calendlyUrl` in `GET /api/me` (same URL:
name, email, `utm_source=keyhelm`, `utm_campaign=onboarding`, `utm_content=<ownerId>`). Until `apps/owner` exists,
`/app` shows a simple page with a **Book your onboarding call** button.

## Pages

| Route | What |
| --- | --- |
| `GET /login?next=/app` | Sign-in form. Already signed in → `303` to `next` (only paths on this site). |
| `POST /login` | Form (`email`, `password`, `next`) → `303 next` + cookie, or the form again with an error (401/429/403). JSON body → `200 {ok, next}` or `{error}`. |
| `POST /logout` | Ends this session (`all=true` in the body or `?all=1`: every device). Form → `303 /login?signed_out=1`; JSON → `{ok:true}`. Refused (403) from another website. |
| `GET /login/link/:token` | "Create your password" (setup) or "Choose a new password" (reset). Expired/used → 410 page. |
| `POST /login/link/:token` | `password`, `confirm` → sets it, signs in, `303 /app` (JSON: `{ok, next}`). |
| `GET /forgot`, `POST /forgot` | `email` → with email set up, a 1-hour link by email; always the same answer. JSON → `{ok:true, emailSent}` (whether email is set up, not whether the account exists). |
| `GET /app` | Signed out → `302 /login?next=%2Fapp`. Signed in → `apps/owner/index.html` if it exists, else the placeholder. |

## Admin

`POST /api/admin/owners/:id/login-link` with `Authorization: Bearer <ADMIN_API_TOKEN>` →
`201 { url, expiresAt, purpose: "setup" | "reset", owner: { id, name, email } }`. 401 without the token, 404 for an
unknown owner. In `/admin`: **Sign-in link** card → pick the customer → **Make sign-in link** (copied).

## Owner API contract

**Auth**: cookie `kh_session` (send `X-KeyHelm: 1` on POST/PUT/PATCH/DELETE) or `Authorization: Bearer <token>`.
401 `{error}` when not signed in (a dead cookie is also cleared). 403 `{error}` for a failed CSRF check.

**Errors**: always `{ "error": "Plain sentence.", "field"?: "name" }`. 400 bad input, 404 not found or not yours
(other owners' records are always 404), 409 conflict (duplicate, already decided, blocked delete), 429 too many.

**Money**: request fields are **dollars** (`2750`, `2750.5`, `"$2,750.50"`); stored records and responses are
integer **cents**. **Dates**: `YYYY-MM-DD`; timestamps ISO UTC. **Lists** default to everything; `?status=` filters.

### Profile
- `GET /api/me` →
  ```
  { owner: { id, name, email, phone, timezone, lineNumber, lineEmail, smsConsent, hasPassword, lastLoginAt, createdAt },
    plan: { id: "essentials"|"autopilot"|"pro", name: "Essentials"|"Autopilot"|"Autopilot Pro" },
    billing: { status, plan, planName, term, termLabel, doors, startedAt, contractEndsAt, canceledAt } | null,
    onboarding: { status: "not_booked"|"booked"|"canceled"|null, startTime, calendlyUrl,
                  steps: [{ key: "homes"|"lease"|"tenants"|"vendors"|"rules"|"howToPay", title, done }], done, total, complete },
    counts: { homes, tenants, vendors, pendingApprovals, openTasks, openWorkOrders },
    signedInWith: "session"|"bearer", support: { email } }
  ```
  (`plus` is shown as `pro`.) Also closes any setup to-dos whose data now exists.
- `PATCH /api/me` `{ name?, phone?, email?, smsConsent? }` → same shape as GET. Changing email when signed in with
  the cookie needs `password` (current). Phone and email must not belong to another owner (409).
- `POST /api/me/password` `{ currentPassword, newPassword }` → `{ ok: true }`; signs out other devices.

### Rules
- `GET /api/rules` → the rules (cents) + `saved` (owner has saved them), `savedAt`, `coloradoLateFee { minDaysLate, flatCapCents, percentCap }`.
  A new owner gets safe defaults (repair limit $150, emergency $500, no late fee, owner-led showings, quiet 9 PM to 8 AM).
- `PUT` (or `PATCH`) `/api/rules`, any of: `repairSpendLimit`, `emergencySpendLimit`, `lateFee` (dollars),
  `rentDueDay` (1-28), `graceDays` (0-30), `howToPay`, `autoLateNotice`, `petPolicy`, `showingMode` (`self|owner|both`),
  `showingHours` / `quietHours` (`{start:"09:00", end:"19:00"}`), `renewalLeadDays` (90-365), `alwaysRouteToOwner`
  (words), `facts` (`{name: value}`), `screeningCriteria` (`[{key, label, value}]`, keys `income_multiple`
  (1-5), `evictions_years`, `collections_years`, `references`, `pets`, `custom`). Text the AI may quote (pet policy,
  facts, how to pay, criteria) is checked against the fair-housing ad list: "Adults only", "no kids", "perfect for
  singles"… → 400.

### Homes
- `GET /api/properties` → `[Property + { tenants: [{id, name, status}], lease: {id, startDate, endDate, rent, deposit, tenantIds} | null, canDelete }]`
- `POST /api/properties` `{ address, city, zip, beds, baths, rent, deposit?, state?="CO", status?="occupied"|"vacant"|"turnover", lock?: {kind:"smart"|"lockbox"|"none", deviceId?, lockboxCode?}, facts? }` → 201.
  Colorado only (ZIP 80xxx/81xxx). Same address + ZIP twice → 409. `status: "listed"` is refused (use `POST /api/listings/:propertyId`, which checks the ad).
- `PATCH /api/properties/:id` (same fields, any subset) → 200. Moving a listed home to another status takes the listing down.
- `DELETE /api/properties/:id` → `{ok, id}`. 409 while it has a live lease, current tenants, open applications, booked showings or an open repair.
- `PATCH /api/properties/:id` also takes `homeGuide: { welcome?, contacts?, rules?, tips? }`. It's shown on My Home and given to the AI for that home's tenants only, never for prospects, and it goes through the fair housing check.

### Tenants
- `GET /api/tenants?status=active|former|future` → `[Tenant + { propertyAddress, lease: {id, startDate, endDate, rent, deposit} | null, textsOff }]`
- `POST /api/tenants` `{ propertyId, name, phone?, email?, preferredChannel?, language?, autopay?, status?="active"|"future", invite?=true, lease?: { startDate, endDate, rent, deposit? } }` → 201.
  Needs a phone or email; not the owner's own number; no duplicate among current tenants (409). If the home has an
  active lease the tenant joins it (the `lease` field is ignored); otherwise `lease` creates the active lease so rent
  reminders and renewals work. `invite` sends the welcome text (quiet hours respected).
- `PATCH /api/tenants/:id` `{ name?, phone?, email?, preferredChannel?, language?, autopay?, forwardingAddress? }` (home and status can't change here).
- `POST /api/tenants/:id/former` `{ forwardingAddress? }` → marks them former. When everyone on the lease is former,
  the lease is marked ended (rent reminders stop) and an occupied home becomes `turnover`.
- `POST /api/tenants/:id/my-home` `{ fresh? }` → `{ url }`, the tenant's private My Home link. `fresh: true` replaces it and turns the old one off. Former tenants get a 400, and their old link stops working.

### Vendors
- `GET /api/vendors` → `[Vendor]`
- `POST /api/vendors` `{ name, trades?: ["plumbing", ...], phone?, email?, emergency?=false, preferred?=true }` → 201 (phone or email needed; no two vendors with one phone).
- `PATCH /api/vendors/:id` (any subset) · `DELETE /api/vendors/:id` (409 while they have an open repair).

### Lease templates
- `GET /api/lease-templates` → `[LeaseTemplate]` newest first (`body` with `{{fields}}`, `fields`).
- `POST /api/lease-templates` `{ name?, text }` (plain text, 100 to 200,000 characters; a `text/plain` body works too) → 201.

### Decisions
- `GET /api/approvals?status=pending|decided|expired` → newest first:
  `Approval + { choices: [{value, label}], decisionLabel, fields: Field[] }` where
  `Field = { name, label, type: "dollars"|"months"|"text"|"date"|"deductions", forOption, in?: "data"|"note", group?, required, value?, min?, max?, readOnly?, help? }`.
  Show a field when the owner picks `forOption`. Put it in `data[name]`, or `data[group][name]` when `group` is set,
  or the top-level `note` when `in` is `"note"`.

  | kind | choice | fields |
  | --- | --- | --- |
  | `renewal_terms` | `offer_renewal` | `rent` (dollars, read-only when Colorado's once-a-year limit applies), `months` |
  | `deposit`, `deposit-final`, `deposit-list` | `deductions_entered` | `deductions`: `[{reason, amount}]` (dollars), at least one |
  | `lease_fields` | `send` | one text field per blank, `group: "values"` |
  | `showing_request` | `confirm` | `note` (required, a day and time like "Sat 10am") |
  | `rent_check` | `received` | `amount` (dollars, only if part arrived) |
  | `application` | `approve` | `startDate`, `months` (both optional) |
- `POST /api/approvals/:id` `{ decision, note?, data? }` → the updated approval (same view). Only the checked fields
  above reach the workflow (dollars become cents); anything else in `data` is dropped. 409 if already decided.

### To-dos, rent, repairs
- `GET /api/tasks?status=open|done` → open first, by due date: `Task + { setupStep: StepKey | null }`.
- `POST /api/tasks/:id/done` → the task.
- `GET /api/charges?status=open|paid|void` → `Charge + { balance, label: "Rent for November 2026", propertyId, propertyAddress, tenantNames }`.
- `POST /api/charges/:id/received` `{ amount? }` (dollars; default: everything still owed) → the charge. KeyHelm only
  records what the owner says arrived; it never moves money. More than owed → 400; already paid → 409.
- `GET /api/work-orders?status=open|closed` → newest first: `WorkOrder + { open, vendorName, vendorPhone, propertyAddress, tenantName }`.
- `POST /api/work-orders` `{ propertyId, tenantId?, summary, trade?, urgency?="routine"|"urgent"|"emergency", photos?: [https urls] }` → `202 { ok, workOrder | null }` (null when it joined an open job).

### Messages
- `GET /api/messages/threads` (`?all=1` also shows KeyHelm's texts to the owner) →
  `[{ key, contact: { role: "tenant"|"vendor"|"prospect"|"applicant"|"unknown", id?, name, propertyId?, propertyAddress?, phone?, email? }, channel, count, last: { body, at, direction, sentBy }, needsReply, textsOff }]`, newest first.
- `GET /api/messages/threads/:key` (key = phone in +1 format or email, URL-encoded) → `{ key, contact, textsOff, messages: [{ id, direction, channel, body, media, at, from, to, sentBy: "contact"|"keyhelm"|"owner" }] }`.
- `POST /api/messages/send` `{ to, body, channel?: "sms"|"email" }` → `201 { message, key }`. Only people on the
  owner's account (tenants, vendors, prospects, applicants, anyone who wrote in), else 404. Texts start with the
  owner's first name ("Nate: ...") so people can tell the owner from the assistant. A number that replied STOP → 409
  (send `channel: "email"` instead). Limit `RL_OWNER_SEND_PER_HOUR` (default 60).

### Activity
- `GET /api/activity?limit=50&before=<ISO>` → `[{ id, at, actor, action, detail, workflow }]`, newest first (limit 1-200).

Unchanged and still working: `/api/dashboard`, `/api/billing`, `/api/billing/checkout`, `/api/offers`,
`/api/listings/:propertyId`, `/api/applications/:id/report`, `/api/workflows`, `/api/runs`, `/api/dev/*`, and the
plain lists `/api/leases`, `/api/payments`, `/api/expenses`, `/api/applications`, `/api/showings`, `/api/messages`, `/api/audit`.

## Two-step sign-in, team and devices (branch `kh/owner-dashboard`)

- **Two-step sign-in** (`src/api/totp.ts`, RFC 6238 with `node:crypto`, no dependencies): 6-digit codes from any
  authenticator app, 30-second steps, one step of clock drift either way, and each code works once (`totpLastStep`).
  After the password, `/login` hands out a 10-minute ticket (5 tries) and shows the code page; `POST /login/code`
  finishes sign-in. A password reset also asks for a code when two-step is on.
  - `GET /api/me/two-step` → `{ enabled, enabledAt }` · `POST /api/me/two-step/setup` → `{ secret, uri }` (pending until
    confirmed) · `POST /api/me/two-step/enable` `{ code }` · `POST /api/me/two-step/disable` `{ password }`.
  - Locked out: `POST /api/admin/owners/:id/two-step/off` (admin token).
- **Team** (kv `members`): an owner invites people by link (7 days, emailed when Postmark is on). Roles: **Can approve**
  (`approver`: decisions and day-to-day work, but not billing, the team, the rules or the profile) and **View only**
  (`viewer`: GET only, plus their own password, two-step and devices). Checked on the server for every request
  (`roleProblem` in `auth.ts`, 403). Removing someone signs them out everywhere.
  - `GET /api/team` → `{ members, roles }` · `POST /api/team` `{ name, email, role }` → `{ member, inviteUrl, expiresAt, emailed }`
    · `PATCH /api/team/:id` `{ role }` · `POST /api/team/:id/invite` (new link) · `DELETE /api/team/:id`.
- **Devices**: `GET /api/me/sessions` → `{ sessions: [{ id, device, ip, lastSeenAt, current }] }` ·
  `DELETE /api/me/sessions/:id` · `POST /api/me/sessions/others` → `{ signedOut }`.
- `GET /api/me` also returns `me` (who is signed in: owner or member, and the role) and `entitlements`
  (`{ plan, features, list }`: what the plan includes, from `src/billing/entitlements.ts`).

## Plans, leasing, calendar, books and documents (`src/api/owner-more.ts`)

Every plan has everything in the plan below it. What each plan unlocks is enforced on the server, not just hidden:
`allows(owner, feature)` in `src/billing/entitlements.ts`. Essentials gets the in-house AI on the routine model and
tenant questions outside a workflow become a **draft** to-do the owner sends; Autopilot adds text and email automation,
the high-end model and state leases; Autopilot Pro adds voice calls, the best model, the Landlord Forms Pack and
24/7 support. Off Pro, a call is told to text instead (911 first), except an emergency (gas, fire, flooding...),
which gets the same safety steps and emergency dispatch as a text on every plan.

- `GET /api/leasing` → `{ homes, stages, people, note }`: homes not occupied, and everyone from first question to lease
  sent (prospects, tours, applications, leases out for signature). No scores or rankings.
- `GET /api/calendar?month=YYYY-MM` → `{ month, events: [{ date, time?, title, kind, tab? }] }`: tours, rent due, lease
  ends, repair start-by deadlines, to-dos and the setup call, in the owner's time zone.
- `GET /api/books` → `{ months (last 6: income, expenses), entries (latest 100), categories }`.
  `POST /api/expenses` `{ memo, amount (dollars), category, propertyId, date? }` → 201.
- `GET /api/documents` → `{ docs: [{ id, title, group, summary, included, plan, planName }], homes, tenants, plan }`.
- `GET /api/documents/:doc?tenantId=|propertyId=` → `{ id, title, state, html }`, or **403** `{ error, plan, planName }`
  when the plan doesn't include it (the document never leaves the server).
- `GET /api/documents/:doc/page?tenantId=|propertyId=`: the same document as its own page (no scripts, CSP
  `default-src 'none'`, framed only by this site). The app shows it in a frame; owners print it or save it as a PDF.
- The library (`src/leases/state-docs.ts`, rules in `src/leases/state-rules.json`, built by
  `scripts/state-library/build_state_rules.py`): 10 documents for all 50 states and DC. Autopilot opens the lease,
  month-to-month agreement, disclosures addendum and lead-paint form; Pro opens all 10.

## Railway variables this reads (names only)

**api** service: `PUBLIC_URL` (link URLs, `Secure` cookie, same-site check), `ADMIN_API_TOKEN` (admin sign-in links),
`STRIPE_SECRET_KEY` (confirms a checkout when the browser arrives before the webhook), `CALENDLY_URL`
(`onboarding.calendlyUrl`), `POSTMARK_TOKEN` + `EMAIL_FROM` (forgot-password and setup emails; without them the pages
say to email support), `BUSINESS_EMAIL` (support address on pages), `OWNER_API_TOKEN` (bearer, as before). Optional:
`RL_LOGIN_IP_PER_HOUR` (30), `RL_LOGIN_EMAIL_PER_HOUR` (10), `RL_OWNER_SEND_PER_HOUR` (60).

## Setup clicks

Nothing is required. After deploy:
1. Sign yourself in: open `/admin`, paste the admin token, **Connect**, then **Sign-in link** → pick yourself → **Make
   sign-in link**. Open the copied link, choose a password. From then on use `/login`.
2. For "Forgot password" emails: add `POSTMARK_TOKEN` and `EMAIL_FROM` in Railway → api → Variables (once Postmark is set up).

## Known limits

- Sign-in limits are counted in memory per server instance (like the other limits); move to Redis if there is more than one instance.
- Sessions and links live in the JSON store's kv. With Postgres, add `sessions` and `login_links` tables (hash as the key).
- Signup doesn't verify the email address. The after-checkout link is only handed out for brand-new accounts;
  anything with data gets its link by email.
- `/app/*` deep links aren't routed yet (the UI engineer adds them). `safeNext` already allows `next=/app/...`.
- Login pages have a strict CSP (`script-src 'none'`); `apps/owner/index.html` is served without it so the app can use its own scripts.
- `GET /api/tasks`, `/api/charges`, `/api/approvals`, `/api/work-orders` default to everything (as before); the app should pass `?status=open` (or `pending`).
- "Rent received" now de-duplicates on what was already recorded (`owner_<charge>_<paid>_<amount>`), not the
  millisecond, so a double tap counts once and a later payment always counts.

## Tests (`tests/owner-api.test.ts`, 20)

Passwords and safe redirects · checkout → setup link → password → session → `/api/me` (with Calendly) · Stripe
check when the webhook is late, and email-only links for accounts with data · sign in, same error for unknown email,
per-email and per-IP limits, cross-site sign-in refused · sign out one device or all · 30-day sliding sessions, CSRF
header and Origin/Referer, bearer still works · another owner's records are 404 everywhere · decisions with data
(renewal dollars → cents, deposit deductions, bad data 400) · setup checklist closing itself · rent received in
dollars, repairs with vendor names, to-dos, homes, former tenants, profile · message threads, owner replies, STOP
respected · admin link and forgot password (1-hour links, same answer for every email). · authenticator codes (RFC 6238 vectors, each code once) · two-step sign-in · team roles and removal
· devices · plan contents in `/api/me` · leasing, calendar and books · documents filled in and locked by plan ·
documents as printable pages.
