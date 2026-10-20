# Website and text-message pages

Branch `kh/site` (from `kh/integrate`). A sellable KeyHelm website plus the pages Twilio's A2P 10DLC review needs.
The copy-paste guide for Twilio's forms is in [`twilio-a2p.md`](twilio-a2p.md).

## What was built

| File | What changed |
| --- | --- |
| `apps/site/site.body.html` | New single-page site (then `npm run build:site` writes `apps/site/index.html`; never edit that by hand) |
| `src/api/legal.ts` | New `/sms` page (`smsProgram()`), A2P clauses in Privacy and Terms, shared texting wording, address optional everywhere, cookie policy corrected for the owner sign-in cookie, `/sms` in the policy links |
| `src/api/server.ts` | Two tiny edits: `smsProgram` added to the legal import, and `['/sms', smsProgram]` added to the legal pages list in `loadStatic()` |
| `scripts/live-check.mjs` | `/sms` added to the public page checks |
| `tests/site.test.ts` | 11 tests (one skips until the billing rename lands, see below) |

`src/config/business.ts`: one line, `BUSINESS_ADDRESS` is trimmed so a value of only spaces counts as empty.

### The website (`/`)
One page, mobile first, no third-party requests, no cookies, no browser storage. Fonts are the self-hosted
Bricolage Grotesque and Figtree under `/fonts`. Brand colors as CSS variables, with a dark mode that follows
the visitor's device. Sections, top to bottom:

1. **Nav**: logo, section links (desktop), **Book a demo call** (desktop) and **Get started** (always).
2. **Hero**: "Your rentals, handled. You just approve." For Colorado landlords with 1 to 50 homes; answers
   tenants 24/7, repairs, rent reminders, renewals and move-outs; one flat price per door instead of the
   8 to 12% of rent managers typically charge. **Get started** and **Book a demo call** (`/demo`, which redirects
   to `CALENDLY_URL`). A sample phone feed labeled "Sample data".
3. **Trust strip**: you stay the landlord, rent goes straight to you, 24/7 answers, never discusses
   neighborhoods or scores applicants.
4. **How it works**: 4 steps (pick a plan, set up together, tenants get one welcome text, you approve by text).
5. **Who does what**: "KeyHelm handles" vs "You still".
6. **See it work**: the four workflows with the owner's steps in yellow, plus a sample text conversation.
7. **Savings calculator**: visitor enters homes, rent, management fee, leasing fee, plan and billing term. The
   example defaults are labeled ("Example numbers are filled in. Replace them with yours." and "Example value"
   under each fee). Says honestly when a manager would cost less at the numbers entered.
8. **Pricing**: Essentials $10 / $8, Autopilot $15 / $12, Autopilot Pro $20 / $16 per door per month
   (month-to-month / 12-month agreement billed monthly), plan contents from the Stripe product descriptions,
   month-to-month cancel anytime, first month at checkout, no setup fee.
9. **FAQ** (10): rent money, fair housing, emergencies, data and privacy, Colorado rules, cancelling, what
   tenants see, site visits, own lease, switching from a manager.
10. **Final CTA** band and **footer**: KeyHelm LLC, address (only when set), email, the "software, not a property
    manager" line, and links to Privacy, Terms, **Text messages (/sms)**, Cookies, Refunds, Accessibility.

**Signup window** (unchanged flow): `POST /api/public/signup` with
`{ name, email, phone, doors, plan, term, ref, agree, smsConsent }`. `plan` is now the select's value:
`essentials | autopilot | pro`; `term` is `monthly | contract12`. It shows the price for the chosen plan, term
and number of homes ("You'll see the exact total before you pay", because offers can lower it at checkout).
The texting box is optional and unchecked, with the exact words in `OWNER_SMS_OPT_IN` plus a link to `/sms`.
Errors are announced; focus stays in the window; Escape closes it.

**Footer address**: the site keeps the `{{BUSINESS_ADDRESS}}` placeholder inside `<span class="addr">`, and CSS
hides it when empty, so there's no blank line or stray `<br>` and `server.ts` didn't need to change.

### `/sms`: "KeyHelm text messages"
Built by `smsProgram()` in `src/api/legal.ts`, served from the static page cache like the other legal pages.
Covers: sender (KeyHelm LLC on behalf of the landlord), what we text about, the opt-in paths (tenants added by
the landlord with a welcome text; anyone who texts first, including applicants' consent box; vendors; owners'
unchecked optional box quoted word for word), frequency varies, msg and data rates, STOP / START / HELP and the
HELP reply, support email (and phone if `BUSINESS_PHONE` is set), privacy and terms links, the no-sharing
statement, carriers not liable, and 5 sample messages.

**Samples match the code.** `SMS_SAMPLES` are word for word what the workflows send (tenant welcome, rent
reminder, repair booked, showing booked, owner repair approval), with made-up names and addresses. A test runs
the demo month plus a tenant welcome and checks that each sample has the same shape as a text the app really
sent. Change a workflow's wording and the test tells you to update the samples (and Twilio).

