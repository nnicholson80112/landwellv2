// STATE DOCUMENT LIBRARY: 10 documents for every state and DC, filled in with the state's rules
// (state-rules.json, built by scripts/state-library/build_state_rules.py) and the tenant's details.
// Autopilot opens the lease, month-to-month agreement, disclosures addendum and lead-paint form;
// Autopilot Pro opens all 10 (src/billing/entitlements.ts). Rendered on the server as HTML, so a
// locked document never reaches the browser.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Feature } from '../billing/entitlements.ts';

export interface StateRules {
  code: string; name: string;
  deposit: { max: string; returnDeadline: string; holding: string; penalty: string };
  entry: { notice: string; statute: string };
  lateFee: { grace: string; cap: string };
  monthToMonth: { landlord: string; tenant: string; justCause: boolean };
  notices: { nonpayment: string; leaseViolation: string };
  disclosures: string[]; local: string; verify: string;
}

const DATA = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'state-rules.json'), 'utf8')) as { updated: string; status: string; states: StateRules[] };
export const STATE_RULES_UPDATED = DATA.updated;
export const stateRules = (code: string | undefined): StateRules | undefined => DATA.states.find((s) => s.code === String(code ?? '').toUpperCase());
export const allStates = () => DATA.states.map((s) => ({ code: s.code, name: s.name }));

export type DocId = 'lease' | 'm2m' | 'disclosures' | 'lead' | 'condition' | 'deposit' | 'entry' | 'payorquit' | 'violation' | 'endm2m';

export const DOCS: { id: DocId; title: string; group: string; summary: string; feature: Feature }[] = [
  { id: 'lease', title: 'Residential Lease Agreement', group: 'Leases', summary: "Fixed-term lease with your state's deposit, entry, late-fee and notice rules written in.", feature: 'state_leases' },
  { id: 'm2m', title: 'Month-to-Month Rental Agreement', group: 'Leases', summary: "Rolling monthly agreement with your state's notice periods for ending it.", feature: 'state_leases' },
  { id: 'disclosures', title: 'State Disclosures Addendum', group: 'Leases', summary: 'Every disclosure your state requires at signing, as a checklist the tenant signs.', feature: 'state_leases' },
  { id: 'lead', title: 'Lead-Based Paint Disclosure', group: 'Leases', summary: 'Federal disclosure for homes built before 1978, with the required warning statement.', feature: 'state_leases' },
  { id: 'condition', title: 'Move-In / Move-Out Condition Report', group: 'Move-in and move-out', summary: 'Room-by-room condition record, signed at move-in and compared at move-out.', feature: 'forms_pack' },
  { id: 'deposit', title: 'Security Deposit Itemization', group: 'Move-in and move-out', summary: "Itemized deductions and refund, with your state's return deadline.", feature: 'forms_pack' },
  { id: 'entry', title: 'Notice of Entry', group: 'Notices', summary: "Advance notice before entering, using your state's minimum notice period.", feature: 'forms_pack' },
  { id: 'payorquit', title: 'Notice to Pay Rent or Quit', group: 'Notices', summary: "Demand for unpaid rent with your state's notice period.", feature: 'forms_pack' },
  { id: 'violation', title: 'Notice of Lease Violation', group: 'Notices', summary: "Written notice to fix a lease violation, with your state's cure period.", feature: 'forms_pack' },
  { id: 'endm2m', title: 'Notice to End Month-to-Month Tenancy', group: 'Notices', summary: "Ends a monthly tenancy with your state's required notice, and flags just-cause states.", feature: 'forms_pack' },
];

