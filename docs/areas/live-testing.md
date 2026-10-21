# Area 5: Live testing and code review

**Subagents:** `live-tester` (checks the live site after a deploy and walks the customer flows in
test mode), `code-reviewer` (read-only review of the code from one angle at a time, reports real
defects with file and line).

Goal of this area: answer "can we sell it tomorrow?" with evidence, not hope.

## Goals

- [x] `scripts/live-check.mjs`: `/health` (commit, data version), public pages (`/`, `/privacy`,
      `/terms`, `/sms`, `/play`) and, with `--conversations`, five front-desk conversations through the
      phone-line webhook (prospect asks about 88 Aspen Ct and dogs, a schools question gets a neutral
      answer, a running toilet, gas → 911, flooding → urgent but no 911).
- [x] GitHub Actions **Live check** runs it after every push to `main`, or by hand with conversations.
- [x] Oct 19: live check 10/10 with Claude answering, on the old build (health, 4 pages, 5 conversations).
      The new build also checks `/sms`, so a full run there is 11/11.
- [ ] **Live check passes on the current `main`** (blocked by the stuck deploy, infrastructure.md).
- [ ] **Live check with conversations** on the new build, before Postmark or Twilio is connected (after
      that the script skips the conversations, see "Safety rules"). Pass means: the log's `health:` line
      shows the new commit and the run ends `11/11 checks passed`; gas gets 911, flooding gets shut-off help
      with no 911. The replies never contain the word "KeyHelm", and the built-in rules pass these checks
      too, so a pass doesn't prove Claude answered. Nate also opens Railway → **ai** → **Deployments**
      (newest one Active, same commit as **api**) → **View logs** and checks there are no
      `[ai] anthropic failed` or `[ai] ... rejected ...; sending without it` lines after the run.
- [ ] **Full test-mode purchase on the live site:** **Get started** → Autopilot, 2 homes, month-to-month →
      Stripe Checkout with card `4242 4242 4242 4242` (any future date, any CVC) → `/billing/done` → set a
      password → `/app` → add a home and a tenant → **Manage billing** opens Stripe's portal → sign out →
      sign in at `/login`. Then the same with the 12-month agreement and Autopilot Pro, using a **new email**
      each time (an email that already has an active plan is refused). Use throwaway test emails (Gmail
      with +test1, +test2 before the @), never an email a real customer or Nate will sign up with after
      launch: the test customer id stays on that account and a live checkout for it fails. Every
      self-serve signup gets the automatic welcome offer, so expect a coupon: 2 Autopilot homes
      month-to-month = $24 the first month (standard $30); 2 Autopilot Pro homes on the 12-month agreement
      = $26 a month for 3 months (standard $32). Confirm in the Stripe sandbox (connector,
      `acct_1Sf7x1EtnoC4AY9t`, livemode false) that each subscription has the right price, quantity and
      coupon, and that the webhook delivered (`/admin` shows the customer active). Before switching Stripe
      to live (go-live step 7), cancel every test subscription in the sandbox so the webhook marks those
      accounts canceled and they stop counting as paying customers.
- [ ] **Code review before selling** (never finished; see below). Fix every confirmed critical or high
      finding, then triage the mediums.
- [ ] Owner app click-through on a phone-sized screen against the live site (Nate on the live site. An agent can run `node scripts/check-owner-app.mjs`: it starts its own local
      server on demo data, so it can't check the live site, and it needs Playwright; if it prints
      "Skipped: Playwright not found" nothing was checked).
- [ ] After Twilio and Postmark are connected: one real text and one real email from Nate's own phone and
      inbox to the KeyHelm number/address, STOP and HELP from his phone, forgot-password email.

## The code review (rerun it)

The review that was supposed to run before launch hit the session usage limit; **no reviewer finished**.
Rerun it in batches of 2 to 3 reviewers. Either say "run the keyhelm-review workflow" (saved at
`.claude/workflows/keyhelm-review.js`; it reviews everything since `9292002`, the last commit before the
launch build; to rerun only some angles pass `{"lenses": ["security", "billing"]}`, keys `security`,
`billing`, `workflows`, `storage`, `ai`, `product` (angle 6 below)) or call the `code-reviewer` agent once per angle:

1. **Security:** sign-in, sessions, CSRF, sign-in links, password reset, admin token, one owner reading or
   changing another owner's records through any route, XSS in every page, webhook signature checks
   (Stripe, Twilio, Postmark), open redirects, secrets in responses or logs, the Postgres client's
   parameter handling, rate limits.
2. **Billing:** plan ids, lookup keys, prices vs Stripe, checkout, offers math, webhook idempotency,
   self-setup (never changes existing prices), billing portal, `/billing/done` link safety.
3. **Workflows:** replay determinism (store/clock reads inside `ctx.step`), step-key collisions, waits that
   never wake, decisions with bad data from the owner app, deleting a home/tenant/vendor/lease mid-run, quiet
   hours, STOP, texts to the wrong person.
4. **Storage and ops:** Postgres change tracking (every mutation marks changes), save timing and shutdown,
   first-boot import, data-version fresh start (must never wipe real data), atomic writes, backups, alert
   loops, shared-number routing (a message routed to the wrong owner is a privacy breach), what `/health`
   and `/api/admin/status` reveal.
5. **AI:** model routing, Claude request bodies, refusal and error fallback, cost math, the api ↔ ai contract,
   guardrails before and after the model.
6. **Customer flows:** every fetch in `apps/owner/index.html` vs the API's field names, dollars vs cents,
   missing CSRF header, dead buttons, prices and plan names on the site vs billing code, broken links,
   leftover "Landwell", em dashes, invented claims.

Each finding needs file:line and a concrete "this input → this wrong result". A second reviewer tries to
disprove every critical or high finding before anyone fixes it.

## Safety rules for testing

- Test mode only: Stripe `sk_test` and card 4242. Never a real card.
- Never buy phone numbers, never text or email anyone but Nate's own phone and inbox, never call 911 or
  real vendors. The demo vendor and owner use Nate's phone (720-930-5782), so once Twilio is live, demo
  repair jobs really text it.
- The live check's conversations go through the voice-turn webhook and only run while `/health` shows
  `"messaging":"outbox"`. As soon as Postmark or Twilio is connected (go-live steps 5 and 6), the script
  skips them and still reports a pass (6/6 instead of 11/11). After that, test conversations by texting
  from Nate's own phone.

## How to run things

- From a chat: GitHub connector → run workflow `live-check.yml` on `main` with `conversations: true`,
  then read the job log (the summary lists every check).
- Locally: `node scripts/live-check.mjs https://api-production-66895.up.railway.app --conversations`
  (the cloud container can't reach Railway; GitHub Actions can).
- `/health` is public; `/api/admin/status` needs the admin token (Nate).
