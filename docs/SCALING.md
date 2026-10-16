# Protecting the bill, and growing to a lot of users

Written for Nate: what is in place now, what each piece does, and what to build as Landwell grows.

## The short version

- **Nobody can run up the AI bill or flood the app.** Every person, phone number and account has limits, the AI has daily caps, and slow or huge requests are cut off. Your last line of defense is a hard monthly limit in the Anthropic console, which you set.
- **The app today handles early customers well, not hundreds of thousands.** That's normal. The pieces that need to change for real scale are listed below in order, with the rough point where each one matters.
- "Millions of requests a day" sounds huge, but it averages about 12 to 60 requests a second. With the steps below, that is very manageable.

## What's in place now (Oct 16, 2026)

| Protection | What it does | Default (change in Railway Variables) |
| --- | --- | --- |
| Per-visitor limit | Any one IP address can make 300 requests a minute. | `RL_IP_PER_MIN=300` |
| Signup limit | One IP can start 10 signups or checkouts an hour (each one creates Stripe records). | `RL_SIGNUP_PER_HOUR=10` |
| Public form limit | 20 rental applications or lease signatures an hour per IP. | `RL_FORM_PER_HOUR=20` |
| Owner limit | 600 requests a minute per signed-in owner. | `RL_OWNER_PER_MIN=600` |
| Sender limit | One phone number or email can send 30 messages an hour and 150 a day. Extra messages are dropped without an AI reply, so a spammer can't make us pay for replies. | `RL_SENDER_PER_HOUR=30`, `RL_SENDER_PER_DAY=150` |
| Wrong-token lockout | 20 failed sign-ins an hour per IP, then locked out. Tokens are compared in constant time. | `RL_AUTH_FAIL_PER_HOUR=20` |
| AI cap per owner | 400 AI replies per owner per day. Past that, the free built-in rules answer instead. | `AI_OWNER_DAILY_MAX=400` (both services) |
| AI cap for everyone | 20,000 AI replies a day across the whole service, then built-in rules. | `AI_DAILY_MAX=20000` (both services) |
| AI burst cap | 600 AI requests a minute into the AI service. | `AI_PER_MIN=600` (ai service) |
| Message trimming | Very long messages are cut to 1,500 characters before the AI sees them (long inputs cost more). | in code |
| Timeouts | A whole request must finish in 30 seconds and send its headers in 15. Calls to Claude time out at 25 seconds and fall back to the built-in rules. | in code |
| Size limits | Public requests up to 256 KB, signed-in owner uploads up to 2 MB, AI service 200 KB. | in code |
| Security headers | Stop the site being framed, sniffed or loaded over plain HTTP. | in code |
| Page cache | The website, legal pages, fonts and icon are built once, compressed (Brotli and gzip) and served from memory, with cache headers so browsers and a CDN can reuse them. Repeat visits get a tiny "not changed" reply. | in code |

**What an AI cap costs at most:** an AI reply on Claude Opus 5.5 costs roughly 2 to 3 cents (an estimate: about 2,000 tokens in and a few hundred out). At the 20,000 cap that's roughly $400 to $600 a day in the very worst case. Lower `AI_DAILY_MAX` to match your budget, and set the Anthropic console monthly limit lower still while testing.

### Set these spending ceilings yourself (5 minutes)

1. **Anthropic console**: Settings, Limits: set a monthly spend limit (for testing, $50).
2. **Railway**: Workspace settings, Usage: set a usage limit and an email alert.
3. **Twilio** (when set up): Messaging, Settings, Geo permissions: allow the US only. Turn on SMS pumping protection. Add a usage trigger alert.
4. **Stripe**: Radar is on by default; keep it on.

## One thing to verify after this deploy

The per-visitor limit needs each visitor's real IP address, which Railway passes along in a request header. I couldn't confirm from Railway's docs which header it is, so the code checks the two standard ones. If they ever showed the same address for everyone, all visitors would share one limit. I'll check this on the live app next session; until we have real traffic it can't cause problems.

## What the limits can't do yet

The limits count in each server's memory. With one api server that's exact. When we run several copies of the api (needed later for scale), each copy counts on its own, so the counts move to **Redis**, a fast shared memory store. That's step 3 below.

## The plan as we grow

Each step needs a "yes" from you, because steps 2 and 3 mean adding a few well-known building blocks (a Postgres driver, a Redis client). Today the project rule is "no runtime dependencies". That rule kept the prototype simple, but it has to bend for a database.

1. **Before the public launch: put Cloudflare in front of the domain** (free plan to start). This is the "load capacitor" for the website: Cloudflare keeps copies of pages and files in data centers near visitors, absorbs traffic floods, blocks known bad traffic, and can rate limit before requests ever reach Railway. Our cache headers are already set up for it.
2. **Before about 50 paying owners: Postgres instead of the JSON file.** Today all data lives in one file that is rewritten as it changes, and every lookup scans everything. Railway offers managed Postgres with backups. The table design is already in `db/schema.sql`, and the code reads data through one interface (`src/store/store.ts`), so the swap stays contained. Add real login and error alerts at the same time.
3. **Around 1,000 owners: several api servers, Redis, and a job queue.**
   - Run 2 or more copies of the api service behind Railway's load balancer, so one crash or deploy never takes the app down.
   - Redis holds the shared rate-limit counters and short-lived cache.
   - **A job queue is the real shock absorber**: if 5,000 texts arrive in one minute, they are written to the queue instantly and worker services reply at a steady pace, instead of everything hitting the AI at once. The workflow engine moves onto the queue.
4. **Tens of thousands of owners and up:** autoscaling workers, database read replicas, load tests before big launches (target: page loads under 300 ms, text replies under 10 seconds at 10 times normal traffic), and dashboards for errors, response times and AI spend.

## How fast is it today?

The website is served from memory and compressed (the home page goes from about 38 KB to about 10 KB). The slow part of any tenant reply is the AI itself (a few seconds), which is why replies happen in the background and never block the website.