### Privacy and Terms
- Privacy: owners' texting consent is listed as collected data; a row for "Anyone who gets texts" (number,
  consent, STOP/START/HELP); under sharing, the CTIA statement word for word ("No mobile information will be
  shared with third parties or affiliates for marketing or promotional purposes.") and "Text messaging
  originator opt-in data and consent are excluded from every sharing category in this policy and will not be
  shared with any third parties."; a new "Text messages" section linking `/sms`.
- Terms section 5 is now "Text messaging": the program, owners' consent (optional, not a condition of
  purchase), owners may only add people who agreed to texts about the rental, frequency varies, msg and data
  rates, HELP / STOP / START, carriers not liable, privacy.
- Address optional everywhere: contact lines read "KeyHelm LLC." with no address, or "KeyHelm LLC, <address>."
- Still owner-approved: no draft notice unless `LEGAL_REVIEWED=false`. `TERMS_VERSION` moved from
  `2026-10-draft-1` to `2026-10-20` (stored with each signup).
- Cookie policy now says owners' sign-in uses one cookie (`kh_session`, from the owner sign-in branch); staff
  consoles use browser storage. The public site still sets no cookies.

## Railway variables it reads (names only)
All on the **api** service, all optional:
`BUSINESS_LEGAL_NAME` (default KeyHelm LLC), `BUSINESS_ADDRESS` (left out when empty), `BUSINESS_EMAIL`
(footer, `/sms`, HELP reply; default is the placeholder `help@keyhelm.example`), `BUSINESS_PHONE` (shown on
`/sms` when set), `LEGAL_EFFECTIVE_DATE`, `LEGAL_REVIEWED` (`false` brings back the draft notice),
`CALENDLY_URL` (where **Book a demo call** goes, through `/demo`). No new variables.

## Setup clicks
None to make the pages work: they appear on the next deploy. Before the Twilio submission:
Railway, **api** service, **Variables**: set `BUSINESS_EMAIL` to a real inbox, check `BUSINESS_LEGAL_NAME` and
`LEGAL_EFFECTIVE_DATE`, then **Deploy**. The rest is in `twilio-a2p.md`, section 0.

## Tests (`tests/site.test.ts`)
Global `fetch` is wrapped so only the local test server (127.0.0.1) can be reached.
1. `index.html` is the current build of `site.body.html`.
2. Three plans, both terms, exact prices, plan contents, highlighted Autopilot, calculator prices, signup plan
   ids `essentials/autopilot/pro` and terms `monthly/contract12`, signup payload fields.
3. Prices match `LIST_PRICE` (skips until the billing branch renames `plus` to `pro`; then it checks
   $10/$8, $15/$12, $20/$16 automatically).
4. No "Landwell", no em or en dashes, no external scripts, styles, fonts, CSS urls, embeds or trackers, no
   cookies or storage; self-hosted fonts; brand colors; hero, CTAs, FAQ topics; footer links every policy page
   including `/sms`; address placeholder in its own hideable element; texting box optional and unchecked with
   the same words as `/sms`.
5. Server: `/` has no `set-cookie`, placeholders filled, empty address leaves no line or stray commas on `/`,
   `/privacy`, `/terms`, `/sms`; with an address it appears.
6. `GET /sms` has everything above.
7. Samples match texts the workflows really send.
8. HELP / STOP / START replies: brand first, one SMS each, plain GSM characters.
9. Privacy texting clauses. 10. Terms "Text messaging" section. 11. live-check covers `/sms`.

## Decisions and known limits
- **"Recommended", not "Most popular"** on Autopilot. The task text asked for "most popular", but there are
  no customers yet and `docs/LAUNCH-CHECKLIST.md` lists "Most popular" as a removed unsupported claim. Switch the
  word in `site.body.html` (`<span class="tag">`) once it's true.
- **"Listings on Zillow and more"** has a footnote: KeyHelm writes the listing; until the Zillow feed is
  approved the owner pastes it into Zillow Rental Manager (that's what the code does today).
- **"8 to 12% of rent"** is the range from the project's research (HANDOFF section 1), worded as "typically".
- The site sends `plan: 'pro'`. On this branch alone the API still only knows `plus`, so `pro` would fall back to
  Autopilot at checkout. **Merge together with (or after) the billing rename** that makes the API accept `pro`.
- The site's prices are written into the page (and its small `PRICE` table for the calculator). If Stripe prices
  change, update `site.body.html`, rebuild, and the tests will check them against `LIST_PRICE`.
- `/terms` and `/refunds` still contain bracketed notes for the 12-month agreement, liability and disputes.
  They're business decisions, not invented here; fill them before the A2P submission.
- The legal pages' header is the plain word "KeyHelm" linking home (no logo or CTA), as before.
- Screenshots were checked locally at 390px and 1280px, light and dark, with the preinstalled Chromium: no
  horizontal scroll, no requests to any other host, no cookies.
