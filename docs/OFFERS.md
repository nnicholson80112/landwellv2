# Billing, private offers and onboarding

KeyHelm charges owners for KeyHelm only. It never collects rent.

## Plans and the pricing model

**Standard price** = about 15% above the original price, rounded up to whole $5 steps. It's what
anyone without an offer pays, and what every customer pays once their offer months end.
**Original-price offers** bring it back to the offer price for a set number of months (an exact
dollar amount off per door, so $45 lands on $35).

| Plan | Standard, month-to-month | Standard, 12-month | Offer price, month-to-month | Offer price, 12-month |
| --- | --- | --- | --- | --- |
| Essentials | $20 | $15 | $15 | $10 |
| Autopilot | $45 | $35 | $35 | $30 |
| Autopilot Plus | $70 | $60 | $60 | $50 |

Prices are per door per month. The first month is charged at checkout. There's no setup fee.
Stripe holds the standard prices under lookup keys `keyhelm_<plan>_<monthly|contract12>`;
`BASE_PRICE` and `LIST_PRICE` in `src/billing/offers.ts` must match them.

> **Keep the standard price real.** US pricing rules (FTC 16 CFR 233.1) only allow a "regular"
> price next to a discount if it's a price you actually charge, openly and in good faith, for a
> real period of time. That's why offers are private, expire and last a set number of months, and
> why customers pay standard afterward. Don't hand an offer to everyone forever, and don't put
> "was $45, now $35" on the public site unless people really pay $45. Have the attorney
> check the pricing copy and the 12-month agreement before launch.

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

| Type | Who issues it | Default | Limits | Use it for |
| --- | --- | --- | --- | --- |
| Demo-day | Admin, during/after a live demo | Original price for the whole 12-month agreement (or 3 months month-to-month) | Expires within 7 days | Closing on the call |
| Web intro | Automatic at self-serve signup | Original price for month 1 (or 3 months with a 12-month agreement) | Up to 3 months | People who buy without a demo |
| Win-back | Admin, canceled owners only | Original price for 3 months | Up to 6 months (12-month) | Bringing back former customers |
| Referral | Automatic from a friend's link | Original price for 3 months; referrer gets $50 credit after the friend's first paid month | Up to 3 months | Word of mouth |
| Seasonal event | Admin, to a list of people | Original price for 6 months, or a custom % | 12-month only, ≤21 days | Named events (Spring Leasing, Year-End) |

Admins can also pick **Custom % off the standard price**, capped per type (demo/win-back 25%,
seasonal/referral 20%, web 15%) and never below the price floor. Month-to-month offers last at most 3 months.

## Where it lives

- `/admin` (needs `ADMIN_API_TOKEN`): issue offers from presets, copy the personal link, revoke, see customers, subscription and onboarding status, connect Calendly.
- `/offer/<id>`: the personal offer page. The link is the only way in.
- `/play`: the owner's view: plan, billing, their offers, referral link, checkout.
- Website **Get started** → `/api/public/signup` → Stripe Checkout (with the web intro offer) → `/billing/done` → Calendly.

## Calendly

1. `CALENDLY_URL`: your onboarding event link. After payment, buyers land there with name and email filled in.
2. To track bookings (paid Calendly plan): add `CALENDLY_TOKEN` (Calendly → Integrations → API & Webhooks → personal access token) and `CALENDLY_WEBHOOK_SECRET` (any long random string) in Railway, then click **Connect Calendly bookings** in `/admin`. Bookings then show on each customer.
