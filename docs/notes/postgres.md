# Postgres storage (branch `kh/postgres`)

## What it does

KeyHelm can now keep its data in Postgres instead of the JSON file. Nothing else in the app
changed: every part of the code still uses the same `Store` interface.

- **`DATABASE_URL` set:** data lives in Postgres. On the first boot with an empty database, an
  existing `DATA_FILE` is imported once and renamed to `<file>.imported-<date>.bak`.
- **`DATABASE_URL` empty:** the JSON file, exactly as before (including the data-version fresh start).

No npm packages were added. The Postgres client is written on Node built-ins.

## How it works

| Piece | File |
| --- | --- |
| Postgres client (wire protocol v3 over `node:net`/`node:tls`) | `src/store/pg.ts` |
| `PgStore`: memory working set + journal to Postgres | `src/store/pg-store.ts` |
| Picks the storage at boot, one-time import | `src/store/open-store.ts` |
| Change hook used by `PgStore` (small edit) | `src/store/store.ts` |
| Boot wiring, SIGTERM save, `/health` storage line (small edit) | `src/api/server.ts` |
| Table layout (for reading; the app creates the tables itself) | `db/schema.sql` |

**PgStore** loads everything into memory at boot (like `MemoryStore`), so reads stay instant and
the store stays synchronous. Every change marks that record as unsaved. `flush()` (the engine
calls it after each piece of work, and a timer every 2 s) starts **one transaction** that
deletes and upserts all unsaved items in batches (500 items / 4 MB per statement, jsonb
parameters, `ON CONFLICT DO UPDATE`).

- Changes made while a save is in flight wait for the next save. Nothing is lost.
- A failed save puts its items back on the unsaved list and retries with backoff (0.5 s doubling
  to 30 s), logging `[postgres] SAVE FAILED ... retrying` every time. The app keeps working from
  memory meanwhile. When it recovers it logs `saving works again`.
- `flushNow()` saves immediately and waits. SIGTERM (every Railway redeploy) finishes queued
  work, calls `flushNow()`, then exits.
- If Postgres refuses one item (for example a key too long for its index), that item is
  reported loudly (`SAVE REFUSED`) and the rest of the batch still saves. Text Postgres can't
  hold in jsonb (NUL characters, half an emoji) is cleaned instead of failing.
- **One writer at a time.** Each boot takes a "writer" number in `kh_meta` in the same
  transaction that loads the data. If an older copy of the app is still running (for example
  during a deploy), its next save sees it was replaced, stops saving and stops its scheduled
  ticks. So two copies can never overwrite each other.
- Lists come back in the same order after a restart (`seq` column).

**The client** (`pg.ts`) supports: `postgres://` and `postgresql://` URLs (user and password
URL-decoded), cleartext / MD5 / SCRAM-SHA-256 login, TLS (`sslmode` disable, prefer
(default, like libpq), require, verify-ca, verify-full), parameters (`$1`), server errors with
their SQLSTATE code, one connection with a serialized queue, automatic reconnect with backoff,
query timeouts (60 s) and clean shutdown. A wrong password fails at once instead of retrying.

**Boot** (`openStore`): with `DATABASE_URL`, `PgStore.open()` keeps trying for up to 60 s while
the database starts, then fails the boot (Railway restarts the service). If the database is
empty and `DATA_FILE` exists: an old-version file is set aside (same rule as the file store,
nothing imported); otherwise it is imported in one transaction and renamed to
`.imported-<date>.bak`. If the import fails nothing changes (the file stays) and the boot fails,
so the next boot tries again. `meta.dataVersion` is stored in kv for both storage kinds.

`/health` now includes `"storage": {"kind": "postgres", "unsaved": 0, "failing": false, "lastSavedAt": "..."}`
(or `{"kind": "file"}`). No error text or connection details are shown there.

## Railway variables it reads (names only)

| Variable | Service | Needed? |
| --- | --- | --- |
| `DATABASE_URL` | api | Yes, to turn Postgres on. Use a reference to the Postgres service. |
| `DATA_FILE` | api | Already set. Only read for the one-time import (and as the store when `DATABASE_URL` is empty). |
| `PGSSLMODE` | api | Optional. `?sslmode=` in the URL wins. Default `prefer`. |
| `PGSSLROOTCERT` | api | Optional. Path to a CA file for `verify-ca` / `verify-full`. |
| `DATABASE_SSL_REJECT_UNAUTHORIZED` | api | Optional. `true` to check the certificate even with `sslmode=require`. |
| `PGCONNECT_TIMEOUT` | api | Optional. Seconds per connection attempt (default 10). |
| `PGUSER`, `PGPASSWORD` | api | Optional fallbacks when the URL has no user/password. |

Tests only (not Railway): `PG_TEST_URL` (a database the tests may create schemas in) and
`PG_BIN` (PostgreSQL binaries folder; `PG_BIN=none` skips the local throwaway cluster).

The **ai** service is unchanged.

## Turning it on in Railway (exact clicks)

1. Open the KeyHelm project in Railway. Click **Create** (top right) → **Database** →
   **Add PostgreSQL**. Wait until the new **Postgres** box says it's online.
