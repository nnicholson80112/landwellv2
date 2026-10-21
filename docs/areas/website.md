# Area 1: Website

**Subagents:** `site-builder` (builds and edits pages), `site-copywriter` (words, claims, prices,
Twilio wording), `site-qa` (read-only audit: phones, accessibility, speed, links, consistency).
Typical run: copywriter and builder make a change, then `site-qa` checks it.

**Deeper notes:** `docs/notes/site-and-sms.md` (what's on every page and why),
`docs/notes/twilio-a2p.md` (what Twilio's reviewers check), `docs/LAUNCH-CHECKLIST.md` (brand rules).

## Goals

- [x] One-page KeyHelm site at `/`: hero, how it works, who does what, savings calculator, pricing,
      FAQ, signup window (Get started) and Book a demo call.
- [x] Prices on the site match Stripe ($10/$8, $15/$12, $20/$16 per door) and are checked by tests.
- [x] Legal pages: `/privacy`, `/terms`, `/sms`, `/cookies`, `/refunds`, `/accessibility`. No
      placeholders left; Nate approved the legal wording (no attorney review needed).
- [x] `/sms` program page and texting clauses Twilio A2P 10DLC requires.
- [ ] **The new site isn't live yet**: the deploy of `270af79` didn't go through (infrastructure.md).
      The live site still shows the Oct 19 version.
- [ ] **Real business email** in the footer, `/sms` and the HELP reply. Today it falls back to the
      placeholder `help@keyhelm.example` until Nate sets `BUSINESS_EMAIL` in Railway (needs the domain).
- [ ] **Custom domain** (keyhelm.something). Twilio reviewers want the website and email on the
      brand's domain. Nate buys it; `release-engineer` connects it.
- [ ] **Coordinate with Nate's partner, who is building a website for the Twilio registration.**
      Decide which site Twilio reviewers see. Either (a) the partner's site links to or reuses KeyHelm's
      `/sms`, `/privacy` and `/terms` pages, or (b) the partner's site copies the exact texting wording.
      The opt-in words must match word for word everywhere: they come from `OWNER_SMS_OPT_IN` and the
      helpers in `src/api/legal.ts`, so copy them from the live pages, never retype them.
- [ ] Phone-width and dark-mode check of every page after the deploy (390px and 1280px).
- [ ] Real screenshots or a short product video for the hero once the owner app is live (no fake data
      presented as real; label samples "Sample data").
- [ ] Switch "Recommended" to "Most popular" on Autopilot only once it's true.
- [ ] Optional: social preview image and page descriptions for sharing links; a `/demo` page that
      explains the call before sending people to Calendly.

## Where things stand (Oct 21)

Built and tested on `main` (`270af79`), not yet live. `npm run build:site` turns
`apps/site/site.body.html` into `apps/site/index.html` (never edit `index.html` by hand). No
third-party scripts, fonts, trackers, cookies or browser storage on the site. Fonts are self-hosted
in `apps/site/fonts/`.

## Files

| Path | What |
| --- | --- |
| `apps/site/site.body.html` | The website (HTML, CSS, small inline script for the calculator and signup window) |
| `apps/site/index.html` | Built output, committed. Rebuild after every edit |
| `apps/site/fonts/` | Bricolage Grotesque and Figtree, self-hosted |
| `scripts/build-site.mjs` | The build (also runs on `npm start`) |
| `src/api/legal.ts` | Every legal page, the `/sms` page, shared texting wording and keyword replies |
| `src/config/brand.ts`, `src/config/business.ts` | Name, colors, fonts; legal name, email, address, phone from Railway variables |
| `src/api/server.ts` | Serves the site and legal pages from a compressed in-memory cache (`loadStatic()`), `/demo` redirect to `CALENDLY_URL` |
| `tests/site.test.ts` | Prices, no old name, no dashes, no external requests, legal pages, `/sms` content |

## Rules for this area

- Brand: sky-white `#F6F9FF`, navy `#0E1B33`, KeyHelm blue `#1B4DFF` (main buttons), sunny yellow
  `#FFC83D`, mint `#0E9F6E`. Headlines Bricolage Grotesque, body Figtree. Bright and inviting with
  strong calls to action.
- No pills, gradients, em or en dashes, made-up claims, testimonials, customer counts or stats.
- Never say KeyHelm collects rent or deposits. Never describe neighborhoods, schools or safety.
- Prices come from `src/billing/offers.ts` (`LIST_PRICE`). If prices change, change them there,
  in Stripe, and in the site, then run the tests.
- Texting opt-in wording is shared code. Change it in `src/api/legal.ts` only.

## How to check your work

```
npm run build:site && npm test        # site.test.ts catches price, wording and link drift
npm start                             # http://localhost:8787 ; also /privacy /terms /sms /refunds
```
Screenshots at phone and desktop width with the preinstalled Chromium (Playwright is configured; do not
run `playwright install`). After a deploy: `node scripts/live-check.mjs https://api-production-66895.up.railway.app`.

## Questions only Nate can answer

- Which domain? Which inbox for `BUSINESS_EMAIL`?
- Will Twilio reviewers see the partner's site or this one? Can the partner link to `/sms`?
- Is there a business address or phone to show (optional; never a home address)?
