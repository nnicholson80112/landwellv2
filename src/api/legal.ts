// Legal pages: privacy, terms, text messages (/sms), cookies, refunds, accessibility.
//
// Written to match how the software actually works today. KeyHelm LLC's owner reviewed them
// against Colorado law, so they show no "draft" notice (set LEGAL_REVIEWED=false to bring it
// back). Business details come from src/config/business.ts (Railway Variables). The address is
// optional everywhere: when BUSINESS_ADDRESS is empty, no address line or stray comma appears.
// The /sms page and the texting clauses below are what Twilio's A2P 10DLC reviewers read; see
// docs/notes/twilio-a2p.md before changing them.

import { BRAND } from '../config/brand.ts';
import { BUSINESS } from '../config/business.ts';

/** Bump when the Terms change in a way customers must agree to again. Stored with each signup. */
export const TERMS_VERSION = '2026-10-20';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export const POLICY_LINKS = [
  ['/privacy', 'Privacy policy'],
  ['/terms', 'Terms of service'],
  ['/sms', 'Text messages'],
  ['/cookies', 'Cookie policy'],
  ['/refunds', 'Refund and cancellation policy'],
  ['/accessibility', 'Accessibility'],
] as const;

/** Shared look for legal pages: the site's fonts and colors, readable line length, no scripts. */
export function legalPage(title: string, body: string): string {
  const b = BUSINESS;
  const effective = b.legalEffective ? `Effective ${esc(b.legalEffective)}` : 'Effective date: [to be set at launch]';
  const draft = b.legalReviewed ? '' : '<p class="draft" role="note"><b>Draft.</b> This page has not yet been reviewed by an attorney and may change before launch.</p>';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} | ${esc(BRAND.name)}</title><link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