2. Click the **api** service → **Variables** → **New Variable**.
   Name: `DATABASE_URL`. Value: `${{Postgres.DATABASE_URL}}` (pick it from the list that pops up).
   Click **Add**, then **Deploy** (Railway shows a deploy button after variable changes).
3. Open the api service → **Deployments** → the new deploy → **Deploy Logs**. You should see
   `[postgres] storage ready ...`, then one of:
   - `Imported N records ... the file is now ....imported-<date>.bak` (your data moved over), or
   - `Fresh start (data version 2): the old data file was moved to ... and not imported`
     (old test data; the demo reseeds), or nothing extra if there was no data file.
4. Open `https://<your api domain>/health`. It should show `"storage":{"kind":"postgres","unsaved":0,"failing":false,...}`.
5. Keep the **/data** volume on api. It holds the imported file's backup.
6. If the Postgres service offers backups on your Railway plan, turn them on.

To go back to the JSON file: delete `DATABASE_URL` from the api variables. The app then uses
`DATA_FILE` again; anything saved only in Postgres stays in Postgres (rename the `.bak` back to
the `DATA_FILE` name first if you want the old file).

To look at the data: Postgres service → **Data** tab, or the queries at the bottom of
`db/schema.sql`. Don't edit rows while the app runs; it keeps its own copy in memory and
would write over the edit.

## Tests

`tests/postgres.test.ts` (21 tests here; 33 when `PG_TEST_URL` is also set):

- Pure: URL parsing (decoding, defaults, SSL settings, errors, redaction), SCRAM against the
  RFC 7677 example, MD5 format, jsonb text cleaning.
- On every available database: SCRAM login, parameters and types, multi-statement DDL, large
  results, errors with SQLSTATE and the connection staying usable, transactions rolling back,
  reconnect after the server session is killed (in flight and idle), messages split into
  tiny TCP pieces, PgStore round trip (insert/update/remove/kv, order, reopen), one flush =
  one transaction across several batches, changes during an in-flight save that then fails,
  one refused item not blocking the rest, newer copy taking over, the real app (seed + repair
  conversation) continuing after a restart on Postgres, first-boot import and its edge cases,
  and the file store without `DATABASE_URL`.
- Local throwaway cluster only: MD5 and cleartext logins, a wrong password failing fast, Unix
  socket connections, TLS (`require`, `prefer`, `verify-full`, `verify-ca`, self-signed refusal),
  server restart and a server coming back, and PgStore riding through a full outage.

The local cluster is started from the PostgreSQL binaries (`/usr/lib/postgresql/*/bin` or
`PG_BIN`) in a temp dir on a random port with its Unix socket in that dir, SCRAM and MD5 users
in `pg_hba.conf`, and a self-signed certificate when `openssl` exists. As root it runs as the
`postgres` user (via `runuser`). It is stopped and deleted at exit, on Ctrl-C and on SIGTERM.
Without binaries or `PG_TEST_URL` the database tests are skipped with the reason.

CI (`.github/workflows/ci.yml`) now starts a `postgres:16` service container and sets
`PG_TEST_URL` to it (a throwaway CI-only password, not a secret).

## Manual run (done on this branch)

Throwaway Postgres 16 on localhost, the real `src/api/server.ts`, `SEED_DEMO=true`, dev token:

1. No `DATABASE_URL`: seeded, a tenant text via `POST /api/dev/inbound` got an answer, SIGTERM exit 0,
   `/health` storage `{"kind":"file"}`.
2. Same `DATA_FILE` plus `DATABASE_URL`: `Imported 17 records and 16 engine entries ... the file is now
   keyhelm.json.imported-<date>.bak`; message count matched the file; a repair text created a work
   order; `/health` storage `{"kind":"postgres","unsaved":0,"failing":false,...}`; SIGTERM exit 0.
3. Restart with `DATABASE_URL`: `loaded 27 records and 22 engine entries`, no reseed, same 9 messages
   and 1 work order, waiting workflows (maintenance, renewal) still waiting, `dataVersion` 2.

## Known limits

- **Everything is in memory** (same as the JSON file store). Fine for this stage (many thousands
  of records); a later step can move reads into SQL if data grows a lot.
- **Saves trail by up to ~2 s.** A hard crash (not a normal redeploy) can lose changes from the
  last moment. A normal redeploy (SIGTERM) saves everything first.
- **jsonb orders object keys** (shorter keys first). Values and array order are kept, but after
  a restart an object such as a home's `facts` lists its keys in jsonb order, so listing bullet
  order can differ from the order typed. If that matters, change the two columns to `json`
  (one-line change in `pg-store.ts`; existing rows convert with `alter table ... type json`).
- **One running copy.** A second copy takes over and the first stops saving. Not for running
  several api copies at once.
- **Fresh starts (`DATA_VERSION`) apply only to the JSON file**, never to Postgres, so a version
  bump can't wipe real customer data. To start Postgres over, drop the three `kh_` tables.
- The client has no connection pool, COPY, LISTEN/NOTIFY, Kerberos/GSS/certificate login or
  SCRAM channel binding (`SCRAM-SHA-256-PLUS`); SASLprep is simplified for non-ASCII passwords
  (Railway passwords are ASCII).
