# Running the live business: alerts, one shared texting number, backups, status

Branch `kh/ops` (from `kh/integrate`). Everything here is code and tests only: nothing buys a phone
number, sends a real message from a test, or touches rent, deposits or vendor payments.

| Piece | File |
| --- | --- |
| Admin alerts (limits, channels, what triggers them) | `src/ops/alerts.ts` |
| One shared texting number for every owner | `src/ops/lines.ts` |
| Daily backups of the data and the photos | `src/ops/backup.ts`, `scripts/pull-backup.mjs` |
| `GET /api/admin/status`, `POST /api/admin/owners/:id/line` | `src/ops/routes.ts`, `src/ops/status.ts` |
| Wiring (install hooks, the every-minute ops check, last tick) | `src/ops/index.ts`, `src/ops/state.ts` |
| Tests (13) | `tests/ops.test.ts` |

## 1. Admin alerts

`alertAdmin(svc, kind, subject, body)` tells Nate when the live business needs a person.

- **Where:** a text to `ADMIN_ALERT_PHONE` and/or an email to `ADMIN_ALERT_EMAIL`, through the same
  messaging adapter as every other message (Twilio for texts, Postmark for email). Neither set: the
  alert is written to the server log only (Railway, api service, Deploy Logs, search `[alert]`).
  Texts start with `KeyHelm alert: <subject>` and are cut to 640 characters; the email has the whole text.