/** Details filled into a document; anything missing prints as a blank line to fill in by hand. */
export type DocFields = Partial<Record<
  'landlord' | 'tenants' | 'address' | 'included' | 'start' | 'end' | 'rent' | 'dueDay' | 'payMethod' | 'lateAfter' | 'lateFee' | 'deposit'
  | 'tenantUtilities' | 'landlordUtilities' | 'occupants' | 'guestDays' | 'pets' | 'smoking' | 'landlordAddress' | 'landlordEmail'
  | 'moveOut' | 'forwarding' | 'inspectDays' | 'entryDate' | 'entryWindow' | 'entryReason' | 'amountDue' | 'rentPeriod' | 'payWhere'
  | 'served' | 'serviceMethod' | 'leaseTerm' | 'violation' | 'endDate', string>>;

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
/** A blank line to fill in by hand. Width classes (kh-w4...kh-w20) instead of inline styles: the app's CSP blocks style attributes. */
const blank = (w: number) => `<span class="kh-blank kh-w${Math.min(20, Math.max(4, Math.round(w / 2) * 2))}"></span>`;
const val = (f: DocFields, k: keyof DocFields, w = 8) => (f[k] ? `<span class="kh-fill">${esc(f[k])}</span>` : blank(w));
const list = (items: string[]) => `<ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul>`;
const section = (n: number | string, title: string, body: string) => `<section class="kh-clause"><h3><span class="kh-num">${n}.</span> ${title}</h3>${body}</section>`;
const rule = (html: string) => `<p class="kh-rule">${html}</p>`;
const box = '<span class="kh-box"></span>';

function header(title: string, s: StateRules) {
  return `<header class="kh-doc-head"><p class="kh-doc-state">${esc(s.name)}</p><h2>${title}</h2><p class="kh-draft">Written with ${esc(s.name)}'s landlord-tenant rules as of ${esc(STATE_RULES_UPDATED)}. Check your city and county rules too.</p></header>`;
}
function localNote(s: StateRules) {
  const notes: string[] = [];
  if (s.local) notes.push(`<strong>Local rules:</strong> ${esc(s.local)} Check your city and county before using this document.`);
  if (s.verify) notes.push(`<strong>Recently changed:</strong> ${esc(s.verify)}`);
  return notes.length ? `<aside class="kh-note">${notes.join('<br>')}</aside>` : '';
}
const signatures = (parties: string[]) => `<section class="kh-sign">${parties.map((p) => `<div class="kh-sig"><span class="kh-sig-line"></span><span>${p}</span><span class="kh-sig-line kh-sig-date"></span><span>Date</span></div>`).join('')}</section>`;
const footer = (s: StateRules) => `<footer class="kh-doc-foot">Prepared with KeyHelm for a rental in ${esc(s.name)}. KeyHelm is software, not a law firm, and this isn't legal advice.</footer>`;

const lateFeeText = (s: StateRules, f: DocFields) => `<p>If rent is not received in full by ${val(f, 'lateAfter', 6)} after the due date, Tenant owes a late fee of ${val(f, 'lateFee', 6)}. The late fee will not exceed what ${esc(s.name)} law allows.</p>`
  + rule(`<strong>${esc(s.name)} limit:</strong> ${esc(s.lateFee.cap)}.${s.lateFee.grace === 'None' ? '' : ` ${esc(s.name)} grace period: ${esc(s.lateFee.grace)}.`}`);
const depositText = (s: StateRules, f: DocFields) => `<p>Tenant pays a security deposit of ${val(f, 'deposit', 7)} before move-in. Landlord holds it as security for unpaid rent, damage beyond normal wear and tear, and other amounts Tenant owes under this agreement. The deposit is not a limit on what Tenant may owe.</p>`
  + `<p>After Tenant moves out and gives a forwarding address, Landlord will return the deposit, minus itemized deductions, within the time ${esc(s.name)} law requires.</p>`
  + rule(`<strong>${esc(s.name)} rules:</strong> Maximum deposit: ${esc(s.deposit.max)}. Return deadline: ${esc(s.deposit.returnDeadline)}. Holding: ${esc(s.deposit.holding)}. Penalty for wrongful withholding: ${esc(s.deposit.penalty)}.`);
const entryText = (s: StateRules) => '<p>Landlord may enter the home at reasonable times to inspect, make repairs, show it to prospective tenants or buyers, or as allowed by law. Except in an emergency, Landlord will give Tenant advance notice of entry.</p>'
  + rule(`<strong>${esc(s.name)} notice:</strong> ${esc(s.entry.notice)}${s.entry.statute ? ` (${esc(s.entry.statute)})` : ''}.`);
