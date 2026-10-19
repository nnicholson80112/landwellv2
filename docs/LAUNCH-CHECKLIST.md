# Launch checklist

Nothing below is legal advice. Items marked **Attorney** need a Colorado attorney before launch.
We do not launch until every box in "Must do before launch" is checked.

## Done in code (Oct 16, 2026)

- Site design: no purple, no gradients, no pill-shaped buttons or badges, no emoji or glyph icons, no em dashes, no cursor or scroll effects, no stock or AI images (the only graphics are our own logo and simple line icons drawn in code).
- No fake reviews, testimonials, customer counts or metrics. Removed unsupported claims: "Most popular" (no customers yet), "Average 9% / 75%" (no cited source), "Most owners are running in about a week", "We give you a letter to end your current agreement", "Deposits returned before the deadline" (the owner returns deposits, not KeyHelm), "Paid" (the owner pays vendors), "Fair-housing safe by design", Zillow listings (not built: now "coming soon").
- Removed the public "Demo-day pricing" banner (it advertised a lower price to everyone, which undercuts the standard price under the FTC former-price rule; demo-day offers stay private, issued from /admin).
- The demo form used to say "we'll email you" but sent nothing. "Book a demo" now goes straight to Calendly (`/demo`), so we collect nothing ourselves.
- Fixed a bug where the signup window covered the page on load.
- Hero says what the product does, in plain words. Sample screens are labeled "Sample data" and described for screen readers.
- Pages: `/privacy`, `/terms`, `/cookies`, `/refunds`, `/accessibility`. Each shows a "Draft" notice until `LEGAL_REVIEWED=true`.
- Footer: legal name, mailing address, email, policy links (filled from Railway Variables).
- Favicon (`/favicon.svg`), `robots.txt`.
- Fonts are now served from our own site (SIL Open Font License files kept in `apps/site/fonts/`), so the site makes **zero** third-party requests: no analytics, no trackers, no embeds, no cookies.
- Signup: required "I agree to the Terms" checkbox, plain auto-renewal wording on the form and on the Stripe checkout page, optional unchecked SMS consent with STOP/HELP wording. What each owner agreed to, and when, is saved on their account. Owners who don't opt in to texts get their alerts by email.
- Rental application form: required consent to be contacted, link to the privacy policy.
- Accessibility: keyboard focus stays inside the signup window, Escape closes it, errors are announced, visible focus outlines, labels on every field, 44px+ buttons, reduced-motion respected. Color contrast checked: every text color passes WCAG AA in light and dark mode (one error color was fixed).
- Abuse and cost limits: see `docs/SCALING.md`.

## Must do before launch

- [ ] **Pick the name**, run the USPTO search (classes 9, 42, 36), then the attorney's knockout search.
- [ ] **Form the business** (LLC or similar) and get a mailing address you're comfortable publishing (a registered agent or virtual mailbox is fine).
- [ ] **Buy the domain** and connect it in Railway (api service, Settings, Networking, Custom Domain). Update `PUBLIC_URL`.
- [ ] **New accounts on the business email** for GitHub (private repo), Railway, Stripe, Anthropic, Calendly, Twilio, Postmark. See HANDOFF issues 7 and 8.
- [ ] **Railway Variables** on the api service: `BUSINESS_LEGAL_NAME`, `BUSINESS_ADDRESS`, `BUSINESS_EMAIL`, `BUSINESS_PHONE` (optional), `LEGAL_EFFECTIVE_DATE` (YYYY-MM-DD). Then `LEGAL_REVIEWED=true` only after the attorney signs off.
- [ ] Remove the "Made with AI" tag: there isn't one on the Railway site. The copies published on claude.ai (artifact links in HANDOFF) are private previews only and are never the public site.
- [ ] **Attorney** reviews: privacy, terms, cookie, refund pages; the bracketed sections in the Terms (12-month early cancellation and renewal, liability limits, disputes); `src/config/colorado.ts`; the guardrails; pricing and offer copy; the sample lease and signing page.
- [ ] **Decide 12-month agreement terms** (early cancellation, what happens at month 12) or hide the 12-month option until decided. It is currently selectable at checkout.
- [ ] **Self-serve cancel button** in the owner account (the refund page says to email us for now; federal ROSCA rules expect cancelling to be simple).
- [ ] **Account deletion job**: the privacy policy promises deletion or de-identification within 90 days after an account closes. That isn't built yet.
- [ ] **Real login** for owners (today it's a shared bearer token) and turn `DEV_TOOLS` off in production.
- [ ] **Twilio**: A2P 10DLC registration (the opt-in wording on the site matches what carriers require), set `TWILIO_AUTH_TOKEN` so webhooks are verified, set Geo Permissions to US only and turn on SMS pumping protection.
- [ ] Remove the test owner and set `SEED_DEMO=false`.
- [ ] Postgres instead of the JSON file, with backups (see `docs/SCALING.md`).
- [ ] Hard spending caps: Anthropic console monthly limit, Railway usage limit, Twilio and Stripe alerts.
- [ ] Ask an accountant about sales tax: Colorado itself generally doesn't tax software subscriptions, but some home-rule cities may.

## Laws and risks to review with the attorney

| Area | Why it matters to us | Status |
| --- | --- | --- |
| FTC Act and the FTC rule on fake reviews (16 CFR Part 465) | No fake reviews, testimonials or invented numbers. | None on the site. Keep it that way. |
| FTC former-price guide (16 CFR 233.1) | "Standard" prices must be real prices people pay. | Public demo-day deal removed; offers are private and time-limited. |
| ROSCA (federal) and Colorado automatic-renewal rules | Subscriptions must disclose renewal clearly, get consent, and be easy to cancel. | Disclosure and checkbox added. Self-serve cancel still to build. **Attorney**: confirm the Colorado statute and whether it covers landlords buying for their business. |
| TCPA, CTIA rules, A2P 10DLC | Texts need consent, STOP/HELP, and our privacy policy must say mobile data isn't shared for marketing. | Opt-in, wording and policy language added. Owner texts respect opt-out. Tenants' consent comes through the owner: **Attorney** to confirm that's enough, and whether tenants need a first-message notice. |
| Colorado AI Act (SB24-205, as amended) | Requires telling people when they are talking to an AI, and adds duties for AI used in "consequential decisions" such as housing. | The AI says it's automated at the start of each conversation and never scores or decides applications. **Attorney**: confirm current effective date and whether once per conversation is enough. |
| Fair Housing Act, Colorado fair housing law, HUD guidance on AI and advertising | The AI must not steer or screen people. | Guardrails route these topics to the owner. **Attorney** to review the guardrail lists. |
| Colorado brokerage licensing (property management for others) | KeyHelm must stay software, not unlicensed property management. | Software-only copy everywhere; no showings, no money handling. **Attorney** to confirm. |
| FCRA (screening) | Adverse action notices when an owner denies based on a report. | Flow exists; **Attorney** to review wording. |
| Colorado Privacy Act | Applies once we handle data on 100,000+ Colorado consumers a year (or 25,000 and sell data). | Not yet, but the policy already offers access, correction and deletion to everyone. |
| Website accessibility (ADA) | Inaccessible sites draw demand letters. | Built to WCAG 2.1 AA; no independent audit yet. |
| E-SIGN Act and Colorado UETA | Lease signing must capture consent to sign electronically. | Signing page has a consent step; **Attorney** to review. |
| Trademark | "KeyHelm" is a placeholder and not cleared. | Pick and clear the name before the domain, Twilio and Stripe profile. |
| Images and fonts | Copyright. | No photos. Fonts are open-licensed. Icons and logo are our own. |
