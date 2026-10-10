# Workflows

Fifteen workflows run the business. Each one starts from an **event** (something
happened) or a **schedule**, and can **wait**: for a reply, for the owner, or for
a date. Waiting runs survive restarts. **Owner** marks the only steps that need a person.

The owner decides from the app or by texting back the code in each request, for example `YES 4F2`.

---

## 1. Front desk: incoming message (`inbound-message`)
**Starts:** any text, email or voice turn (`message.received`).

1. Save the message, work out who sent it: owner, tenant, vendor, prospect or new number (a new number becomes a prospect).
2. **Owner** texting `YES 4F2` / `NO 4F2` → decides that approval.
3. **Vendor** → read accept/decline, time window, estimate, "done" and invoice → wakes the repair that's waiting on them.
4. Tenant sending the photo we asked for → attached to the open repair.
5. Prospect replying `1`/`2`/`3` → picks a showing time.
6. **Guardrails first**: emergency → safety reply + emergency repair. Accommodation, fair-housing topics, application-decision questions, complaints → fixed reply, **Owner** gets a to-do and a text.
7. **AI** classifies and drafts using only the facts on file → **guardrails check the draft** → reply sent.
8. Hands off: repair, showing, renewal answer, move-out notice.

## 2. Repair request (`maintenance`)
**Starts:** `maintenance.requested` (from a text, the owner, or the app).

1. Work order created with Colorado's response deadline (24h for health/safety, 72h otherwise; SB24-094).
2. Ask for a photo; wait up to 2h (skipped for emergencies). Emergencies text the owner immediately.
3. Text the best vendor (preferred, right trade, emergency-capable if needed). Wait 20 min (emergency) / 2h (urgent) / 4h (routine); try up to 3 vendors.
4. No vendor → **Owner**: "I'll arrange it" or cancel.
5. No estimate yet → ask for one.
6. Over the owner's limit (or emergency limit) → **Owner** approves or declines.
7. Book it: vendor gets the address and tenant contact; tenant gets the time.
8. Wait for "DONE $amount" (nudge after 7 days; to-do after 14).
9. Invoice more than 10% / $25 over the quote → **Owner** approves or disputes.
10. Record the expense, mark paid, tell owner and tenant.

## 3. Daily rent check (`rent-cycle`) — every day 6:00 AM
5 days before the due date: create the charge and text the pay link (or an autopay heads-up). Due date: reminder. After the grace period: start **Late rent**. Never charges for past months when an owner first joins.

## 4. Payment received (`payment-received`)
**Starts:** Stripe webhook when ACH actually settles. Records the payment, texts a receipt, stops late notices. Webhook retries can't double-count.

## 5. Late rent (`late-rent`)
1. Friendly reminder to tenant; heads-up to owner.
2. Rent 7+ days late → late fee capped at the greater of $50 or 5% (SB21-173), only if the owner set one.
3. Day 12 unpaid → **Owner** picks: send the 10-day demand (we prepare it; the owner has it delivered properly), offer a payment plan, or keep waiting. Landwell never files anything.

## 6. Rental application (`application`)
1. Applicant gets the screening partner's link (they authorize and pay the partner directly). Arrival order recorded.
2. Report arrives → laid next to the owner's written criteria, row by row: meets / doesn't / review. **No score, ranking or recommendation.**
3. **Owner** approves or denies.
4. Approved → lease starts. Denied → FCRA adverse-action notice with the screening company's contact details.

## 7. Lease and move-in (`lease`)
1. Uses the owner's own uploaded lease. Blanks were turned into fields on upload; values fill in automatically.
2. Anything left blank → **Owner** fills it in the app.
3. Colorado check: only one rent increase per 12 months.
4. Each tenant signs on the built-in signing page (document hash, time, IP and consent recorded), then **Owner** signs.
5. New tenancy: deposit and first-month pay links, other applicants told the home is leased, listing taken down, move-in details 2 days before, tenant active on day one.

## 8. Showing (`showing`)
Self-showing: ID check link → 3 time choices → one-time door code 15 min before (works for 1 hour) → code revoked → feedback and apply link. Owner-led showing (or no smart lock): **Owner** confirms a time.

## 9. Listing a vacancy (`listing`)
Listing copy with one all-in rent (HB25-1090) and an Equal Housing line → fair-housing wording check → **Owner** publishes → posted (manual copy-paste until the Zillow feed is approved) → past prospects who opted in get a text.

## 10–11. Renewals (`renewal-sweep` daily 7:00 AM → `renewal`)
At the owner's lead time (default 120 days): **Owner** sets rent and term, or chooses not to renew and must pick a Colorado for-cause reason (HB24-1098, generally 90 days' notice). Tenant replies YES → renewal lease (workflow 7); NO → move-out.

## 12. Move-out and deposit (`move-out`)
Confirm the date, ask for a forwarding address, start the listing early, walkthrough to-do for the owner, reminders. After move-out: **Owner** returns the full deposit or enters deductions. Escalates at day 21; itemized statement and refund before the 30-day deadline (HB25-1249).

## 13. Tenant welcome (`tenant-welcome`)
When the owner adds a tenant: how to text repairs, autopay link, STOP to opt out.

## 14. Monday owner report (`weekly-report`) — Mondays 7:00 AM
Rent collected, repairs, messages handled, decisions and to-dos waiting.

## 15. New owner setup (`onboarding`)
Six-step checklist, welcome text, nudges at day 2 and day 7 until homes, lease, tenants, vendors, rules and bank are in.

---

### Adding a workflow
Write a `WorkflowDef` in `src/workflows/`, add it to `ALL_WORKFLOWS` in `index.ts`. Inside it, do every side effect through `ctx` (`ctx.step`, `send`, `ctx.approval`, `ctx.waitFor`, `ctx.sleep`) so it runs exactly once even when the workflow pauses and resumes.