const defaultText = (s: StateRules) => '<p>If Tenant does not pay rent when due, Landlord may give Tenant a written notice to pay or move out. If Tenant breaks another term of this agreement, Landlord may give a written notice to fix the problem or move out, as the law allows. Landlord will use only court eviction, never lockouts or utility shutoffs.</p>'
  + rule(`<strong>${esc(s.name)} notice periods:</strong> Nonpayment: ${esc(s.notices.nonpayment)}. Lease violation: ${esc(s.notices.leaseViolation)}. Confirm the current form and delivery rules before serving any notice.`);

function parties(s: StateRules, f: DocFields) {
  return section(1, 'Parties', `<p>This agreement is between ${val(f, 'landlord', 14)} ("Landlord") and ${val(f, 'tenants', 16)} ("Tenant"). Each Tenant is responsible for the full rent and all obligations under this agreement.</p>`)
    + section(2, 'Home', `<p>Landlord rents to Tenant the home at ${val(f, 'address', 20)}, ${esc(s.name)}, including ${val(f, 'included', 14)}.</p>`);
}
function common(s: StateRules, f: DocFields, start: number): { html: string; next: number } {
  let n = start, out = '';
  out += section(n++, 'Utilities and services', `<p>Tenant pays for ${val(f, 'tenantUtilities', 14)}. Landlord pays for ${val(f, 'landlordUtilities', 14)}. Utilities Tenant pays must be in Tenant's name where the provider allows it.</p>`);
  out += section(n++, 'Occupants and guests', `<p>Only the Tenants named above and these occupants may live in the home: ${val(f, 'occupants', 14)}. Guests may stay up to ${val(f, 'guestDays', 4)} days in a row without Landlord's written consent.</p>`);
  out += section(n++, 'Use of the home', '<p>Tenant will use the home only as a private residence, keep it clean and safe, follow building and HOA rules, and not disturb neighbors or allow illegal activity.</p>');
  out += section(n++, 'Repairs and maintenance', "<p>Landlord keeps the home fit to live in and makes repairs the law requires. Tenant reports problems promptly by text or email to Landlord's maintenance line. Tenant pays to repair damage caused by Tenant, occupants, guests or pets, beyond normal wear and tear. Emergencies such as flooding, gas leaks, fire or no heat in freezing weather must be reported right away.</p>");
  out += section(n++, 'Landlord entry', entryText(s));
  out += section(n++, 'Pets', `<p>Pets allowed: ${val(f, 'pets', 10)}. Assistance animals are not pets and are allowed as fair housing law requires, with no pet fee or pet deposit.</p>`);
  out += section(n++, 'Smoking', `<p>Smoking and vaping of any substance are ${val(f, 'smoking', 10)} inside the home and on the property.</p>`);
  out += section(n++, 'Alterations', "<p>Tenant will not paint, change locks, install fixtures or make other alterations without Landlord's written consent.</p>");
  out += section(n++, 'Subletting and assignment', "<p>Tenant will not sublet the home or assign this agreement without Landlord's written consent, which Landlord will not unreasonably withhold where the law requires that standard.</p>");
  return { html: out, next: n };
}
function closing(s: StateRules, f: DocFields, n: number) {
  const items = ['Lead-based paint disclosure and EPA pamphlet, if the home was built before 1978', ...s.disclosures.map(esc)];
  return section(n++, 'Required disclosures', `<p>Landlord gives Tenant the following disclosures, attached to and part of this agreement. Tenant confirms receipt by signing.</p>${list(items)}`)
    + section(n++, 'Fair housing', `<p>Landlord follows federal, ${esc(s.name)} and local fair housing laws and does not discriminate on any protected basis.</p>`)
    + section(n++, 'Notices', `<p>Notices to Landlord go to ${val(f, 'landlordAddress', 16)} or ${val(f, 'landlordEmail', 12)}. Notices to Tenant go to the home or to the email Tenant provides, where ${esc(s.name)} law allows electronic notice.</p>`)
    + section(n++, 'Governing law', `<p>${esc(s.name)} law governs this agreement. If any term conflicts with state or local law, that law controls and the rest of the agreement stays in effect.</p>`)
    + section(n++, 'Entire agreement', '<p>This agreement, its addenda and the disclosures listed above are the whole agreement. Changes must be in writing and signed by both sides.</p>');
}
const m2mRule = (s: StateRules) => rule(`<strong>${esc(s.name)} month-to-month notice:</strong> Landlord: ${esc(s.monthToMonth.landlord)}. Tenant: ${esc(s.monthToMonth.tenant)}.`);
const table = (head: string[], rows: string) => `<div class="kh-table-wrap"><table class="kh-table"><thead><tr>${head.map((x) => `<th>${x}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`;

const RENDER: Record<DocId, (s: StateRules, f: DocFields) => string> = {
  lease: (s, f) => {
    let out = header('Residential Lease Agreement', s) + localNote(s) + parties(s, f);
    out += section(3, 'Term', `<p>The lease starts on ${val(f, 'start')} and ends on ${val(f, 'end')}. If Tenant stays after the end date with Landlord's consent, the tenancy continues month to month on the same terms until either side gives the notice ${esc(s.name)} law requires.</p>${m2mRule(s)}`);
    out += section(4, 'Rent', `<p>Rent is ${val(f, 'rent', 7)} per month, due on the ${val(f, 'dueDay', 4)} day of each month. Tenant pays rent directly to Landlord by ${val(f, 'payMethod', 12)}. Rent for a partial first month is prorated by day.</p>`);
    out += section(5, 'Late fees', lateFeeText(s, f)) + section(6, 'Security deposit', depositText(s, f));
    const c = common(s, f, 7);
    return out + c.html + section(c.next, 'Default', defaultText(s)) + closing(s, f, c.next + 1) + signatures(['Landlord', 'Tenant', 'Tenant']) + footer(s);
  },
  m2m: (s, f) => {
    let out = header('Month-to-Month Rental Agreement', s) + localNote(s) + parties(s, f);
    out += section(3, 'Term', `<p>This tenancy starts on ${val(f, 'start')} and continues month to month until either side ends it with proper written notice.</p>`
      + rule(`<strong>${esc(s.name)} notice to end:</strong> Landlord: ${esc(s.monthToMonth.landlord)}. Tenant: ${esc(s.monthToMonth.tenant)}.${s.monthToMonth.justCause ? ` ${esc(s.name)} limits when a landlord may end a tenancy; a legal reason may be required.` : ''}`));
    out += section(4, 'Rent', `<p>Rent is ${val(f, 'rent', 7)} per month, due on the ${val(f, 'dueDay', 4)} day of each month, paid directly to Landlord by ${val(f, 'payMethod', 12)}. Landlord may change the rent with the written notice ${esc(s.name)} law requires.</p>`);
    out += section(5, 'Late fees', lateFeeText(s, f)) + section(6, 'Security deposit', depositText(s, f));
    const c = common(s, f, 7);
    return out + c.html + section(c.next, 'Default', defaultText(s)) + closing(s, f, c.next + 1) + signatures(['Landlord', 'Tenant', 'Tenant']) + footer(s);
  },
  disclosures: (s, f) => {
    const items = s.disclosures.length ? s.disclosures : ['No additional statewide disclosures were found beyond the federal lead-paint rule. Check local rules.'];
    const rows = [...items, 'Lead-based paint disclosure and EPA pamphlet (homes built before 1978)'].map((d) => `<tr><td>${box}</td><td>${esc(d)}</td><td>${blank(10)}</td></tr>`).join('');
    return header('State Disclosures Addendum', s) + localNote(s) + `<p>This addendum is part of the lease for ${val(f, 'address', 20)}. Landlord has given Tenant each item checked below before Tenant signed.</p>`
      + table(['Given', `${esc(s.name)} disclosure`, 'Details or attachment'], rows) + signatures(['Landlord', 'Tenant']) + footer(s);
  },
  lead: (s, f) => header('Lead-Based Paint Disclosure', s)
    + '<section class="kh-clause"><h3>Lead Warning Statement</h3><p>Housing built before 1978 may contain lead-based paint. Lead from paint, paint chips, and dust can pose health hazards if not managed properly. Lead exposure is especially harmful to young children and pregnant women. Before renting pre-1978 housing, lessors must disclose the presence of known lead-based paint and/or lead-based paint hazards in the dwelling. Lessees must also receive a federally approved pamphlet on lead poisoning prevention.</p></section>'
    + section('a', "Lessor's disclosure", `<p>Presence of lead-based paint or hazards (check one):</p>${list([`${box} Known lead-based paint or hazards are present (explain): ${blank(12)}`, `${box} Lessor has no knowledge of lead-based paint or hazards in the housing.`])}<p>Records and reports available to the lessor (check one):</p>${list([`${box} Lessor has given the lessee all available records and reports (list): ${blank(12)}`, `${box} Lessor has no reports or records about lead-based paint or hazards in the housing.`])}`)
    + section('b', "Lessee's acknowledgment", list([`${box} Lessee has received copies of all information listed above.`, `${box} Lessee has received the pamphlet <em>Protect Your Family From Lead in Your Home</em>.`]))
    + section('c', "Agent's acknowledgment", "<p>Any agent has told the lessor of the lessor's obligations under 42 U.S.C. 4852d and knows of the responsibility to ensure compliance.</p>")
    + section('d', 'Certification of accuracy', '<p>The following parties have reviewed the information above and certify, to the best of their knowledge, that it is true and accurate.</p>')
    + `<p>Property: ${val(f, 'address', 20)}</p>` + signatures(['Lessor', 'Lessee', 'Agent (if any)'])
    + `<aside class="kh-note">Federal rule (40 CFR 745.113). Keep a signed copy for 3 years. ${esc(s.name)} may add its own lead rules.</aside>` + footer(s),
  condition: (s, f) => {
    const rooms = ['Entry and hallways', 'Living room', 'Kitchen', 'Appliances', 'Bathroom 1', 'Bathroom 2', 'Bedroom 1', 'Bedroom 2', 'Bedroom 3', 'Laundry', 'Garage and storage', 'Exterior and yard', 'Smoke and CO alarms', 'Keys, fobs and remotes'];
    const required = s.disclosures.some((d) => /move-in|inventory|check-in|condition/i.test(d));
    return header('Move-In / Move-Out Condition Report', s)
      + `<p>Home: ${val(f, 'address', 20)}. Move-in date: ${val(f, 'start')}. Move-out date: ${val(f, 'moveOut')}.</p>`
      + `<aside class="kh-note">${required ? `<strong>${esc(s.name)} requires a written move-in condition record</strong> in some form. Give the tenant a copy and keep yours with the lease.` : `Not always required in ${esc(s.name)}, but a signed record is your best evidence for deposit deductions.`}</aside>`
      + table(['Area', 'Condition at move-in', 'Condition at move-out'], rooms.map((r) => `<tr><td>${r}</td><td>${blank(8)}</td><td>${blank(8)}</td></tr>`).join(''))
      + `<p>Tenant has ${val(f, 'inspectDays', 4)} days after move-in to add items to this report. Photos taken at move-in are part of this report.</p>`
      + signatures(['Landlord, move-in', 'Tenant, move-in', 'Landlord, move-out', 'Tenant, move-out']) + footer(s);
  },
  deposit: (s, f) => {
    const money = (k: keyof DocFields) => (f[k] ? esc(f[k]) : `$${blank(4)}`);
    const rows = ['Unpaid rent', 'Cleaning beyond normal wear', 'Repairs (describe)', 'Unreturned keys', 'Other (describe)'].map((r) => `<tr><td>${r}</td><td>${blank(12)}</td><td class="kh-num-cell">$${blank(4)}</td></tr>`).join('');
    const interest = /interest/i.test(s.deposit.holding) ? `<tr><td>Interest owed to tenant</td><td>${esc(s.deposit.holding)}</td><td class="kh-num-cell">$${blank(4)}</td></tr>` : '';
    return header('Security Deposit Itemization', s) + localNote(s)
      + `<p>Tenant: ${val(f, 'tenants', 16)}. Home: ${val(f, 'address', 20)}. Move-out date: ${val(f, 'moveOut')}. Forwarding address: ${val(f, 'forwarding', 16)}.</p>`
      + rule(`<strong>${esc(s.name)} deadline:</strong> ${esc(s.deposit.returnDeadline)}. Penalty for missing it or withholding wrongly: ${esc(s.deposit.penalty)}.`)
      + table(['Deduction', 'Explanation', 'Amount'], `<tr class="kh-total"><td>Deposit received</td><td></td><td class="kh-num-cell">${money('deposit')}</td></tr>${interest}${rows}<tr class="kh-total"><td>Refund to tenant</td><td></td><td class="kh-num-cell">$${blank(4)}</td></tr>`)
      + '<p>Receipts or estimates for repairs are attached. Normal wear and tear is not deducted.</p>' + signatures(['Landlord']) + footer(s);
  },
  entry: (s, f) => header('Notice of Entry', s)
    + `<p>To: ${val(f, 'tenants', 16)}, ${val(f, 'address', 20)}</p>`
    + `<p>Landlord or Landlord's vendor will enter the home on ${val(f, 'entryDate')} between ${val(f, 'entryWindow')} for this reason: ${val(f, 'entryReason', 16)}. You do not need to be home.</p>`
    + rule(`<strong>${esc(s.name)} notice:</strong> ${esc(s.entry.notice)}${s.entry.statute ? ` (${esc(s.entry.statute)})` : ''}. This notice is given at least that far in advance.`)
    + signatures(['Landlord']) + footer(s),
  payorquit: (s, f) => header('Notice to Pay Rent or Quit', s) + localNote(s)
    + `<aside class="kh-note kh-note-strong">Eviction notices have strict form, content and delivery rules, and some states require exact wording. A defective notice can get an eviction case dismissed, so check ${esc(s.name)}'s current statute before serving it.</aside>`
    + `<p>To: ${val(f, 'tenants', 16)} and all other occupants of ${val(f, 'address', 20)}</p>`
    + `<p>You owe rent of ${val(f, 'amountDue', 7)} for the period ${val(f, 'rentPeriod', 10)}. Within <strong>${esc(s.notices.nonpayment)}</strong> after this notice is delivered, pay the full amount to ${val(f, 'landlord', 12)} at ${val(f, 'payWhere', 14)}, or move out. If you do neither, Landlord may file an eviction case.</p>`
    + `<p>Date delivered: ${val(f, 'served')}. How delivered: ${val(f, 'serviceMethod', 12)}.</p>` + signatures(['Landlord']) + footer(s),
  violation: (s, f) => header('Notice of Lease Violation', s) + localNote(s)
    + `<p>To: ${val(f, 'tenants', 16)}, ${val(f, 'address', 20)}</p>`
    + `<p>You are violating this term of your lease: ${val(f, 'leaseTerm', 16)}. What happened: ${val(f, 'violation', 18)}.</p>`
    + `<p>Fix the problem within <strong>${esc(s.notices.leaseViolation)}</strong> after this notice is delivered, or the tenancy may end and Landlord may file an eviction case, as ${esc(s.name)} law allows.</p>`
    + rule(`Some violations cannot be cured under ${esc(s.name)} law, and some states set different periods for repeat violations. Confirm before serving.`)
    + signatures(['Landlord']) + footer(s),
  endm2m: (s, f) => header('Notice to End Month-to-Month Tenancy', s) + localNote(s)
    + (s.monthToMonth.justCause ? `<aside class="kh-note kh-note-strong">${esc(s.name)} limits no-cause terminations. ${esc(s.monthToMonth.landlord)}. Use this notice only with a legal reason.</aside>` : '')
    + `<p>To: ${val(f, 'tenants', 16)}, ${val(f, 'address', 20)}</p>`
    + `<p>Your month-to-month tenancy ends on ${val(f, 'endDate')}. Please move out and return all keys by that date. We will schedule a move-out inspection and handle your deposit as ${esc(s.name)} law requires.</p>`
    + rule(`<strong>${esc(s.name)} notice required:</strong> Landlord: ${esc(s.monthToMonth.landlord)}. Tenant: ${esc(s.monthToMonth.tenant)}.`)
    + signatures(['Landlord']) + footer(s),
};

