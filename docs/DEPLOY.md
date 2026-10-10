# Going live on Railway

Two Railway services from this one repo, plus a volume each.

| Service | Start command | Volume | Public URL |
| --- | --- | --- | --- |
| `api` (website, owner API, webhooks, workflows) | `npm start` | `/data` | yes, e.g. `app.landwell.example` |
| `ai` (Landwell AI, the in-house brain) | `npm run ai` | `/data` | no, private networking only |

## Steps

1. Push this folder to a GitHub repo. In Railway: **New Project → Deploy from GitHub repo**. It builds from the `Dockerfile` (Node 22, no packages to install).
2. That first service is `api`. Add a **Volume** mounted at `/data`. Set the variables below.
3. In the same project, add a second service from the same repo and call it `ai`. Under **Settings → Start Command** enter `npm run ai`. Add a volume at `/data`. Leave it without a public domain. The `api` service reaches it at `http://ai.railway.internal:8788`.
4. Under **Settings → Networking**, give `api` a public domain. Put it in `PUBLIC_URL`.
5. Point the outside services at `api` (next section).

## Variables

`api`:
```
PUBLIC_URL=https://<your api domain>
DATA_FILE=/data/landwell.json
OWNER_API_TOKEN=<long random string>
AI_PROVIDER=http
AI_HTTP_URL=http://ai.railway.internal:8788/respond
AI_HTTP_TOKEN=<same value as AI_SERVICE_TOKEN below>
STRIPE_SECRET_KEY=sk_test_...          # sandbox first. Landwell's own subscription billing only
STRIPE_WEBHOOK_SECRET=whsec_...
POSTMARK_TOKEN=...
EMAIL_FROM=Landwell <hello@your-domain>
EMAIL_WEBHOOK_SECRET=<random>
TWILIO_ACCOUNT_SID=...                 # when Twilio is ready
TWILIO_AUTH_TOKEN=...
TWILIO_FROM=+1...
DEMO_OWNER_PHONE=<your cell>           # approvals get texted here
DEMO_TENANT_PHONE=<a second phone you control, to play the tenant>
DEMO_BEDS=  DEMO_BATHS=  DEMO_RENT=    # real numbers for 7610 S Rosemary Cir
```

`ai`:
```
PORT=8788
AI_SERVICE_TOKEN=<long random string>
AI_MODEL_PRIMARY=anthropic
ANTHROPIC_API_KEY=...
ANTHROPIC_MODEL=<current Claude model id>
AI_LOG_DIR=/data/ai-logs
AI_LOG_RETENTION_DAYS=90
```

Never paste keys into chat or commit them. Set them only in Railway's Variables tab.

## Webhooks to point at the `api` service

| Service | Where to set it | URL |
| --- | --- | --- |
| Twilio, texts | Phone number → Messaging → "A message comes in" | `https://<api>/webhooks/twilio/sms` |
| Twilio, calls | Phone number → Voice → "A call comes in" | `https://<api>/webhooks/twilio/voice` |
| Postmark inbound | Server → Inbound stream → webhook | `https://<api>/webhooks/email?key=<EMAIL_WEBHOOK_SECRET>` |
| Stripe (Landwell billing only) | Developers → Webhooks → add endpoint, events `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed` | `https://<api>/webhooks/stripe` |

## Stripe prices, offers and Calendly

See `docs/OFFERS.md`. Checkout finds prices by lookup key `landwell_<plan>_<monthly|contract12>`
(already created in the sandbox). To change a price, create a new one in Stripe and move the lookup key.

More `api` variables:
```
ADMIN_API_TOKEN=<long random string>     # opens /admin (private offers, customers)
CALENDLY_URL=https://calendly.com/<you>/<onboarding-event>
CALENDLY_TOKEN=<Calendly personal access token>       # optional: booking tracking
CALENDLY_WEBHOOK_SECRET=<long random string>          # optional: booking tracking
```

## Heads-up about the demo data

On first start, `api` seeds the demo owner, 7610 S Rosemary Cir, and GlassHouse Exteriors at 720-930-5782.
**Once Twilio is connected, repair jobs really text that number.** That's the point for the demo, but expect the texts.
The other sample vendors and tenants use 555 numbers that go nowhere. Set `SEED_DEMO=false` once real owners sign up.

## Before real tenants

- Postgres instead of the JSON file (`db/schema.sql`), real login, backups
- Twilio A2P 10DLC approved
- Attorney review of `src/config/colorado.ts`, guardrails and the lease