- **How often:** at most one alert per kind every 10 minutes. Alerts in between are held back,
  counted, and listed in the next alert of that kind ("Also 2 more workflow failure alerts since
  10:03 AM (held back so you aren't flooded): Workflow failed: Late rent (x2)"). If nothing else of
  that kind comes, a short summary goes out once the 10 minutes are up (the ops check runs every
  minute). Same subjects are folded together (x2), up to 5 subjects are listed.
- **Never throws.** A failed or slow text or email (10 s limit, text and email sent side by side) is
  logged and the app carries on. Alerts from workflows are sent in the background, so a slow provider
  never holds up a reply or the engine.
- If the admin phone replied STOP, texts are skipped (email still goes). A text from the admin phone
  or email to the KeyHelm number is logged and not sent to any owner.
- State lives in the store (kv `opsAlerts`), so limits survive a restart.

| Kind | When | Message |
| --- | --- | --- |
| `run_failed` | A workflow stops with an error (`engine.hooks.onRunFailed`). The owner still gets the "Something needs a look" to-do, as before. | `Workflow failed: <title>`, the run, the owner, the first error line (never a stack trace) |
| `new_customer` | A subscription starts (`owner.signed_up`, from the Stripe webhook). Once per owner, ever. | `New KeyHelm customer: <name>, <email>, <plan>, <doors> doors`, then term, phone and owner id |
| `emergency_no_vendor` | A `vendor_needed` decision is created for an emergency work order (no vendor accepted in time, or none on file) | Address, problem, owner and tenant contacts, the decision code |
| `ai_fallback` | The AI failed and the built-in rules answered 3 times in 15 minutes (`ResilientAI.onError` in `pickAI`) | Count, provider, last error |
| `unrouted_message` | Shared number: a new person still couldn't be matched after we asked which home (or at once for an emergency) | Sender, number, message |
| `past_due` | An owner's KeyHelm subscription becomes `past_due` (checked every minute; once per owner each time it happens, again only after they pay and fall behind again) | Name, email, phone, plan, doors, since when |
| `backup_failed` | The daily backup failed | The reason and the data file |

## 2. One shared texting number

KeyHelm launches with one Twilio number, `TWILIO_FROM`, shared by every owner. Routing
(`ownerForLine` in `src/ops/lines.ts`, used by every webhook in `src/api/server.ts`):

1. **A message to an owner's own number** (`owner.lineNumber`, when it isn't `TWILIO_FROM`) goes to that owner.
2. **A message to the shared number** (or to any number no owner has, or with no number at all): owners
   without a number of their own are on it. If only one of them is **active** (not canceled, with at least
   one home), the message goes straight to that owner. (If none of them is active, any active owner counts,
   so a test signup without homes can't pull messages away from the real account.)
3. **Several active owners on the shared number:** no owner is picked at the door, and the front desk works it out:
   - **Known people route by who they are:** tenants, vendors and prospects are matched by phone or email
     across every owner (`identify()`), so they reach the right owner and get the right answers.
   - **New people route by the home they name:** the street name (like "Juniper" or "Aspen"), with the house
     number breaking ties, across every sharing owner's listed or vacant homes first, then any of their homes,
     then homes of owners who have their own number. Exactly one owner must match.
   - **Still unclear:** one reply, never naming an owner: "Hi! This is the KeyHelm automated assistant. This
     number answers for several rental homes. Which home address are you asking about?" Emergencies get a
     safety line first (gas: leave and call 911 or the gas company; danger: call 911; water: the main
     shut-off) and alert the admin at once.
   - **They answer with an address:** the whole conversation (their earlier messages and our question) moves
     to that owner's inbox, and their first question plus the address is what gets answered ("Hi, is it still
     for rent?" + "88 Aspen Ct" gets the Aspen Ct availability answer).
   - **Still no match on the next message:** no second question; the admin gets one `unrouted_message` alert
     per sender. The question is asked again after 7 days; old questions are cleaned up by the ops check.
4. **Phone calls:** the greeting on the shared number names no owner. When a known tenant reports an
   emergency on the shared number, the call is put through to their own owner (before, a call needed the
   owner's own number for that).

`lineNumber` set to the shared number (the seeded demo owner has `TWILIO_FROM` copied in) counts as shared.
A Messaging Service id (`MG...`) in `TWILIO_FROM` works too: owners whose line is that id are on the shared number.

### Giving an owner their own number (manual, nothing is bought by code)

1. Twilio Console, Phone Numbers, Manage, Buy a number: a Colorado local number with SMS and Voice.
2. Messaging, Services, the KeyHelm messaging service (the one in the A2P campaign), Sender Pool, Add Senders:
   add the new number.
3. Phone Numbers, Manage, Active numbers, click the new number:
   - Voice Configuration, "A call comes in": Webhook, `https://<your domain>/webhooks/twilio/voice`, HTTP POST.
   - Messaging Configuration: it uses the messaging service. Check that the service's Integration page, Incoming
     Messages, sends a webhook to `https://<your domain>/webhooks/twilio/sms` (HTTP POST), the same as the
     shared number.
4. Tell KeyHelm (the owner id is in `/admin` or `GET /api/admin/overview`):
   ```
   curl -X POST https://<your domain>/api/admin/owners/<ownerId>/line \
     -H "authorization: Bearer <ADMIN_API_TOKEN>" -H "content-type: application/json" \
     -d '{"lineNumber": "+17205550123"}'
   ```
   Answer: `{"owner": {...}, "lineNumber": "+17205550123", "shared": false, "sharedNumber": "..."}`. The owner's
   activity log shows the change. `409` if another owner already has that number, `400` if it isn't a phone number.
5. To undo: send `{"lineNumber": ""}` (or the shared number). The owner is back on the shared number.

Their tenants and vendors keep working either way: known people route by who they are on any KeyHelm number.

## 3. Daily backups (file store and Postgres)

- Once a day (the date in `TZ_DEFAULT`, America/Denver): `<folder of DATA_FILE>/backups/keyhelm-YYYY-MM-DD.json`,
  e.g. `/data/backups/keyhelm-2026-10-20.json` on Railway. The first one is made about 5 seconds after boot.
- File store: the store is saved, then the file is copied. Postgres: everything in the store is written out in the same
  format. Either way it goes to a temp file, is read back to check it is KeyHelm data, and is renamed into place
  (atomic). A damaged file never replaces a good backup. `DATA_FILE` stays set under Postgres: it picks the folder.
- The newest 14 are kept; older ones are deleted.
- Condition report photos are copied to `backups/photos/<report>/<name>`. Only new ones are copied. Copies are never
  deleted, even when the photo is, so they count against the volume's size.
- Never throws. A failure is logged (`[backup] FAILED`) and sends a `backup_failed` alert.
- **Limit:** the backups sit on the api volume. Under Postgres they survive losing the database, but not losing
  the volume. For a copy off Railway, run this on your own computer. It makes a fresh backup, then saves it and any new
  photos in `~/keyhelm-backups` (private: it has names, phones and sign-in records):

  ```bash
  ADMIN_API_TOKEN=$(pbpaste) npm run backup:pull -- https://api-production-66895.up.railway.app
  ```

  It runs only when you run it. Copy `ADMIN_API_TOKEN` from Railway first, so it's on the clipboard.

**Restoring.** File store: with the api service stopped, copy the chosen backup over `DATA_FILE`, then start it again.
Postgres: with the api service stopped, drop the tables `kh_records`, `kh_kv` and `kh_meta`, copy the chosen backup over
`DATA_FILE`, then start it. An empty database imports the file once, as on the first boot. Photos: copy them back to
`<folder of DATA_FILE>/photos/<report>/<name>`.

## 4. `GET /api/admin/status`

`Authorization: Bearer <ADMIN_API_TOKEN>` (same check as the other admin routes; anything else is `401`).
No secrets in the answer.

```
curl -s https://<your domain>/api/admin/status -H "authorization: Bearer <ADMIN_API_TOKEN>"
```

| Field | What it shows |
| --- | --- |
| `owners` | `total`, and counts by subscription status (`active`, `past_due`, `canceled`, `checkout_started`, `none`) |
| `subscriptions` | `active` subscriptions, their `doors`, `pastDue` |
| `runs` | `waiting` and `waitingByWorkflow`; `failedLast7Days` and the latest 25 `failed` runs with the first error line |
| `approvals` | `pending`, `pendingOver24h`, the 25 `oldest` (id, owner, kind, title, code, created) |
| `messages` | `last24h` in and out; messages no owner matched in the last 7 days (latest 10) |
| `ai` | provider name (for example `http (rules fallback)`), fallbacks in the last 15 minutes, last AI error |
| `messaging` | the messaging adapter (`router` with Twilio/Postmark, `outbox` when none is set up) |
| `engine` | `lastTickAt` and `secondsSinceTick` (the 30-second engine tick; over ~60 means something is stuck) |
| `store` | `kind` (`file`, `postgres`), storage health, `dataFile`, `dataFileBytes` |
| `backup` | `enabled`, the `last` backup (file, date, bytes, time), `count`, last result and last error |
| `alerts` | whether the alert phone and email are set, the latest alert of each kind |
| `lines` | the shared number, how many owners are on it, owners with their own number |

## Railway variables (api service)

New:
- `ADMIN_ALERT_PHONE`: Nate's mobile, like `+17205550123`. Optional.
- `ADMIN_ALERT_EMAIL`: where alert emails go. Optional.

Already there and read here: `ADMIN_API_TOKEN` (admin routes), `TWILIO_FROM` (the shared number),
`TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` (alert texts go out through Twilio), `POSTMARK_TOKEN` / `EMAIL_FROM`
(alert emails go out through Postmark), `DATA_FILE` (what is backed up), `DATABASE_URL` (backups come from the store),
`TZ_DEFAULT` (the backup date), `RAILWAY_GIT_COMMIT_SHA` / `GIT_COMMIT` (commit on the status page).

**Setup clicks:** Railway, the `api` service, Variables, New Variable: `ADMIN_ALERT_PHONE` = your mobile with +1,
and `ADMIN_ALERT_EMAIL` = your email. Deploy. Alert texts need Twilio connected (`TWILIO_*`) and alert emails need
Postmark (`POSTMARK_TOKEN`, `EMAIL_FROM`); until then alerts appear in the Deploy Logs as `[alert]` lines.

## Edits to shared files

- `src/workflows/index.ts`: `install()` now also sends the emergency-with-no-vendor alert after the owner's
  decision text (`onApprovalCreated`), keeps the owner to-do and adds the alert in `onRunFailed`, and calls
  `installOps(svc)`.
- `src/workflows/inbound-message.ts`: `const ownerId` became `let ownerId`, one import, and the `!ownerId`
  branch now calls `routeUnknownSender()` (it may continue with the matched owner and the joined question).
- `src/services.ts`: `pickAI`'s `onError` also calls `aiFellBack(r, e)`; one import.
- `src/api/server.ts`: imports; `ownerForLine()` now calls `src/ops/lines.ts`; the Twilio voice turn uses the
  caller's emergency to find the owner on the shared number; `registerOpsRoutes({ route, json })`; boot block:
  `noteTick(svc)` in the 30-second tick and at start, `startOps(svc, { dataFile, storeKind })`, and stopping
  it on SIGTERM and when Postgres says this copy was replaced.

## Known limits

- **Replies still go out from `TWILIO_FROM`** (a number, or a Messaging Service that picks a sender from its pool).
  An owner's own number only changes routing of incoming texts and calls. Sending each owner's texts from their
  own number would need a `from` on outgoing messages (adapter and `send()` in `src/workflows/lib.ts`); not built.
- A known prospect of one owner who texts the shared number about another owner's home stays with the first owner.
- Alert limits are per kind, not per item: a second new customer within 10 minutes arrives in the next alert or
  the summary, not on its own.
- The status page is API-only; the `/admin` console doesn't show it yet.
- Backups share the api volume (see above). Copies off Railway only happen when `backup:pull` is run.
- `owner.signed_up` is watched by wrapping `engine.emit` (the engine has no event listeners), in `installOps`.