export const isDocId = (v: unknown): v is DocId => DOCS.some((d) => d.id === v);

/** One document as HTML. The caller checks the owner's plan first (entitlements.ts, DOCS[].feature). */
export function renderDoc(id: DocId, s: StateRules, f: DocFields = {}): string {
  return `<article class="kh-doc">${RENDER[id](s, f)}</article>`;
}

/* ---------------- the printable page ---------------- */

/** Documents are paper: always light, whatever the device theme, and print without the page chrome. */
const DOC_CSS = `@font-face{font-family:'Montagu Slab';font-weight:500 700;font-display:swap;src:url(/fonts/montagu-slab-latin.woff2) format('woff2')}
@font-face{font-family:'Figtree';font-weight:300 900;font-display:swap;src:url(/fonts/figtree-latin.woff2) format('woff2')}
*{box-sizing:border-box}
html{color-scheme:light}
body{margin:0;background:#FFFDF9;color:#1E2B2F;font:15px/1.65 'Figtree','Segoe UI',system-ui,sans-serif}
main{max-width:760px;margin:0 auto;padding:36px 32px 48px}
@media (max-width:640px){main{padding:20px 16px 32px}}
h2,h3{font-family:'Montagu Slab',Georgia,'Times New Roman',serif;margin:0;line-height:1.2}
.kh-doc-head{text-align:center;border-bottom:2px solid #1E2B2F;padding-bottom:14px;margin-bottom:16px}
.kh-doc-state{font-weight:800;font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#A9401F;margin:0 0 6px}
.kh-doc h2{font-size:26px}
.kh-draft{font-size:13px;color:#56636A;margin:8px 0 0}
.kh-clause{margin-top:14px}
.kh-clause h3{font-size:15px;margin-bottom:4px}
.kh-num{color:#A9401F}
p{margin:0}.kh-clause p+p{margin-top:8px}
.kh-doc ul{margin:8px 0;padding-left:20px}
.kh-rule{background:#FCEBCB;border-radius:6px;padding:8px 12px;font-size:14px;margin-top:8px}
.kh-note{background:#FFE7DA;border-radius:6px;padding:10px 14px;font-size:14px;margin:12px 0}
.kh-note-strong{outline:1px solid #C8502D}
.kh-blank{display:inline-block;border-bottom:1.5px solid #56636A;height:1.1em;vertical-align:-3px;min-width:8em}
.kh-w4{min-width:4em}.kh-w6{min-width:6em}.kh-w8{min-width:8em}.kh-w10{min-width:10em}.kh-w12{min-width:12em}.kh-w14{min-width:14em}.kh-w16{min-width:16em}.kh-w18{min-width:18em}.kh-w20{min-width:20em}
.kh-fill{font-weight:700;border-bottom:1.5px solid #0E9F6E;padding:0 2px}
.kh-box{display:inline-block;width:14px;height:14px;border:1.5px solid #1E2B2F;border-radius:2px;vertical-align:-2px}
.kh-table-wrap{overflow-x:auto;margin:12px 0}
.kh-table{width:100%;border-collapse:collapse;font-size:14px}
.kh-table th,.kh-table td{border:1px solid #EADFD2;padding:7px 10px;text-align:left;vertical-align:top}
.kh-table th{background:#F6ECDF}
.kh-num-cell{text-align:right;white-space:nowrap}
.kh-total td{font-weight:700}
.kh-sign{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:18px 26px;margin-top:26px}
.kh-sig{display:grid;grid-template-columns:1fr 100px;gap:2px 12px;font-size:13px;color:#56636A}
.kh-sig-line{border-bottom:1.5px solid #1E2B2F;height:30px}
.kh-doc-foot{margin-top:26px;padding-top:12px;border-top:1px solid #EADFD2;font-size:12px;color:#56636A}
.kh-msg{font-size:17px;padding:24px 0}
@media print{body{background:#fff}main{padding:0;max-width:none}.kh-rule,.kh-note{break-inside:avoid}.kh-sign{break-inside:avoid}}`;

/** No scripts, nothing from other sites; only this site may frame it (the app shows it inline). */
export const DOC_CSP = "default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; img-src 'self' data:; frame-ancestors 'self'; form-action 'none'; base-uri 'none'";

/** A whole page around a rendered document (or a short message when it can't be shown). */
export function docPage(title: string, inner: { doc: string } | { message: string }): string {
  const body = 'doc' in inner ? inner.doc : `<p class="kh-msg">${esc(inner.message)}</p>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>${DOC_CSS}</style></head><body><main>${body}</main></body></html>`;
}
