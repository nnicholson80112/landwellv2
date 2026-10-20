# KeyHelm (working name)

Software that runs small-landlord property management. Tenants, prospects and
vendors text one number; KeyHelm answers, books repairs, sends rent reminders,
fills leases and keeps Colorado deadlines, and texts the owner only when a
decision is theirs.

> **KeyHelm never collects, holds or moves rent, deposits or vendor payments.**
> Tenants pay the owner directly and the owner marks rent received. The only money
> KeyHelm charges is its own subscription (per door per month, month-to-month or 12-month),
> billed through Stripe (`src/billing/stripe.ts`).

> "KeyHelm" is a placeholder. Run a trademark search before using it. The name
> and colors live in `src/config/brand.ts` and `apps/site/site.body.html`.

## Quick start

Needs Node.js 22.6 or newer. Nothing else to install for the demo.

```bash
npm run demo        # runs every workflow on sample data with a simulated clock
npm test            # 18 tests: engine, guardrails, workflows end to end, API
npm run build:review  # rebuilds apps/review/review.html from a fresh demo run
npm start           # API + website on http://localhost:8787 (token: dev-token)
npm run ai          # in-house AI service on :8788 (needs AI_SERVICE_TOKEN)
```

Try it against the running server:

```bash
curl -X POST localhost:8787/api/dev/inbound -H 'authorization: Bearer dev-token' \
  -H 'content-type: application/json' \
  -d '{"from":"+17205550111","body":"The kitchen faucet is leaking"}'
curl localhost:8787/api/dashboard -H 'authorization: Bearer dev-token'
```

## How it fits together

```
 Texts / email / voice ──► webhooks ──► message.received ──► Front desk workflow
                                                              │  guardrails → AI → guardrails
                                                              ▼
        maintenance.requested · showing.requested · renewal.response · moveout.notice …
                                                              │
                                                              ▼
            Workflow engine (durable: waits for vendors, owners, dates; survives restarts)
              │                     │                        │
        Adapters (Twilio,     Owner approvals         Store (records, audit log,
        Seam, e-sign)          by text "YES 4F2"       workflow runs)
```

| Folder | What's in it |
| --- | --- |
| `src/engine/` | The durable workflow engine (`engine.ts`) and clock helpers |
| `src/workflows/` | Every business workflow. Start with `inbound-message.ts` and `maintenance.ts` |
| `src/ai/` | The communication-AI plug-in point, rule-based fallback, Claude and HTTP providers, fair-housing guardrails |
| `src/adapters/` | Outside services: mock versions plus Twilio, Postmark, Seam, built-in e-sign |
| `src/config/` | Brand, and `colorado.ts`: every Colorado rule the workflows enforce, with citations |
| `src/api/server.ts` | HTTP API, webhooks (texts, email, phone calls, Stripe billing), application form, lease signing page |
| `src/billing/` | KeyHelm's own subscription billing (Stripe Checkout + webhook) and private offers. Never rent. See `docs/OFFERS.md` |
| `apps/admin/` | `/admin`: issue private offers, see customers and onboarding |
| `src/ai-service/` | KeyHelm AI: the in-house AI service (separate Railway service) |
| `src/leases/` | Turns an owner's own lease into a fill-in template |
| `src/sim/` | Demo data and the end-to-end demo |
| `apps/site/` | Marketing website |
| `db/schema.sql` | Postgres schema for production |
| `docs/` | `WORKFLOWS.md` (every flow), `AI-PLUGIN.md` (the AI), `DEPLOY.md` (Railway + webhooks), `RENAMING.md` |

## What is real and what is mocked

| Piece | Status |
| --- | --- |
| Workflow engine, all 16 workflows, guardrails, lease templating, API, signing page | Working and tested |
| AI | Rule-based works offline. Claude and in-house HTTP providers are written; add a key to turn them on |
| Twilio SMS, Postmark email, Seam locks | Written against each vendor's API; turn on by adding keys in Railway Variables. Twilio needs A2P 10DLC registration (`docs/notes/twilio-a2p.md`) |
| Stripe subscription billing | Live in test mode. On boot the server creates any missing prices, the webhook and the billing portal (`src/billing/catalog.ts`) |
| ID verification, screening, listing syndication | Mock links today. Pick partners (e.g. Stripe Identity, a screening company, the Zillow rental feed) and implement the adapter interface |
| Owner app | `/app`: homes, tenants, vendors, rules, leases, approvals, rent received, messages, billing. See `docs/notes/owner-ui.md` |
| Login | Email and password (scrypt), session cookie, one-time sign-in links, password reset. See `docs/notes/owner-api.md` |
| Storage | JSON file, or Postgres when `DATABASE_URL` is set (`docs/notes/postgres.md`). Daily backups |

## Before real tenants touch it

The full click list is in `docs/HANDOFF.md` (section 5, "Go-live checklist"). In short:

1. Add Postgres in Railway and set `DATABASE_URL`.
2. Twilio A2P 10DLC registration approved (US carriers block unregistered business texting).
3. Swap Stripe to live keys; the server creates the live prices, webhook and portal itself.
4. Set `SEED_DEMO=false` and `DEV_TOOLS=false`.
5. Run the founding client for one full month on text and email before turning on voice.
