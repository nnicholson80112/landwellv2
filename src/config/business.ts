// Business details shown in the site footer and every legal page.
// Values come from Railway Variables so they can be filled in without a code change.
// The legal name defaults to KeyHelm LLC. Pages are owner-approved (Nate reviewed them
// against Colorado law); set LEGAL_REVIEWED=false to bring back the "draft" notice.

import { BRAND } from './brand.ts';

const env = process.env;

export const BUSINESS = {
  /** Registered legal name, e.g. "KeyHelm LLC". */
  legalName: env.BUSINESS_LEGAL_NAME || 'KeyHelm LLC',
  /** Mailing address customers can write to (a registered agent or mailbox is fine). Optional: pages leave it out when empty. */
  address: (env.BUSINESS_ADDRESS || '').trim(),
  /** Where customers and tenants reach a person. */
  email: env.BUSINESS_EMAIL || BRAND.supportEmail,
  phone: env.BUSINESS_PHONE || '',
  state: 'Colorado',
  /** Date the current legal pages took effect (YYYY-MM-DD). */
  legalEffective: env.LEGAL_EFFECTIVE_DATE || '2026-10-20',
  legalReviewed: env.LEGAL_REVIEWED !== 'false',
};

/** True when every value a customer needs is filled in. The launch checklist relies on this. */
export function businessDetailsComplete(): boolean {
  return !!(BUSINESS.legalName && env.BUSINESS_ADDRESS && env.BUSINESS_EMAIL && BUSINESS.legalEffective);
}
