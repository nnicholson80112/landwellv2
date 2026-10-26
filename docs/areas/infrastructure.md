# Area 4: GitHub, Railway and data

**Subagent:** `release-engineer` (CI, deploys, Railway config and variables, the Docker image, the
store and Postgres, backups, admin alerts, `/health` and `/api/admin/status`, and the code side of
account setup: Twilio, Postmark, domain).

**Deeper notes:** `docs/DEPLOY.md`, `docs/SCALING.md`, `docs/notes/postgres.md`, `docs/notes/ops.md`,
HANDOFF sections 4 (live infrastructure, variable names) and 5 (go-live clicks).

**What a chat can and can't reach:** the cloud container can't open Railway, Stripe, Twilio or Postmark
directly (network policy). It can push to GitHub, run and read GitHub Actions (the GitHub connector), and
read/write the Stripe sandbox (the Stripe connector). The **Live check** action is how a chat sees the
live site. Railway's dashboard and logs are Nate's clicks.

## Goals

- [x] Push to `main` → Railway builds one Docker image (`Dockerfile`, node:22-slim) and deploys both
      services: **api** (`npm start`) and **ai** (`npm run ai`). Healthcheck `/health` (`railway.json`).
- [x] CI on every push (`.github/workflows/ci.yml`): `npm ci`, tests (with a Postgres 16 service so the
      Postgres tests run), typecheck, demo with 0 failed.
- [x] Live check after every push to `main` (`.github/workflows/live-check.yml`): waits up to 15 minutes
      for `/health` to show that exact commit, then up to 5 more minutes for `/health/ai` to show the ai
      service up on it too, then checks the public pages. The ai service has a volume, so Railway stops the
      old container before starting the new one: texts in that gap (80 seconds on Oct 26) get the
      fallback rules.
- [x] Postgres store with no dependencies (`src/store/pg.ts`, `pg-store.ts`), used when `DATABASE_URL`
      is set; imports the JSON file once on first boot.
- [x] Daily JSON backups, admin alerts to Nate, shared-number routing, `/api/admin/status`.
- [ ] **FIRST: find out why `270af79` didn't go live.** Details below.
- [ ] Add Postgres in Railway and set `DATABASE_URL` (Nate's clicks, HANDOFF go-live step 2), then
      confirm `/health` shows `"storage":{"kind":"postgres"...}`. The daily JSON backups stop once
      `DATABASE_URL` is set (`src/ops/backup.ts` skips them), so turn on backups for the Postgres service in
      Railway if the plan offers them, and keep the `/data` volume on **api** (it holds the imported file's
      `.bak`). See `docs/notes/postgres.md` steps 5 and 6.
- [ ] Business variables: `BUSINESS_EMAIL`, `ADMIN_ALERT_PHONE`, `ADMIN_ALERT_EMAIL` (go-live step 3).
- [ ] Check that the rate limits see each visitor's real IP on Railway (open since Oct 16, `docs/SCALING.md`
      "One thing to verify"). `clientIp` in `src/api/guard.ts` reads `X-Real-IP`, then the last
      `X-Forwarded-For`. If every visitor showed the same address, they would all share one limit: 10 signups
      and 30 sign-in tries an hour for everyone. Check again if Cloudflare is put in front (`docs/SCALING.md`).
- [ ] Custom domain + `PUBLIC_URL` (go-live step 4). Then update `LIVE_URL` in `live-check.yml`.
- [ ] Postmark (go-live step 5) and Twilio (go-live step 6, `docs/notes/twilio-a2p.md`). Nate's clicks;
      the code is ready. Never buy numbers or send texts from a chat. Set `PUBLIC_URL` to the final domain
      before pointing Twilio at it, and use that exact host in the Twilio webhook URLs: once `TWILIO_AUTH_TOKEN`
      is set, `/webhooks/twilio/*` checks Twilio's signature against `PUBLIC_URL` plus the path and answers 403
      on any mismatch.
- [ ] Before real customers: `SEED_DEMO=false`, `DEV_TOOLS=false` (go-live step 8). In the same change, update
      `scripts/live-check.mjs`: it expects `/play` to answer 200, and with `DEV_TOOLS=false` `/play` answers 404,
      so every Live check after that would fail. If the demo owner is removed, also delete `OWNER_API_TOKEN` in
      Railway: it signs in as whichever owner is first in the store (`ownerOf` in `src/api/server.ts`), which
      would then be a real customer.
- [ ] Optional: rename the data file from `/data/landwell.json` (the `DATA_FILE` variable) once on Postgres
      it no longer matters; move the repo to private; bump `actions/checkout` and `actions/setup-node` to
      versions on Node 24 (GitHub warns Node 20 actions are deprecated).

