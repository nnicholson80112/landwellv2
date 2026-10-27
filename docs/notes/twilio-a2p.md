# Twilio A2P 10DLC: what to paste into the brand and campaign forms

US carriers only deliver business texts from a normal 10-digit number after two registrations in Twilio:
a **Brand** (who KeyHelm LLC is) and a **Campaign** (what KeyHelm texts, and how people agreed to get them).
Everything below is copy-ready. Replace `<domain>` with the live site address: `keyhelm.<tld>` once the
domain is connected, or `api-production-66895.up.railway.app` until then.

The wording on the site comes from `src/api/legal.ts` (`SMS_SAMPLES`, `OWNER_SMS_OPT_IN`,
`SMS_NO_SHARING`, `smsKeywordReplies()`), so the forms, the website and the app never drift apart. If you
change a text in the workflows, `tests/site.test.ts` fails until the samples here and on `/sms` are updated.

---

## 0. Before you start (do these first, in this order)

1. **Deploy this branch** so `/sms`, the new `/privacy` and `/terms` are live. Check with
   `node scripts/live-check.mjs https://<domain>` (it now checks `/sms` too). Reviewers open these pages.
2. **Business email on your own domain.** In Railway, **api** service, **Variables**, set `BUSINESS_EMAIL`
   (for example `help@<domain>`). Today it falls back to the placeholder `help@keyhelm.example`, which a
   reviewer can't write to. It shows in the site footer, on `/sms` and in the HELP reply.
3. In the same place set `BUSINESS_LEGAL_NAME` = `KeyHelm LLC` (exactly as on the IRS letter),
   `LEGAL_EFFECTIVE_DATE` (YYYY-MM-DD), and optionally `BUSINESS_ADDRESS` and `BUSINESS_PHONE`.
   With no address set, the pages simply leave the address line out.
4. **Connect the domain** (recommended). Railway, **api** service, **Settings**, **Networking**, **Custom Domain**,
   then update `PUBLIC_URL`. A website and email on the same domain as the brand name pass review more easily
   than a `railway.app` address.
5. **Remove unfinished text** from `/terms` and `/refunds`: the bracketed notes about the 12-month agreement
   (early cancellation, renewal), liability limits and disputes. Reviewers can reject a site that looks
   unfinished. (These are business decisions for Nate; this branch did not invent them.)
6. Have the **IRS EIN letter** (CP 575 or 147C) next to you.

---

## 1. Brand registration (Twilio Console, Messaging, Regulatory Compliance / A2P 10DLC)

Twilio first asks for a business profile (Trust Hub), then the A2P brand. Menu names move around in Twilio's
console; search "A2P 10DLC" if a name below differs.

| Field | Enter |
| --- | --- |
| Legal business name | `KeyHelm LLC`, character for character as on the IRS letter |
| Business type | Limited Liability Corporation (LLC) |
| Company type | Private (for-profit). No stock exchange or ticker. |
| Business registration ID type | USA: Employer Identification Number (EIN) |
| Business registration number | The 9-digit EIN from the IRS letter |
| Business industry / vertical | Real Estate |
| Regions of operation | The option that covers the USA |
| Website | `https://<domain>` |
| Business address | The address the IRS has on file for the EIN. Name, EIN and address that don't match IRS records are a common reason a brand fails. |
| Support / business email | The `BUSINESS_EMAIL` value |
| Authorized representative | Nate's name, title (Owner or Managing Member), business email and mobile number |
| Brand type | Standard (the LLC has an EIN). If Twilio offers "Low-volume standard", it is cheaper and fine while you're small; Twilio shows the current daily limits on that screen. |

---

## 2. Campaign

### Use case (recommended): **Low Volume Mixed**, or **Mixed** if Low Volume isn't offered
Sub-use cases to tick: **Customer Care** and **Account Notification**.

