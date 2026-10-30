# Workflows

Seventeen workflows run the business. Each one starts from an **event** (something
happened) or a **schedule**, and can **wait**: for a reply, for the owner, or for
a date. Waiting runs survive restarts. **Owner** marks the only steps that need a person.

The owner decides from the app or by texting back the code in each request, for example `YES K4P` (codes are letter-digit-letter and never repeat among open decisions). Decisions with three or more choices take a number (`2 K4P`); a bare `YES` works when only one decision is open. Extra details can follow the code: `YES K4P $2,850 12 months` (renewal rent and term), `YES K4P $1,500` (part of the rent arrived), `NO K4P carpet cleaning $150, blinds $40` (deposit deductions).

**Texting rules that apply everywhere:** STOP turns off texts to that number (tenants' notices fall back to email and the owner is told); START turns them back on. Notices that can wait (rent reminders, renewal offers, move-out steps, deposit statements) are held until the owner's quiet hours end; replies, repairs and emergencies go right away. Routine and urgent repair requests don't text vendors during quiet hours. "Thanks!" and empty texts get no reply and don't ping the owner.

---

## 1. Front desk: incoming message (`inbound-message`)
**Starts:** any text, email or voice turn (`message.received`).

1. Save the message, work out who sent it: owner, tenant, former tenant, vendor, prospect or new number (a new number becomes a prospect; the home they name, like "Aspen", is remembered).
2. **Owner** texting `YES K4P` / `NO K4P` / `2 K4P` → decides that approval.
3. **Vendor** → read accept/decline ("not available" is a no), time window ("2pm tomorrow", "on my way"), estimate, "done" and invoice → wakes the repair that's waiting on them.
4. Tenant sending the photo we asked for → attached to the open repair. A photo a bit later → added to the open repair and forwarded to its vendor (unless the text describes a different problem).
5. Prospect replying `1`/`2`/`3` → picks a showing time; "Sunday afternoon instead?" → new times.
6. **Answers to something we asked:** a forwarding address after a move-out notice; a reply to a payment-plan offer (goes straight to the owner); YES/NO to a renewal offer ("No hot water" is not a no); YES to "want a tour?" or "want a text when a home opens up?".
7. **Former tenants** → always routed to the owner (deposit questions).
8. A prospect asking about one of the owner's homes that isn't for rent → told so, with the homes that are.
9. **Guardrails first**: emergency → safety reply + emergency repair. Accommodation, application-decision questions, complaints → fixed reply, **Owner** gets a to-do and a text. Fair-housing topics → neutral reply and an FYI text to the owner (no to-do).
10. **AI** classifies and drafts using only the facts on file (including open repairs and which rent the owner has marked received) → **guardrails check the draft** → reply sent.
11. Hands off: repair, showing (never a second one while one is booked), renewal answer (a renewal "yes" with no offer out goes to the owner instead of promising a lease), move-out notice.

## 2. Repair request (`maintenance`)
**Starts:** `maintenance.requested` (from a text, the owner, or the app).

1. The same problem reported again (same trade, same room, similar words, last 3 days) joins the open job instead: the note goes to the vendor and the tenant hears the status.
2. Work order created with Colorado's response deadline (24h for health/safety, 72h otherwise; SB24-094).
3. Routine jobs: ask for a photo and wait up to 1h. Urgent and emergency jobs go straight out. Emergencies text the owner immediately. Routine and urgent jobs wait for quiet hours to end before texting vendors.
4. Text the best vendor (preferred, right trade, emergency-capable if needed). Wait 20 min (emergency) / 2h (urgent) / 4h (routine); try up to 3 vendors.
5. No vendor → tenant gets a "still lining up a pro" update; **Owner**: "I'll arrange it" or cancel.
6. No estimate yet → ask for one.
7. Over the owner's limit (or emergency limit) → **Owner** approves or declines.
8. Book it: vendor gets the address and tenant contact; tenant gets the vendor's name, time and phone number.
9. Wait for "DONE $amount" (nudge after 7 days; to-do after 14).
10. Invoice more than 10% / $25 over the quote → **Owner** approves or disputes.
11. Record the expense, mark paid, tell owner and tenant.

## 3. Daily rent check (`rent-cycle`) — every day 9:00 AM
**KeyHelm never collects rent.** Tenants pay the owner directly (the owner's own method, quoted from their rules). 5 days before the due date: start the month's rent record and text a heads-up. Due date: reminder. After the grace period: start **Late rent**. Never chases past months when an owner first joins.

## 4. Rent marked received (`payment-received`)
**Starts:** the owner marks rent (or a deposit) received in the app, or answers YES to "Did rent arrive?". Records it in the books, thanks the tenant, stops late notices. Double taps can't double-count. Any rent question still waiting on the owner for that month is closed automatically.

## 5. Late rent (`late-rent`)
1. **Owner** confirms whether rent arrived (KeyHelm can't see the owner's bank); asked once more after 2 days with no answer. `YES code $1,500` records part of it. Only if NO (or only part arrived): a polite late notice to the tenant for what's left.
2. Rent 7+ days late → **Owner** decides whether to apply the lease's late fee, capped at the greater of $50 or 5% (SB21-173). KeyHelm only tells the tenant; they pay the owner.
3. Day 12 unpaid → **Owner** picks: send the 10-day demand (we prepare it; the owner has it delivered properly), offer a payment plan (the tenant's reply goes straight to the owner), or keep waiting (asked again a week later, up to 3 times). KeyHelm never files anything.

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
5. Owner reminded to sign after 2 days.
6. New tenancy: tenant told the deposit and first month are due to the owner (owner gets a to-do to mark them received), other applicants told the home is leased (their pending decisions close), prospects who only asked are offered texts about future homes, listing taken down. 2 days before: move-in details to the tenant, and a reminder to the owner (keys or code, and anything not yet marked received). Tenant active on day one.
7. Renewals: Colorado's one-increase-per-12-months rule is checked against the new lease's start date.

## 8. Showing (`showing`)
Self-showing: ID check link → 3 time choices that match what they asked ("this weekend", "Saturday morning", "after 5") and skip times already booked → they can ask for another day (up to 3 rounds) → one-time door code 15 min before (works for 1 hour) → code revoked → feedback and apply link. Owner-led showing (owner mode, no smart lock, or **a tenant still lives there**, so never a door code into someone's home): the prospect is told the owner will set a time; **Owner** confirms by texting `YES code Sat 10am`.

## 9. Listing a vacancy (`listing`)
Listing copy with one all-in rent (HB25-1090) and an Equal Housing line ("Tours by appointment" while the home is occupied) → fair-housing wording check → **Owner** publishes exactly what they approved → posted (manual copy-paste until the Zillow feed is approved) → the home's "available from" date is stored, so the front desk never says "available now" early → past prospects who opted in get a text, and their YES starts a tour.

## 10–11. Renewals (`renewal-sweep` daily 7:00 AM → `renewal`)
At the owner's lead time (default 120 days): **Owner** offers the renewal (same rent, or `YES code $2,850 12 months`), or chooses not to renew and must pick a Colorado for-cause reason (HB24-1098, generally 90 days' notice; owner gets a to-do to deliver the written notice). Offer held until quiet hours end. Any tenant on the lease can answer: YES → owner told, renewal lease (workflow 7); NO → owner told, move-out; a question → sent to the owner and the offer stays open. One reminder after 2 weeks; after 4 weeks the owner gets a to-do and a text.

## 12. Move-out and deposit (`move-out`)
Confirm the date with every tenant on the lease (a date after the lease ends goes to the owner to decide), ask for a forwarding address (saved when they reply with one), start the listing early, walkthrough to-do for the owner, reminders. After move-out: **Owner** chooses full return or texts the deductions (`NO code carpet cleaning $150, blinds $40`); "deductions" with none listed asks for the list instead of sending a full refund by mistake. KeyHelm sends the itemized statement and gives the owner a to-do to send the refund (with the forwarding address) by the deadline. Escalates at day 21; itemized statement and refund before the 30-day deadline (HB25-1249).

## 13. Tenant welcome (`tenant-welcome`)
When the owner adds a tenant: how to text repairs, that rent is still paid to the owner as before, STOP to opt out.

## 14. Monday owner report (`weekly-report`) — Mondays 7:00 AM
Rent marked received, repairs (new, finished, fixed by the tenant with our help), messages handled, decisions waiting (with their codes) and to-dos. Skips canceled accounts.

## 15. New owner setup (`onboarding`)
Six-step checklist, welcome text, nudges at day 2 and day 7 until homes, lease, tenants, vendors, rules and bank are in.

## 16. Decision reminders (`approval-reminders`) — every hour
A decision the owner hasn't answered is re-sent once: after 2 hours for urgent and emergency repairs, after a day for everything else (not during quiet hours unless urgent). The rent check and deposit have their own follow-ups.


## 17. Condition report notices (`condition-notice`)
The owner sends a move-in or move-out report → tenants get a link to fill in their side from My Home. A tenant finishes → **Owner** gets a text and a to-do to review, add their side and finish it. Finished → tenants are told it's final and where their copy is. Each side's entries stay separate, and a finished report can't be changed. An owner can finish without the tenant, and the report says so. Move-out reminds the owner when a move-in report is on file.

---

### Engine housekeeping
Finished runs are pruned once a day (scheduled sweeps after 2 days, everything else after 90; waiting and failed runs are kept). The activity log keeps the history. Anything a workflow reads that can change while it waits (the lease at move-out, the vendor list, the partial-payment math, whether a home is occupied) is recorded in a step so replays follow the same path.

---

### Adding a workflow
Write a `WorkflowDef` in `src/workflows/`, add it to `ALL_WORKFLOWS` in `index.ts`. Inside it, do every side effect through `ctx` (`ctx.step`, `send`, `ctx.approval`, `ctx.waitFor`, `ctx.sleep`) so it runs exactly once even when the workflow pauses and resumes.
