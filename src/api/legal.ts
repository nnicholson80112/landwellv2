// Legal pages: privacy, terms, cookies, refunds, accessibility.
//
// These are DRAFTS written to match how the software actually works today. They are not
// legal advice and must be reviewed by a Colorado attorney before launch. Until
// LEGAL_REVIEWED=true is set in Railway, every page shows a draft notice.
// Business details come from src/config/business.ts (Railway Variables).

import { BRAND } from '../config/brand.ts';
import { BUSINESS } from '../config/business.ts';

/** Bump when the Terms change in a way customers must agree to again. Stored with each signup. */
export const TERMS_VERSION = '2026-10-draft-1';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export const POLICY_LINKS = [
  ['/privacy', 'Privacy policy'],
  ['/terms', 'Terms of service'],
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
main{padding-block:32px 48px}h1,h2{font-family:'Bricolage Grotesque',system-ui,sans-serif;line-height:1.15}h1{font-size:40px;margin:0 0 6px}h2{font-size:24px;margin:36px 0 8px}
.meta{color:var(--muted);font-size:15px;margin:0 0 20px}.draft{background:var(--sun-soft);border:1px solid #E0A800;border-radius:10px;padding:12px 16px}
ul{padding-left:22px}li+li{margin-top:6px}table{width:100%;border-collapse:collapse;font-size:15px}th,td{text-align:left;vertical-align:top;padding:8px 10px;border-top:1px solid var(--line)}
footer{padding-block:28px 40px;border-top:1px solid var(--line);color:var(--muted);font-size:14px}footer nav{display:flex;flex-wrap:wrap;gap:8px 18px;margin-bottom:10px}footer a{color:var(--muted)}
</style></head><body>
<header><a href="/">${esc(BRAND.name)}</a></header>
<main><h1>${esc(title)}</h1><p class="meta">${effective}</p>${draft}${body}</main>
<footer><nav aria-label="Policies">${POLICY_LINKS.map(([h, t]) => `<a href="${h}">${t}</a>`).join('')}</nav>
<p>${esc(b.legalName)} · ${esc(b.address)} · <a href="mailto:${esc(b.email)}">${esc(b.email)}</a></p></footer>
</body></html>`;
}

const contact = () => `<a href="mailto:${esc(BUSINESS.email)}">${esc(BUSINESS.email)}</a>`;
const who = () => `${esc(BUSINESS.legalName)} ("${esc(BRAND.name)}", "we", "us")`;

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
<tr><td>Owners</td><td>Name, email, mobile phone, number of homes, plan choice, the rules and policies you enter, property details, vendor contacts, lease templates, and records you create (such as marking rent received).</td></tr>
<tr><td>Owners (billing)</td><td>Payments are handled by Stripe. We receive your Stripe customer ID, subscription status and plan. We do not receive or store full card numbers.</td></tr>
<tr><td>Tenants, prospects, vendors</td><td>Name, phone number, email address, the content of texts, emails and call transcripts sent to the owner's line, photos you send, and records about repairs, showings, leases, rent reminders and deposits.</td></tr>
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
<p><b>Text messaging.</b> No mobile information will be shared with third parties or affiliates for marketing or promotional purposes. Text messaging opt-in data and consent are not shared with any third parties.</p>

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
<p>${esc(BUSINESS.legalName)}, ${esc(BUSINESS.address)}. Email ${contact()}.</p>`);
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

<h2>5. Text messages</h2>
<p>If you opt in to texts, we will send account messages such as repair approvals, tenant updates and reminders. Message frequency varies. Message and data rates may apply. Reply <b>STOP</b> to cancel and <b>HELP</b> for help. Carriers are not liable for delayed or undelivered messages. Consent to receive texts is not a condition of purchase.</p>

<h2>6. Plans, billing and automatic renewal</h2>
<ul>
<li>Prices are per rental home ("door") per month, shown on our website at the time you sign up. Your first month is charged when you sign up.</li>
<li><b>Month-to-month plans renew automatically every month</b> and are charged to your payment method on file until you cancel.</li>
<li><b>12-month agreements</b> are billed monthly at a lower per-door price for 12 months. [Early cancellation, renewal at the end of the term, and notice terms to be set with our attorney before 12-month agreements are sold.]</li>
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
<p>[Limitation of liability, disclaimer of warranties and indemnification wording to be written by our attorney. Colorado law limits how these can apply to consumers.]</p>

<h2>12. Ending these terms</h2>
<p>You can stop using the service at any time by cancelling as described in the Refund and cancellation policy. We may suspend or end your account if you seriously or repeatedly break these terms, or if required by law. We will give notice when we reasonably can.</p>

<h2>13. Changes to these terms</h2>
<p>We may update these terms. If a change is significant, we will email owners at least 30 days before it takes effect. Continuing to use the service after that means you accept the new terms.</p>

<h2>14. Law and disputes</h2>
<p>These terms are governed by Colorado law. [Dispute resolution, venue and any arbitration terms to be set by our attorney.]</p>

<h2>15. Contact</h2>
<p>${esc(BUSINESS.legalName)}, ${esc(BUSINESS.address)}. Email ${contact()}.</p>`);
}

export function cookiePolicy(): string {
  return legalPage('Cookie policy', `
<p>This policy explains how the ${esc(BRAND.name)} website and service use cookies and similar browser storage.</p>

<h2>Our website</h2>
<p>Our public website <b>does not set any cookies</b>. It does not use analytics, advertising pixels, social media widgets, embedded videos or other third-party trackers. Our fonts are hosted on our own servers, so loading the site does not contact Google or any other font service.</p>

<h2>Signed-in tools</h2>
<p>When an owner or our staff signs in to an owner or admin console, the browser stores a sign-in token in local or session storage so you stay signed in. This is strictly necessary for the feature you asked for and is not used for tracking.</p>

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
<p>Email ${contact()} from the email address on your account and say you want to cancel. We will confirm by email. [Before launch: add a self-serve cancel button in the owner account.]</p>

<h2>Month-to-month plans</h2>
<ul>
<li>You can cancel at any time. Your cancellation takes effect at the end of the month you have already paid for, and you will not be charged again.</li>
<li>We do not give partial refunds for the unused part of a month.</li>
</ul>

<h2>12-month agreements</h2>
<p>[Early cancellation terms to be decided with our attorney before 12-month agreements are sold.]</p>

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
