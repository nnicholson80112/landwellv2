# The owner app (`/app`)

Branch `kh/owner-ui` (started from `kh/integrate`). Owners can now run everything from one page on their phone or
computer, without texting: answer decisions, see rent, repairs and messages, add homes, tenants, vendors and their
lease, and change their rules and profile. Built on the owner API (`docs/notes/owner-api.md`).

## What was built

| File | What it is |
| --- | --- |
| `apps/owner/index.html` | The whole app: one file of HTML, CSS and plain JavaScript. No frameworks, no CDN, no outside requests. |
| `apps/owner/manifest.webmanifest` | Install manifest ("Add to Home Screen"): name, colors, start page, shortcuts. |
| `apps/owner/icon.svg` | App icon (the KeyHelm mark on terracotta, full-bleed so it also works as a maskable icon). |
| `src/api/owner-routes.ts` | Serves the app (signed-in only), its Content-Security-Policy, deep links, the manifest and icon. |
| `tests/owner-ui.test.ts` | 7 tests (list at the bottom). |
| `scripts/check-owner-app.mjs` | Browser walk-through at 390px and 1280px (needs an existing Playwright install; not a dependency). |

## The screens

Bottom tab bar on phones (Today, Rent, Repairs, Messages, More), dark slate side menu with every screen on screens
900px and wider. **More** opens a sheet with Leasing, Homes, Calendar, Documents, Books and Settings. Each screen has
its own address, so the browser's Back button, bookmarks and the install shortcuts work: `/app` (Today), `/app/rent`,
`/app/repairs`, `/app/messages`, `/app/messages/<phone or email>`, `/app/leasing`, `/app/homes`, `/app/calendar`,
`/app/documents`, `/app/books`, `/app/settings`.

Added on `kh/owner-dashboard` (API in `docs/notes/owner-api.md`):
- **Leasing**: homes for rent with "Copy listing", and a board from Inquiry to Lease sent. "Your decision" opens Today.
- **Calendar**: month grid (hidden under 760px) and the month's agenda with links to each screen.
- **Documents**: pick a tenant or home, pick a document; it's filled in on the server and shown in a frame (its own
  script-free page), with "Open to print or save as a PDF". Documents the plan doesn't include show a lock card.
- **Books**: this month's income, expenses and net, 6 months of bars, entries, "Add an expense".
- **Settings** adds **Your plan** (what it includes, ✓ and ✕), **Team** (invite by link, roles, remove) and **Sign-in
  and security** (two-step setup with an authenticator app, signed-in devices).
- **Today**: on Essentials, a tenant question outside a workflow shows KeyHelm's draft with **Send draft**.
- "Talk to us about <plan>" opens the onboarding Calendly (`onboarding.calendlyUrl` from `/api/me`) with the plan
  picked; with no `CALENDLY_URL` the button is left out.

