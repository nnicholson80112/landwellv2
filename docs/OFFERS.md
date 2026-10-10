# Billing, private offers and onboarding

Landwell charges owners for Landwell only. It never collects rent.

## Plans

| Plan | Month-to-month | 12-month agreement (billed monthly) |
| --- | --- | --- |
| Essentials | $15 / door | $13 / door |
| Autopilot | $35 / door | $30 / door |
| Autopilot Plus | $59 / door | $50 / door |

The first month is charged at checkout. There is no setup fee. Prices live in Stripe
under lookup keys `landwell_<plan>_<monthly|contract12>`; `LIST_PRICE` in
`src/billing/offers.ts` must match them (it's used for quotes and the price floor).

> The 12-month agreement needs written terms (early cancellation, renewal, how to cancel)
> reviewed by an attorney before it's sold. Checkout shows a one-line notice; that is not a contract.

## What the research showed (Oct 2026)

| Company | What they do | What we borrowed |
| --- | --- | --- |
| Housecall Pro | Cheaper with annual billing (about 9–25% depending on plan); rotating new-customer intro prices; $200/$200 two-sided referral reward | Contract price; small web intro offer; two-sided referral |
| Jobber | Standing "save 25% with annual" swapped for a time-limited "up to 40%" event tied to annual billing, with a hard end date | Seasonal events only on 12-month agreements, always with an end date |
| West Shore Home | One written price at the in-home consultation, same day; named savings events with an end date | Demo-day offer: issued during the demo, short real deadline |
| Nike | Member-only, single-use codes tied to one account; not combinable; best eligible offer applied automatically | Every offer belongs to one person; one per checkout; best one auto-applies |
| Hulu | Time-boxed intro deals; win-back offers by personal email code to former subscribers only | Win-back offers only for canceled owners, by personal link |

"Flyra" couldn't be identified, so Jobber (Housecall Pro's closest competitor) stands in.

## How offers stay private and profitable

- **One person each.** An offer is issued to one owner or one email. It's applied by the server at checkout. There is no code to type, so nothing can be shared or posted on a coupon site.
- **Single-use Stripe coupon** created at checkout (`max_redemptions=1`, expires with the offer). Public promotion codes are off.
- **No stacking.** One offer per subscription. If someone holds several, the most valuable eligible one applies.
- **Real deadlines.** Every offer expires. Don't reissue an "expiring" offer to the same person, or the deadline stops being true (and turns into a deceptive-pricing risk).
- **Limits per type** (`OFFER_RULES`): max %, max months, max days, allowed billing.
- **Price floor** (`PRICE_FLOOR`): no offer can push any plan below a minimum per-door price. Set the floors from real cost to serve (texting, AI, support) plus margin. Today's numbers are placeholders.
- **Big discounts need the 12-month agreement** (demo and seasonal), so a discount buys a longer customer.

## Offer types

| Type | Who issues it | Limit | Use it for |
| --- | --- | --- | --- |
| Demo-day | Admin, during/after a live demo | ≤30%, ≤3 months, 12-month only, ≤7 days | Closing on the call |
| Web intro | Automatic at self-serve signup | ≤15%, ≤2 months | People who buy without a demo |
| Win-back | Admin, canceled owners only | ≤25%, ≤3 months | Bringing back former customers |
| Referral | Automatic from a friend's link | ≤20%, ≤2 months; referrer gets $50 credit after the friend's first paid month | Word of mouth |
| Seasonal event | Admin, to a list of people | ≤20%, ≤2 months, 12-month only, ≤21 days | Named events (Spring Leasing, Year-End) |

## Where it lives

- `/admin` (needs `ADMIN_API_TOKEN`): issue offers from presets, copy the personal link, revoke, see customers, subscription and onboarding status, connect Calendly.
- `/offer/<id>`: the personal offer page. The link is the only way in.
- `/play`: the owner's view: plan, billing, their offers, referral link, checkout.
- Website **Get started** → `/api/public/signup` → Stripe Checkout (with the web intro offer) → `/billing/done` → Calendly.

## Calendly

1. `CALENDLY_URL`: your onboarding event link. After payment, buyers land there with name and email filled in.
2. To track bookings (paid Calendly plan): add `CALENDLY_TOKEN` (Calendly → Integrations → API & Webhooks → personal access token) and `CALENDLY_WEBHOOK_SECRET` (any long random string) in Railway, then click **Connect Calendly bookings** in `/admin`. Bookings then show on each customer.