## The stuck deploy (Oct 20)

- `main` = `270af79` (pushed 20:21 UTC Oct 20). CI passed on it.
- Live check run 39491336427 waited 15 minutes; `/health` kept saying `"commit":"9292002"`,
  `"startedAt":"2026-10-19T22:17:20Z"`. So the api service never switched to the new build.
- Railway keeps the old deployment when the new one fails to build or fails its `/health` check, so the
  answer is in Railway → **api** → **Deployments** → newest → **Build Logs** / **Deploy Logs**. Check
  **ai** too (same image, same `railway.json` healthcheck).
- Things to rule out, most likely first:
  1. The new code crashes or hangs on boot with the **real** data file (`DATA_FILE=/data/landwell.json`,
     written by `9292002`) or the real variables. Reproduce locally: check out `9292002` in a worktree,
     run it with `SEED_DEMO=true` and some activity to write a data file, then boot `270af79` against a
     copy of that file with the production variable names from HANDOFF section 4 (dummy values; the
     Stripe and AI calls fail closed without network).
  2. Boot takes longer than Railway's healthcheck window. Less likely: before `listen`, `src/api/server.ts`
     only awaits `openStore` (fast for the JSON file); the Stripe self-setup runs in the background
     (`void startStripeSetup`). `npm start` also runs `scripts/build-site.mjs` first.
  3. The **ai** service fails `/health` with the new code (does it still answer `/health`?).
  4. Railway didn't start a build at all, or skipped it (GitHub link, or the **Wait for CI** setting: with it on,
     Railway also waits for the Live check workflow, which is itself waiting for Railway, so the Live check times
     out and Railway skips the deploy; turn it off if it's on). Earlier pushes (`9881abd`, `9292002`) deployed fine with the same two
     workflows, so this fits only if that setting was switched on after Oct 19.
  5. A Railway account notice: trial or plan limits, a usage limit reached, or a paused service (look for a
     banner at the top of the Railway project).
- A quick local try on Oct 21 found nothing: `270af79` booted in about 2 seconds against a data file written
  by `9292002` (demo data plus two texts) with dummy production variables (no Stripe or demo ones), and its
  **ai** service answered `/health`. So read Railway's deploy list and logs first; 1 is still possible only
  with the real data or real variable values.
- Once fixed: push, and the Live check on that push must pass. Then run the Live check by hand with
  conversations (live-testing.md).

## Files

| Path | What |
| --- | --- |
| `Dockerfile`, `.dockerignore`, `railway.json` | Image and Railway deploy settings |
| `.github/workflows/ci.yml`, `live-check.yml` | CI and the post-deploy check |
| `scripts/live-check.mjs` | The live check itself (`--expect-commit`, `--wait`, `--conversations`) |
| `src/api/server.ts` | Boot order, `/health`, routing |
| `src/api/guard.ts` | Rate limits (`RL_*` variables), client IP, security headers, page cache |
| `.env.example` | Every variable name, no real values |
| `src/store/` | `store.ts` (JSON file), `pg.ts` (Postgres wire client), `pg-store.ts`, `open-store.ts`, `data-version.ts` |
| `db/schema.sql` | Postgres tables (json columns) |
| `src/ops/` | Alerts, backups, shared-number routing (`lines.ts`), `/api/admin/status` |
| `src/adapters/live.ts` | Twilio, Postmark, Seam, Stripe Identity adapters |
| Tests | `postgres`, `ops`, `guard`, `e2e` |

## Rules for this area

- Pushing to `main` deploys. Only the main chat pushes to `main`, after `npm test`, `npm run typecheck`
  and `npm run demo` pass.
- Variable **names** go in docs; values never go in git or chat. Nate types values into Railway.
- Never bump `DATA_VERSION` once real customers exist. On the JSON file (what production uses until Postgres is
  added) a bump moves all the data aside and the app starts over empty. Postgres ignores it.
- No runtime dependencies. Node 22 built-ins only.
- Keep **api** at one running copy (no extra replicas in Railway). Both stores hold the data in memory, Postgres
  lets only one copy save (`docs/notes/postgres.md`, Known limits), and rate limits are counted in memory.

## How to check your work

```
npm test && npm run typecheck && npm run demo
PG_TEST_URL=postgres://... npm test        # Postgres tests (CI does this with its own throwaway database)
node scripts/live-check.mjs https://api-production-66895.up.railway.app --expect-commit <sha7> --wait 900
```
From a chat: read GitHub Actions runs and logs, or start **Live check** (workflow `live-check.yml`, ref
`main`, input `conversations`) with the GitHub connector.