1. **Today** (`/api/me`, `/api/approvals?status=pending`, `/api/tasks?status=open`, `/api/activity?limit=200`)
   - Decisions as cards: what kind, the title, the details, the plain question, and big buttons. Choices that need
     more (renewal rent and months, filled in; deposit deductions as reason + $ rows with a running refund total;
     the lease's missing blanks; a showing time; a partial rent amount; an applicant's start date) open those inputs
     first. "No" choices (deny, decline, don't renew, dispute, cancel) ask once more before sending.
   - The text-reply hints in decision text ("reply YES with the code...") are removed in the app; it has buttons.
   - **Fair housing:** applicant decisions show every choice with the same plain style (nothing highlighted), plus
     "Compare the report with your written criteria... KeyHelm never scores or recommends applicants."
   - To-dos with **Done**. "Reply to Lisa Chen (+1...)" to-dos get an **Open messages** button.
   - Setup checklist (until all 6 steps are done) with a progress bar, a button per step that opens the right form,
     and **Book your onboarding call** (the Calendly link from `/api/me`), or the booked time once it's booked.
   - "What KeyHelm handled this week": counts from the activity log (messages answered, repairs taken and booked,
     rent reminders, late notices, tours, applications, leases...), with the details one tap away.
2. **Rent** (`/api/charges?status=open|paid`, `/api/rules`): open charges grouped by home, then by due date and month,
   late ones marked (a late notice went out, or past the grace days). **Mark received** fills in the whole balance;
   change it for a partial payment. A note at the top: tenants pay the owner directly, KeyHelm never collects or
   holds rent, plus the owner's own "how to pay" words. Recently received charges are one tap away.
3. **Repairs** (`/api/work-orders?status=open|closed`): status in plain words, urgency, trade, vendor with a tap-to-call
   number, the window, quote, invoice, photos, and the Colorado start-by deadline while no vendor is booked.
   **Request a repair**: home, tenant (optional), what needs fixing, kind of work, how urgent.
4. **Messages** (`/api/messages/threads`, `/api/messages/threads/:key`, `POST /api/messages/send`): one row per person
   (name, role, home, last message, time, "Needs reply", "Texts off"); the conversation; a reply box (Text or Email
   when both work) that says replies go from the KeyHelm number or email and start with the owner's first name.
   Two columns side by side at 1100px and wider. Tenants and vendors also have a **Message** button on Homes.
5. **Homes** (`/api/properties`, `/api/tenants`, `/api/vendors`, `/api/lease-templates`):
   - Homes with status, lock, lease dates, details and tenants. Add/edit a home (address, city, ZIP, beds, baths,
     rent, deposit, status, lock type with device id or lockbox code, detail rows). Remove a home when the API allows.
   - Add/edit a tenant (name, mobile, email, best way to reach them, autopay, living there now or moving in soon,
     their current lease when the home has none, and "Send them a welcome text now"). **Moved out** with an optional
     forwarding address. Former tenants are listed one tap away.
   - Vendors: add/edit (name, trades as checkboxes, phone, email, emergencies, preferred) and remove.
   - Lease: pick a .txt file or paste the text; afterwards the app lists the blanks it found, split into "filled in
     for you" and "asked when a lease goes out".
6. **Settings** (`/api/me`, `/api/rules`):
   - Rules: repair and emergency limits, rent due day, grace days, late fee (with the Colorado cap in plain words),
     how tenants pay you, pet policy, quiet hours, showings (self, owner, both) and showing hours, renewal lead days,
     topics you always handle yourself, facts KeyHelm can share, and written screening criteria.
   - Profile: name, mobile, email (asks for the current password when the email changes), text alerts on/off.
     Change password.
   - Billing: plan, status, billing term, doors, dates. **Manage billing** calls `POST /api/billing/portal` and opens
     the `url` it returns (https only; Stripe sends the owner back to `/app`). A 409 (no subscription yet) shows the
     server's own words; anything else (billing not set up, Stripe unreachable, or a server without that route)
     shows "email <support email> and we'll take care of it". KeyHelm only bills for its own subscription; the page
     says so.
   - Sign out, or sign out on all devices.

Everywhere: loading and error states in plain words with **Try again**, empty states that say what will show up,
an offline banner, toasts (two at most) read out by screen readers, money as `$1,234` (or `$1,234.50`), dates as
`Sun, Nov 1` (year added when it isn't this year) in the owner's time zone, phone numbers as `(720) 555-0111`.
Data refreshes after every action, when the tab comes back after a minute away, and every 2 minutes while open
(skipped while a form is open or being typed in).

## How it works

- **Who gets it**: `GET /app` and `/app/<screen>` need the sign-in cookie. Signed out (or a dead session) → `302
  /login?next=<that screen>`, and signing in comes back to it. Unknown paths under `/app` are 404.
- **Content-Security-Policy** (only for this page): `default-src 'none'; script-src 'nonce-…'; style-src 'nonce-…';
  img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src 'self'; manifest-src 'self'; form-action 'self';
  frame-ancestors 'none'; base-uri 'none'; object-src 'none'; require-trusted-types-for 'script'`. A fresh random nonce
  is added to the page's `<script>` and `<style>` tags on every response (`sendApp` in `owner-routes.ts`). The page
  is `cache-control: no-store`. The server's usual headers (nosniff, DENY framing, HSTS...) still apply.
- **No HTML from data**: every element is built with DOM calls (`h()` in the script); server text only ever goes in
  as text. The page never uses `innerHTML` and similar, and Trusted Types makes the browser refuse them anyway.
  State documents are HTML, so they are never put into the app: they load as their own page in a same-site frame.
  Links from the server (Calendly, the billing page, photos) are used only when they are `https:`.
- **CSRF**: all requests go through one helper, `api()`: `credentials: 'same-origin'`, and every non-GET sends
  `X-KeyHelm: 1` (the server refuses changes without it). A 401 sends the owner back to sign in.
- **Install**: `/app/manifest.webmanifest` and `/app/icon.svg` are public (browsers fetch manifests without cookies),
  cached for a day / a week, served from memory with ETags. The app file is read again when it changes on disk.
- **Look**: KeyHelm terracotta `#C8502D` on cream `#FFF6EC`, slate text and side menu `#1E2B2F`, amber `#E8A33D`
  highlights, mint `#0E9F6E` for success; a matching dark mode. The sign-in, policy and lease-signing pages match.
- **Fonts**: Montagu Slab (headings) and Figtree from this site's `/fonts`. Until `apps/site/fonts/montagu-slab-latin.woff2`
  (Google Fonts, OFL) is added, headings fall back to Georgia; the server serves the file as soon as it exists.

## Small edits to shared files

- `src/api/owner-routes.ts`
  - The `/app` handler now serves `apps/owner/index.html` with the nonce CSP (`appCsp`, `sendApp`), adds
    `/app/:tab` (the six screens) and `/app/messages/:key`, sends signed-out owners back to the screen they asked
    for, and serves the manifest and icon (registered before `/app/:tab`). The placeholder page is still used when
    the app file is missing.
  - **Bug fix (sign-in):** the one-time link pages (`GET`/`POST /login/link/:token`) sent
    `Referrer-Policy: no-referrer`. With that policy, browsers send `Origin: null` on the password form, so the
    same-site check refused it with a 403: in a real browser, nobody could finish setting a password from a setup or
    reset link. Now `same-origin`: the token still never goes to another site, and the form keeps its Origin.
    Found by the browser walk-through.
- `src/api/owner-data.ts`: deposit decision fields (`deposit`, `deposit-final`, `deposit-list`) also carry `held`, the
  deposit held in dollars (from the move-out run's lease), so the app can show the refund while deductions are typed.
  New optional `held` on the `Field` interface. Nothing else changes.
- `tests/owner-api.test.ts` (changed on purpose, 2 assertions): the link page's `referrer-policy` is now
  `same-origin`; and `/app` now serves the real app, whose Calendly button comes from `/api/me` (already checked in
  the same test) instead of the placeholder's server-rendered link.

## Railway variables

None new. The app itself reads nothing from the environment; what it shows comes from the owner API, which reads
`CALENDLY_URL` (onboarding button), `BUSINESS_EMAIL` (support email), `PUBLIC_URL` (same-site check), as before.

The browser check script (local only, never on Railway) reads `PLAYWRIGHT_MODULE`, `PLAYWRIGHT_BROWSERS_PATH`,
`CHECK_OUT` (screenshot folder) and `CHECK_VERBOSE`.

## Setup clicks

Nothing to set up. After deploy: open `/login`, sign in, and you land in the app.
To put it on a phone's home screen: iPhone (Safari) **Share → Add to Home Screen**; Android (Chrome) **⋮ → Install app**.

## Browser check (`node scripts/check-owner-app.mjs`)

Starts its own server on demo data (temp `DATA_FILE`, `SEED_DEMO=true`, throwaway `ADMIN_API_TOKEN`, no provider keys,
so every outside service is the built-in mock), makes real activity through `/api/dev/*`, signs in with an admin
one-time link, and blocks any request that would leave localhost. Last run: **24 checks passed, no console errors,
no outside requests**, twice in a row:
- Phone 390px: every tab; no sideways scrolling; every button, link, field and summary at least 48px tall; approve a
  repair; applicant choices equal, Deny asks first, Approve shows the start date; renewal rent filled in, changed to
  $2,800 and saved as 280000 cents; open a conversation from a to-do, reply, mark the to-do done; add a vendor (and
  the plain error when the name is missing); add a home and a tenant with a lease; request a repair; save the rules;
  Manage billing falls back to the support email; offline banner; keyboard reaches the skip link first.
- Desktop 1280px: sign in with email and password straight to `/app/messages`; every tab; messages side by side;
  browser Back; sign out (then `/app` redirects).
- A month of activity (the `npm run demo` story) at 390px: November rent marked late; $1,000 received, then the rest.
- A brand-new owner at 390px: "0 of 6 done", the Calendly button, an empty state on every screen, "Add a home" from
  the checklist, then "1 of 6 done".

## Known limits

- **Manage billing** uses `POST /api/billing/portal` → `{ url }`, which the billing branch added to `kh/integrate`
  after this branch started (contract checked: 200 `{url}`, 409 no subscription, 503 not set up, 502 Stripe error).
  This branch alone doesn't have the route, so here the button shows the support email; after the merge it opens
  Stripe's page. Nothing to change in the app.
- No offline mode: there's no service worker, so the app needs a connection (the banner says so). No
  `apple-touch-icon` PNG (no image tools without dependencies), so iPhones use a page snapshot as the home screen icon.
- Lease upload takes plain text only (a .txt file or pasted text); for PDF or Word the page says to copy and paste.
  The API has no "delete lease" yet, so old leases stay listed.
- No "Publish listing" button yet (the listing workflow asks for approval by itself when a home is ready).
- "What KeyHelm handled this week" counts activity by action name (`message.answered`, `repair.scheduled`...); rent
  reminders are read from the daily rent check's text ("N reminders"). If those names or words change, update `WEEK`.
- The nav counts are refreshed with 3 small requests after each action.

## Tests (`tests/owner-ui.test.ts`, 7)

Signed out → sign in and back to the same screen; signed in → the app with a fresh-nonce CSP on every response,
no-store, deep links, 404 for unknown paths · the page is self-contained (no outside URLs, CDN, HTML string sinks,
inline handlers, em dashes, gradients or pills) and its script parses; fonts served here · one request helper with
`same-origin` credentials and `X-KeyHelm: 1` on every change, and the server refuses a change without it · every
screen, the words owners need, accessibility basics, every route the app changes things through, and every list it
reads answers 200 · manifest and icon public, cached, revalidate with 304, start page inside the scope · deposit
decisions carry `held` · money, dates (owner's time zone), phone numbers and the removal of text-reply hints.