@font-face{font-family:'Bricolage Grotesque';font-weight:200 800;font-display:swap;src:url(/fonts/bricolage-grotesque-latin.woff2) format('woff2')}
@font-face{font-family:'Figtree';font-weight:300 900;font-display:swap;src:url(/fonts/figtree-latin.woff2) format('woff2')}
:root{--bg:#F6F9FF;--surface:#FFFFFF;--ink:#0E1B33;--muted:#4A5A78;--line:#D8E1F2;--brand:#1B4DFF;--sun-soft:#FFF3CF}
@media (prefers-color-scheme:dark){:root{--bg:#0B1324;--surface:#121D33;--ink:#EEF3FF;--muted:#A9B7D3;--line:#24365C;--brand:#8FA9FF;--sun-soft:#3A3115;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:17px/1.65 'Figtree',system-ui,sans-serif}
a{color:var(--brand)}:focus-visible{outline:3px solid #FFC83D;outline-offset:2px}
header,main,footer{max-width:760px;margin:0 auto;padding-inline:20px}
header{padding-block:20px;border-bottom:1px solid var(--line)}header a{font:800 22px 'Bricolage Grotesque',system-ui,sans-serif;color:var(--ink);text-decoration:none}
main{padding-block:32px 48px}h1,h2,h3{font-family:'Bricolage Grotesque',system-ui,sans-serif;line-height:1.15}h1{font-size:40px;margin:0 0 6px}h2{font-size:24px;margin:36px 0 8px}h3{font-size:19px;margin:22px 0 4px}
.sms{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:14px 16px;margin:12px 0}.sms figcaption{font-size:14px;font-weight:700;color:var(--muted);margin-bottom:6px}.sms p{margin:0;white-space:pre-line}
blockquote{margin:10px 0;padding:10px 16px;border-left:4px solid #FFC83D;background:var(--surface);border-radius:0 10px 10px 0}
.meta{color:var(--muted);font-size:15px;margin:0 0 20px}.draft{background:var(--sun-soft);border:1px solid #E0A800;border-radius:10px;padding:12px 16px}
ul{padding-left:22px}li+li{margin-top:6px}table{width:100%;border-collapse:collapse;font-size:15px}th,td{text-align:left;vertical-align:top;padding:8px 10px;border-top:1px solid var(--line)}
footer{padding-block:28px 40px;border-top:1px solid var(--line);color:var(--muted);font-size:14px}footer nav{display:flex;flex-wrap:wrap;gap:8px 18px;margin-bottom:10px}footer a{color:var(--muted)}
</style></head><body>
<header><a href="/">${esc(BRAND.name)}</a></header>
<main><h1>${esc(title)}</h1><p class="meta">${effective}</p>${draft}${body}</main>
<footer><nav aria-label="Policies">${POLICY_LINKS.map(([h, t]) => `<a href="${h}">${t}</a>`).join('')}</nav>
<p>${esc(b.legalName)}${b.address.trim() ? ` · ${esc(b.address.trim())}` : ''} · <a href="mailto:${esc(b.email)}">${esc(b.email)}</a></p></footer>
</body></html>`;
}

const contact = () => `<a href="mailto:${esc(BUSINESS.email)}">${esc(BUSINESS.email)}</a>`;
const who = () => `${esc(BUSINESS.legalName)} ("${esc(BRAND.name)}", "we", "us")`;
/** "KeyHelm LLC, 123 Main St" or just "KeyHelm LLC" when no address is set (never a stray comma). */
const nameAndAddress = () => `${esc(BUSINESS.legalName)}${BUSINESS.address.trim() ? `, ${esc(BUSINESS.address.trim())}` : ''}`;

/* ---------------- Text messages (A2P 10DLC) ---------------- */
// One source for the texting wording: the /sms page, the Terms, the Privacy policy and
// docs/notes/twilio-a2p.md all use these. tests/site.test.ts checks the samples against the
// texts the workflows really send, so change both together.

/** The exact words next to the optional, unchecked texting box on the signup form (apps/site/site.body.html). */
export const OWNER_SMS_OPT_IN = `Text me ${BRAND.name} account alerts, like repair approvals and tenant updates. Optional, not required to buy. Message frequency varies. Msg and data rates may apply. Reply HELP for help or STOP to opt out.`;

/** The CTIA / A2P no-sharing statement. Appears word for word on /privacy, /terms and /sms. */
export const SMS_NO_SHARING = 'No mobile information will be shared with third parties or affiliates for marketing or promotional purposes.';
export const SMS_CONSENT_NOT_SHARED = 'Text messaging originator opt-in data and consent are excluded from every sharing category in this policy and will not be shared with any third parties.';

/**
 * Sample texts, word for word in the form the workflows send them (names and addresses are made up).
 * Same five go into Twilio's campaign form.
 */
export const SMS_SAMPLES: { label: string; text: string }[] = [
  { label: 'Tenant welcome (the first text after the landlord adds a tenant)', text: `Hi Jordan! Your landlord now uses ${BRAND.name} for 603 Spruce Dr. Text this number anytime for repairs (send a photo) or questions. You'll keep paying rent to your landlord the same way; we'll just send you a reminder before it's due. Reply STOP to opt out of texts.` },
  { label: 'Rent reminder', text: 'Hi Jordan, a heads-up: rent of $1,950 for 603 Spruce Dr is due Sun, Nov 1. Please pay your landlord the way you normally do.' },
  { label: 'Repair update', text: 'Your repair is booked with Front Range Plumbing (Tue 9-11). If you need to reach them: +17205550133. Text me here if anything changes.' },
  { label: 'Showing scheduled (prospect)', text: "You're booked for Sat, Oct 17, 12:00 PM at 88 Aspen Ct. Your door code arrives 15 minutes before." },
  { label: 'Owner account alert (owners who opted in)', text: `${BRAND.name}: Repair $180: 603 Spruce Dr. Front Range Plumbing can do "Kitchen faucet dripping" Tue 9-11 for $180. Your limit is $150.\nReply YES K8F (Approve) or NO K8F (Decline).` },
];

/** Auto-replies to set in Twilio Advanced Opt-Out (Messaging Service). Plain GSM characters, under 160 each. */
export function smsKeywordReplies(): { help: string; stop: string; start: string } {
  return {
    help: `${BRAND.name}: texts for your landlord about your rental. Help: ${BUSINESS.email}. Msg frequency varies. Msg & data rates may apply. Reply STOP to opt out.`,
    stop: `${BRAND.name}: You're unsubscribed and won't get more texts from this number. Reply START to resume. Questions about your home? Contact your landlord.`,
    start: `${BRAND.name}: Texts are back on. Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out.`,
  };
}

/** GET /sms: the text message program page A2P 10DLC reviewers (and anyone else) can read. */
export function smsProgram(): string {
  const b = BUSINESS;
  const n = esc(BRAND.name);
  const replies = smsKeywordReplies();
  const phone = b.phone.trim() ? ` or call ${esc(b.phone.trim())}` : '';
  return legalPage(`${BRAND.name} text messages`, `
<p>${n} text messages are sent by ${esc(b.legalName)} on behalf of landlords who use ${n} to run their rental homes. This page explains who sends them, what they are about, how people sign up, how often they come and how to stop them.</p>

<h2>Who sends these texts</h2>
<p>${esc(b.legalName)} ("${n}") sends every text, on behalf of the landlord of the home you rent, applied for or asked about. Texts come from the landlord's ${n} phone number. The landlord is our customer. ${n} is software, not a property manager, and never collects rent.</p>

<h2>What we text about</h2>
<ul>
<li><b>Repair updates</b>: questions about the problem, the booked time, how to reach the vendor, and when the job is done.</li>
<li><b>Rent reminders</b> before rent is due, and late notices after the landlord confirms rent hasn't arrived.</li>
<li><b>Showing scheduling</b>: tour times, confirmations and door codes for self-guided tours.</li>
<li><b>Lease, renewal, move-in and move-out notices</b>, including deposit statements.</li>
<li><b>Replies to messages you send</b> to the landlord's ${n} number.</li>
<li><b>Home availability</b>: only if you reply YES when we offer to text you when a home opens up.</li>
<li><b>For landlords who opt in</b>: account alerts such as repair approvals and tenant updates.</li>
<li><b>For vendors the landlord hires</b>: job requests and scheduling.</li>
</ul>
<p>We never send marketing or promotional texts.</p>

<h2>How people sign up</h2>
<h3>Tenants</h3>
<p>The landlord adds you to ${n} with the mobile number you gave them for your tenancy. Our <a href="/terms">Terms</a> only allow landlords to add people who agreed to get texts from them about the rental. Your first text is a welcome message that names ${n}, says what we text about and tells you how to stop (see the first sample below).</p>
<h3>Anyone who texts first: prospects, applicants and tenants</h3>
<p>When you text a landlord's ${n} number, for example about a home for rent or a repair, we reply to your message and follow up on what you asked, like tour times. Applicants also check a box on the rental application agreeing to texts and email about their application. We only text you about other homes if you reply YES when we offer.</p>
<h3>Vendors</h3>
<p>The landlord adds the vendors and staff they hire, with their agreement, to receive job requests by text.</p>
<h3>Landlords (${n} customers)</h3>
<p>When you sign up on our <a href="/">website</a>, the form has an optional checkbox that starts <b>unchecked</b>. It says:</p>
<blockquote>${esc(OWNER_SMS_OPT_IN)}</blockquote>
<p>You don't have to check it to buy ${n}. If you leave it unchecked, we email your alerts instead.</p>

<h2>How often</h2>
<p>Message frequency varies. It depends on what is happening with your home, like an open repair, a tour or an upcoming rent date. Notices that can wait, such as rent reminders, are held during the landlord's quiet hours (9 PM to 8 AM unless the landlord changes them).</p>

<h2>Cost</h2>
<p>Message and data rates may apply. ${n} does not charge tenants, applicants, prospects or vendors anything for texts.</p>

<h2>Help and stopping texts</h2>
<ul>
<li>Reply <b>STOP</b> to stop texts from that number. STOPALL, UNSUBSCRIBE, CANCEL, END and QUIT work too. You'll get one text confirming it, and then no more texts. Tenants who stop texts may still get important notices about their home by email.</li>
<li>Reply <b>START</b> to turn texts back on.</li>
<li>Reply <b>HELP</b> for help. We'll reply: "${esc(replies.help)}"</li>
<li>Questions about your home, rent or lease are best answered by your landlord.</li>
</ul>

<h2>Support</h2>
<p>Email ${contact()}${phone}. ${nameAndAddress()}.</p>

<h2>Your privacy</h2>
<p><b>${esc(SMS_NO_SHARING)}</b> Text messaging opt-in data and consent are not shared with any third parties. We only use your number to send the texts described on this page. Read our <a href="/privacy">Privacy policy</a> and the "Text messaging" section of our <a href="/terms">Terms of service</a>.</p>
<p>Mobile carriers are not liable for delayed or undelivered messages.</p>

<h2>Sample messages</h2>
<p>Names, addresses and times are examples.</p>
${SMS_SAMPLES.map((s) => `<figure class="sms"><figcaption>${esc(s.label)}</figcaption><p>${esc(s.text)}</p></figure>`).join('\n')}`);
}

export function privacyPolicy(): string {
  return legalPage('Privacy policy', `
<p>This policy explains what personal information ${who()} collects, why, who we share it with, and the choices you have. ${esc(BRAND.name)} is software that helps rental owners in Colorado run their homes. It covers our website, the ${esc(BRAND.name)} service, and the texts, emails and calls it sends and receives.</p>

<h2>Who this covers</h2>
<ul>
<li><b>Owners</b>: the landlords who subscribe to ${esc(BRAND.name)}.</li>
<li><b>Tenants, applicants, prospects and vendors</b> who message an owner's ${esc(BRAND.name)} line, apply for a home, or are added by an owner. For this information we work on the owner's behalf: the owner decides how it is used, and we use it only to provide the service to them.</li>
<li><b>Website visitors.</b></li>
</ul>

<h2>Information we collect</h2>
<table>
<tr><th scope="col">From</th><th scope="col">What</th></tr>
<tr><td>Owners</td><td>Name, email, mobile phone, number of homes, plan choice, the rules and policies you enter, property details, vendor contacts, lease templates, and records you create (such as marking rent received). When you sign up we record that you accepted our terms and whether you chose to get texts, and when.</td></tr>
<tr><td>Owners (billing)</td><td>Payments are handled by Stripe. We receive your Stripe customer ID, subscription status and plan. We do not receive or store full card numbers.</td></tr>
<tr><td>Tenants, prospects, vendors</td><td>Name, phone number, email address, the content of texts, emails and call transcripts sent to the owner's line, photos you send, and records about repairs, showings, leases, rent reminders and deposits.</td></tr>
<tr><td>Anyone who gets texts</td><td>Mobile number, whether and when you agreed to texts, and any STOP, START or HELP replies, so we can honor them.</td></tr>
<tr><td>Applicants</td><td>Name, email and phone from the application form. If the owner uses identity verification or tenant screening, the results from those partners are shared with the owner. ${esc(BRAND.name)} does not score, rank or recommend applicants.</td></tr>
<tr><td>Everyone</td><td>Technical information our servers receive with each request, such as IP address, browser type and the page requested. We use it to keep the service running and secure, including limiting abusive traffic.</td></tr>
</table>

<h2>How we use it</h2>
<ul>
<li>To provide the service: answer and route messages for the owner, book repairs with the owner's vendors, send reminders and notices the owner has set up, prepare leases and deposit statements, and show the owner what needs a decision.</li>
<li>To bill owners for their ${esc(BRAND.name)} subscription.</li>
<li>To keep the service secure, prevent fraud and abuse, and fix problems.</li>
<li>To meet legal obligations and enforce our terms.</li>
</ul>
<p><b>Automated replies.</b> ${esc(BRAND.name)} uses an AI model to draft replies to messages. Replies are limited to the facts the owner has provided and to fixed rules. Topics such as fair housing, accommodation requests, complaints, legal matters and application decisions are passed to the owner instead of being answered automatically. We keep a log of these AI exchanges for up to 90 days to check quality and safety. We do not use your messages to train AI models; if that ever changes, we will update this policy first and ask for consent where the law requires it.</p>

<h2>Who we share it with</h2>
<p>We do not sell personal information, and we do not share it for targeted advertising. We share it only as needed to run the service:</p>
<ul>
<li><b>The owner</b> of the home you are messaging about, renting or applying for.</li>
<li><b>Vendors</b> the owner chooses, when a repair needs them (for example, the address, the problem and a contact number).</li>
<li><b>Service providers</b> who process it for us: Railway (hosting), Stripe (subscription payments), Anthropic (AI model that drafts replies), and, when enabled, Twilio (texts and calls), Postmark (email), Calendly (scheduling setup calls), smart-lock providers for self-guided showings, and the screening and identity verification partners an owner chooses.</li>
<li><b>Legal reasons</b>: when required by law, to protect rights and safety, or as part of a sale or reorganization of our business (in which case this policy continues to apply).</li>
</ul>
<p><b>Text messaging.</b> ${esc(SMS_NO_SHARING)} ${esc(SMS_CONSENT_NOT_SHARED)} Phone numbers are used only to send and receive the texts described on our <a href="/sms">text messages page</a>.</p>

<h2>Text messages</h2>
<p>${esc(BRAND.name)} texts tenants, applicants, prospects, vendors and owners only about the rental homes and accounts described on our <a href="/sms">text messages page</a>, never for marketing. Owners choose whether to get texts when they sign up; it is optional and not a condition of purchase. Message frequency varies. Message and data rates may apply. Reply <b>STOP</b> to stop texts or <b>HELP</b> for help. We keep a record of consent and opt-outs so we can honor them.</p>

<h2>Cookies and tracking</h2>
<p>Our website does not use advertising or analytics cookies and does not load third-party trackers. See our <a href="/cookies">Cookie policy</a>.</p>

<h2>How long we keep it</h2>
<ul>
<li>AI exchange logs: up to 90 days.</li>
<li>Owner account information and the records in it: while the account is open. After an account closes, we delete or de-identify it within 90 days, unless we must keep certain records longer for legal, tax or dispute reasons.</li>
<li>Billing records: as long as tax and accounting law requires.</li>
</ul>

<h2>Your choices and rights</h2>
<ul>
<li>You can ask to see, correct, or delete your personal information, or for a copy of it, by emailing ${contact()}. We will respond within 45 days. If your information is held for an owner (for example, as their tenant), we may pass your request to that owner.</li>
<li>Reply <b>STOP</b> to any text to stop receiving texts, or <b>HELP</b> for help.</li>
<li>Colorado residents may have additional rights under the Colorado Privacy Act. We do not sell personal data or use it for targeted advertising or profiling. If you are not satisfied with our answer to a request, you can appeal by replying to our response.</li>
</ul>

<h2>Security</h2>
<p>We use encrypted connections (HTTPS) for our website and service and limit access to personal information to what is needed to run the service. No system is perfectly secure; if a breach affects your personal information, we will notify you as the law requires.</p>

<h2>Children</h2>
<p>${esc(BRAND.name)} is not meant for anyone under 18, and we do not knowingly collect information from children.</p>

<h2>Changes</h2>
<p>If we change this policy, we will update the effective date above. If the change is significant, we will tell owners by email before it takes effect.</p>

<h2>Contact</h2>
<p>${nameAndAddress()}. Email ${contact()}.</p>`);
}

export function termsOfService(): string {
  return legalPage('Terms of service', `
<p>These terms are an agreement between you and ${who()} for using the ${esc(BRAND.name)} website and service. By creating an account or using the service, you agree to them.</p>

<h2>1. What ${esc(BRAND.name)} is, and is not</h2>
<p>${esc(BRAND.name)} is software that helps rental owners communicate with tenants, prospects and vendors and keep track of their rentals. It is <b>not</b> a property management company, real estate broker, law firm, emergency service or payment processor for rent. You remain the landlord and are responsible for your properties, your decisions and your legal obligations. Nothing in the service is legal, tax or financial advice.</p>

<h2>2. Your account</h2>
<ul>
<li>You must be at least 18 and able to enter a contract. You must give accurate information and keep your login details secure.</li>
<li>You are responsible for what happens under your account and for the information you enter, including your rules, policies, rent amounts, vendor list and lease template.</li>
</ul>

<h2>3. Your responsibilities as an owner</h2>
<ul>
<li><b>Fair housing.</b> You must follow federal, Colorado and local fair housing laws. ${esc(BRAND.name)} does not score, rank or recommend applicants. You make every application decision.</li>
<li><b>Landlord law.</b> You are responsible for following Colorado landlord-tenant law, including repair timelines, notice requirements, late fee limits, deposit return deadlines and rent payment rules. The service includes reminders based on Colorado rules, but they may not cover every situation and are not legal advice.</li>
<li><b>Rent and money.</b> Tenants pay you directly. ${esc(BRAND.name)} never collects, holds or moves rent, security deposits or vendor payments. You pay your vendors directly.</li>
<li><b>Consent to contact.</b> You confirm you have the right to give us the contact details of your tenants and vendors and that we may contact them on your behalf about your rentals.</li>
<li><b>Your lease.</b> You supply your own lease. We fill in the details you provide; we do not review it for legal compliance.</li>
</ul>

<h2>4. Automated messages and AI</h2>
<p>The service uses automated systems, including an AI model, to reply to messages and route requests. Automated replies can be wrong or incomplete. You can review conversations at any time. Emergencies are flagged and routed, but ${esc(BRAND.name)} is not an emergency service: anyone in danger should call 911.</p>

<h2>5. Text messaging</h2>
<ul>
<li><b>The program.</b> ${esc(BRAND.name)} text messages are sent by ${esc(BUSINESS.legalName)} on behalf of landlords who use ${esc(BRAND.name)}: repair updates, rent reminders and late notices, showing scheduling, lease, renewal, move-in and move-out notices, replies to messages people send, job requests to the landlord's vendors, and account alerts for owners who opt in. Details and sample messages are on our <a href="/sms">text messages page</a>. We never send marketing texts.</li>
<li><b>Owners' consent.</b> Texts about your account are optional. You can opt in when you sign up, and consent is not a condition of purchase. If you don't opt in, we send your alerts by email.</li>
<li><b>Tenants, applicants, prospects and vendors.</b> As an owner, you may add a person's mobile number only if they have agreed to get texts from you about your rental, and only for messages about the rental. People who text your ${esc(BRAND.name)} number first get replies to what they asked. Each tenant's first text explains the program and how to stop.</li>
<li><b>How often.</b> Message frequency varies.</li>
<li><b>Cost.</b> Message and data rates may apply.</li>
<li><b>Help and stopping.</b> Reply <b>HELP</b> for help or <b>STOP</b> to cancel at any time. Reply <b>START</b> to turn texts back on. You can also email ${contact()}.</li>
<li><b>Carriers.</b> Mobile carriers are not liable for delayed or undelivered messages.</li>
<li><b>Privacy.</b> ${esc(SMS_NO_SHARING)} Text messaging opt-in data and consent are not shared with any third parties. See our <a href="/privacy">Privacy policy</a>.</li>
</ul>

<h2>6. Plans, billing and automatic renewal</h2>
<ul>
<li>Prices are per rental home ("door") per month, shown on our website at the time you sign up. Your first month is charged when you sign up.</li>
<li><b>Month-to-month plans renew automatically every month</b> and are charged to your payment method on file until you cancel.</li>
<li><b>12-month agreements</b> are billed monthly at a lower per-door price for 12 months. We email you at least 30 days before the 12 months end. Unless you cancel or choose a new term, the agreement then continues <b>month to month at the same agreement price</b>, and you can cancel at any time after that. If you cancel before the 12 months are up, see "Ending a 12-month agreement early" in our <a href="/refunds">Refund and cancellation policy</a>.</li>
<li>If you add or remove homes, your next charges will reflect the new number of doors.</li>
<li>Private offers are personal, time-limited and apply only as described in the offer.</li>
<li>We may change prices with at least 30 days' notice by email. Changes apply from your next billing period after the notice period. If you do not agree, you can cancel before the change takes effect.</li>
<li>Prices do not include any taxes that may apply.</li>
</ul>

<h2>7. Cancellation and refunds</h2>
<p>See our <a href="/refunds">Refund and cancellation policy</a>, which is part of these terms.</p>

<h2>8. Acceptable use</h2>
<p>You may not use the service to break the law, discriminate, harass anyone, send spam or marketing texts without consent, upload malware, try to access other accounts, overload the service, or copy or resell it. We may limit how often the service can be used to protect it for everyone, and we may suspend accounts that break these rules.</p>

<h2>9. Your data</h2>
<p>You own the information you put into the service. You give us permission to use it to provide and support the service as described in our <a href="/privacy">Privacy policy</a>. You can export or ask us to delete it by emailing ${contact()}.</p>

<h2>10. Our service</h2>
<p>We work to keep the service available and accurate, but we provide it "as is" and "as available". We do not promise it will be uninterrupted or error-free, or that it will meet every legal requirement for your situation.</p>

<h2>11. Limits on our liability</h2>
<p>${esc(BRAND.name)} is software that helps you manage your rentals. It is not a law firm, a licensed property manager or a real estate broker, and it does not give legal advice. You remain the landlord: you make the decisions you approve in the service (such as applicants, repairs over your limit, fees, notices and lease terms) and you are responsible for following the laws that apply to you.</p>
<p>To the fullest extent the law allows: (a) we are not liable for indirect, incidental, special or consequential losses, such as lost rent, lost profits or vacancy costs; and (b) our total liability for any claim related to the service is limited to the amount you paid us in the 12 months before the claim arose. These limits do not apply where the law does not allow them, such as for fraud, gross negligence or willful misconduct.</p>
<p>You agree to cover claims, losses and reasonable costs that result from your breaking the law (including fair housing law) or these terms while using the service.</p>

<h2>12. Ending these terms</h2>
<p>You can stop using the service at any time by cancelling as described in the Refund and cancellation policy. We may suspend or end your account if you seriously or repeatedly break these terms, or if required by law. We will give notice when we reasonably can.</p>

<h2>13. Changes to these terms</h2>
<p>We may update these terms. If a change is significant, we will email owners at least 30 days before it takes effect. Continuing to use the service after that means you accept the new terms.</p>

<h2>14. Law and disputes</h2>
<p>These terms are governed by Colorado law. If you have a concern, email ${contact()} first and we will try to resolve it within 30 days. If we can't, either of us may bring the claim in the state courts located in Arapahoe County, Colorado, or in small claims court where the claim qualifies.</p>

<h2>15. Contact</h2>
<p>${nameAndAddress()}. Email ${contact()}.</p>`);
}

export function cookiePolicy(): string {
  return legalPage('Cookie policy', `
<p>This policy explains how the ${esc(BRAND.name)} website and service use cookies and similar browser storage.</p>

<h2>Our website</h2>
<p>Our public website <b>does not set any cookies</b>. It does not use analytics, advertising pixels, social media widgets, embedded videos or other third-party trackers. Our fonts are hosted on our own servers, so loading the site does not contact Google or any other font service.</p>

<h2>Signed-in tools</h2>
<p>When an owner signs in, we set one cookie, <code>kh_session</code>, that keeps them signed in for up to 30 days. Our staff's admin and test consoles keep a sign-in token in the browser's local or session storage. These are strictly necessary for the feature you asked for and are not used for tracking.</p>

<h2>Pages run by our partners</h2>
<p>When you check out, you go to a secure page run by Stripe. When you book a setup call, you go to Calendly. Those pages are on the partners' own websites and may use their own cookies, for example for fraud prevention, under their own policies.</p>

<h2>Do we need a cookie banner?</h2>
<p>Because we only use storage that is strictly necessary and no tracking, we do not show a cookie consent banner. If we ever add analytics or advertising tools, we will update this policy first and ask for consent where the law requires it. We treat Global Privacy Control signals as a request to opt out of sale and targeted advertising, neither of which we do.</p>

<h2>Contact</h2>
<p>Questions? Email ${contact()}.</p>`);
}

export function refundPolicy(): string {
  return legalPage('Refund and cancellation policy', `
<p>This policy explains how to cancel your ${esc(BRAND.name)} subscription and when we give refunds. It is part of our <a href="/terms">Terms of service</a>.</p>

<h2>How to cancel</h2>
<p>Sign in, open <b>Settings</b>, and choose <b>Manage billing</b> to cancel. You can also email ${contact()} from the email address on your account and say you want to cancel. We will confirm by email.</p>

<h2>Month-to-month plans</h2>
<ul>
<li>You can cancel at any time. Your cancellation takes effect at the end of the month you have already paid for, and you will not be charged again.</li>
<li>We do not give partial refunds for the unused part of a month.</li>
</ul>

<h2>12-month agreements</h2>
<h3>Ending a 12-month agreement early</h3>
<p>You can end a 12-month agreement early at any time. Service continues to the end of the month you have already paid for. We then charge a one-time amount equal to the difference between the month-to-month price and your agreement price, for the months you have already used. That way you never pay more than month-to-month would have cost you for the same months. No other early-cancellation fee applies.</p>
<p>After the first 12 months, the agreement continues month to month at the agreement price, and you can cancel any time with no extra charge.</p>

<h2>When we refund</h2>
<ul>
<li>If we charged you by mistake, such as a duplicate charge or the wrong number of doors, we refund the difference.</li>
<li>If the service was unavailable for a long period because of a problem on our side, contact us and we will work out a fair credit or refund.</li>
<li>Refunds go back to the original payment method. Your bank may take 5 to 10 business days to show it.</li>
</ul>

<h2>What this policy does not cover</h2>
<p>${esc(BRAND.name)} never collects rent, deposits or vendor payments, so we cannot refund them. Questions about those go to your landlord or the vendor.</p>

<h2>Contact</h2>
<p>Email ${contact()}.</p>`);
}

export function accessibilityStatement(): string {
  return legalPage('Accessibility', `
<p>We want everyone to be able to use ${esc(BRAND.name)}, including people who use screen readers, keyboard navigation, zoom or other assistive technology.</p>
<h2>What we do</h2>
<ul>
<li>We aim to meet the Web Content Accessibility Guidelines (WCAG) 2.1 at level AA.</li>
<li>Pages work with a keyboard, show a visible focus outline, use real labels on form fields, and support your device's light or dark setting and reduced-motion setting.</li>
<li>We check text and button colors for readable contrast.</li>
</ul>
<h2>Known limits</h2>
<p>We are a small team and have not yet had an independent accessibility audit. Some parts of the service may not work well with every assistive technology yet.</p>
<h2>Tell us about a problem</h2>
<p>If something is hard to use, email ${contact()} and tell us the page and what happened. We will reply within 5 business days and help you get what you need another way in the meantime.</p>`);
}