Why:
- KeyHelm's texts are a mix of two kinds: replies to people who wrote in (repairs, questions, tours:
  customer care) and notices tied to an existing tenancy or account (rent reminders, lease, renewal and
  move-out notices, owner approvals: account notifications). A single "Customer Care" campaign is narrower than
  what the app sends, and reviewers reject campaigns whose samples don't fit the use case.
- Nothing is marketing, so not "Marketing".
- One phone number and a handful of landlords at launch: low volume. Move to standard Mixed when volume grows.

### Campaign description (paste)
```
KeyHelm LLC makes property management software for small landlords in Colorado. KeyHelm sends texts on behalf of each landlord who uses it: to that landlord's tenants, rental applicants, prospects who contacted the landlord and the vendors the landlord hires, plus account alerts to the landlord. Messages are repair updates and scheduling, rent due reminders and late notices, showing scheduling, lease, renewal, move-in and move-out notices, and replies to messages the person sent. No marketing or promotional messages. Program details: https://<domain>/sms
```

### Message flow / call to action (paste)
```
People opt in four ways, all described at https://<domain>/sms. (1) Tenants: the landlord (our customer) adds the tenant's mobile number in KeyHelm when setting up the tenancy. Our Terms (https://<domain>/terms, section 5) only allow numbers of people who agreed to get texts from the landlord about the rental. The first text is a welcome that names KeyHelm, explains the program and ends with "Reply STOP to opt out of texts." (2) Prospects, applicants and tenants who text first: they text the landlord's KeyHelm number and get replies about what they asked. Applicants also check a required consent box on the rental application form (https://<domain>/apply/<home id>) agreeing to texts and email about their application. (3) Vendors: the landlord adds the vendors they hire, with their agreement, to receive job requests. (4) Landlords: on https://<domain>/ (Get started), the signup form has an optional, unchecked checkbox: "Text me KeyHelm account alerts, like repair approvals and tenant updates. Optional, not required to buy. Message frequency varies. Msg and data rates may apply. Reply HELP for help or STOP to opt out." It is not required to buy; landlords who leave it unchecked get email instead. Privacy policy: https://<domain>/privacy. Terms: https://<domain>/terms.
```
(About 1,330 characters with a short domain.) For the "opt-in proof" upload, if Twilio asks for one: a
screenshot of the signup window (open `https://<domain>/`, click **Get started**) and of the `/sms` page.

### Sample messages (paste, one per box)
These are word for word what the app sends (names and addresses made up). Same five as on `/sms`.

1. `Hi Jordan! Your landlord now uses KeyHelm for 603 Spruce Dr. Text this number anytime for repairs (send a photo) or questions. You'll keep paying rent to your landlord the same way; we'll just send you a reminder before it's due. Reply STOP to opt out of texts.`
2. `Hi Jordan, a heads-up: rent of $1,950 for 603 Spruce Dr is due Sun, Nov 1. Please pay your landlord the way you normally do.`
3. `Your repair is booked with Front Range Plumbing (Tue 9-11). If you need to reach them: 720-555-0133. Text me here if anything changes.`
4. `You're booked for Sat, Oct 17, 12:00 PM at 88 Aspen Ct. Your door code arrives 15 minutes before.`
5. `KeyHelm: Repair $180: 603 Spruce Dr. Front Range Plumbing can do "Kitchen faucet dripping" Tue 9-11 for $180. Your limit is $150. Reply YES K8F (Approve) or NO K8F (Decline).`

### Other campaign questions
| Question | Answer | Why |
| --- | --- | --- |
| Messages include embedded links? | **Yes** | Showing ID checks, lease signing, application and screening links |
| Messages include phone numbers? | **Yes** | Repair updates give the tenant the vendor's number |
| Age-gated content? | No | |
| Direct lending or loan arrangement? | No | KeyHelm never handles money |
| Affiliate marketing? | No | |
| Number pooling? | No | One number |

### Keywords and replies (set in Twilio **Advanced Opt-Out**)
Twilio Console, Messaging, Services, your messaging service, **Opt-Out Management**, turn on Advanced Opt-Out,
then paste these. They are plain GSM text, one SMS each (152, 144 and 115 characters with the placeholder
email; keep `BUSINESS_EMAIL` short so HELP stays under 160).

| Type | Keywords | Reply (paste exactly, with your real email) |
| --- | --- | --- |
| Opt-out | STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT (Twilio's defaults; leave REVOKE and OPTOUT on if listed) | `KeyHelm: You're unsubscribed and won't get more texts from this number. Reply START to resume. Questions about your home? Contact your landlord.` |
| Help | HELP, INFO | `KeyHelm: texts for your landlord about your rental. Help: help@<domain>. Msg frequency varies. Msg & data rates may apply. Reply STOP to opt out.` |
| Opt-in | START, UNSTOP. **Remove YES** if it's in the default list. | `KeyHelm: Texts are back on. Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out.` |

Why remove YES: tenants answer renewals with YES, prospects reply YES for tours and owners approve with YES.
If YES is an opt-in keyword, Twilio may answer those with the opt-in message.

The app also honors these on its own: STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT, OPT OUT, REVOKE turn off
its texts to that number (tenants' notices switch to email and the owner is told); START, UNSTOP, RESUME, OPT IN
turn them back on (`textingKeyword` in `src/workflows/inbound-message.ts`). Twilio sends the confirmation texts above; the app doesn't send its own.

---

## 3. Website checklist for the reviewer (and which live URL covers it)

Live app today: `https://api-production-66895.up.railway.app` (swap in your domain once connected).

| Reviewers check | Where | Status |
| --- | --- | --- |
| A live, public website with the brand name and legal name | `/` (header "KeyHelm", footer "KeyHelm LLC") | Done once deployed |
| Privacy policy says mobile info isn't shared for marketing, and opt-in data and consent aren't shared with third parties | `/privacy`, "Who we share it with" (Text messaging) and "Text messages" | Done once deployed |
| Terms with SMS terms: program, frequency, rates, HELP, STOP, carriers not liable | `/terms`, section 5 "Text messaging" | Done once deployed |
| A page describing the program, opt-in, frequency, rates, HELP/STOP, support and samples | `/sms` (also linked from every footer) | Done once deployed |
| Opt-in on a form: consent words next to an unchecked, optional box | `/` then **Get started** (signup window) | Done |
| Applicant consent | `/apply/<home id>` (any listed home) | Exists (required box, see risks) |
| Contact details | Footer email on every page; "Support" on `/sms` | Set `BUSINESS_EMAIL` first |
| No placeholder or unfinished text | `/terms`, `/refunds` | **To do**: bracketed 12-month, liability and dispute notes |
| Website domain matches the brand | Custom domain | **To do**: connect the domain |

---

## 4. Risks to know before submitting

- **KeyHelm texts on behalf of many landlords.** Twilio has separate rules for software companies (ISVs) whose
  customers send texts. This setup registers KeyHelm LLC as the one brand, with KeyHelm-branded texts about
  landlords' rentals, which fits a single number at launch. If Twilio asks for each landlord to be registered as
  its own brand, that changes the setup (one brand and campaign per landlord). Ask Twilio support before you pay
  for vetting if you're unsure.
- **Tenant consent comes through the landlord.** Carriers dislike consent gathered by someone else. The Terms
  require landlords to have it and the welcome text explains the program and how to stop. If a reviewer pushes
  back, the stronger option is a welcome text that asks the tenant to reply START before anything else is sent
  (a code change in `src/workflows/tenancy.ts`).
- **Applicant consent box is required.** The application form's "texts and email" box must be ticked to apply.
  Some reviewers prefer texting consent to be optional. If flagged, split it into a required email box and an
  optional texting box (in `src/api/server.ts`, `/apply/:propertyId`).
- **HELP gets two answers.** Twilio sends the HELP reply above, and the app's front desk also treats "HELP" as a
  normal message and may answer it. Add `help` / `info` to `textingKeyword` so the front desk stays quiet.
- **Sample 5 has a line break** in the real text. Twilio's sample boxes accept it; the version above is on one
  line to be safe.
