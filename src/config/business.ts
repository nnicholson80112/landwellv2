// Business details shown in the site footer and every legal page.
// Values come from Railway Variables so they can be filled in without a code change.
// Until a value is set, the page shows a bracketed placeholder, and every legal page
// carries a "draft" notice until LEGAL_REVIEWED=true (set it only after an attorney signs off).

import { BRAND } from './brand.ts';

const env = process.env;

export const BUSINESS = {
  /** Registered legal name, e.g. "Landwell LLC". */
  legalName: env.BUSINESS_LEGAL_NAME || '[Legal business name]',
  /** Mailing address customers can write to (a registered agent or mailbox is fine). */
  address: env.BUSINESS_ADDRESS || '[Business mailing address]',
  /** Where customers and tenants reach a person. */
  email: env.BUSINESS_EMAIL || BRAND.supportEmail,
  phone: env.BUSINESS_PHONE || '',
  state: 'Colorado',
  /** Date the current legal pages took effect (YYYY-MM-DD). */
  legalEffective: env.LEGAL_EFFECTIVE_DATE || '',
  legalReviewed: env.LEGAL_REVIEWED === 'true',
};

/** True when every value a customer needs is filled in. The launch checklist relies on this. */
export function businessDetailsComplete(): boolean {
  return !!(env.BUSINESS_LEGAL_NAME && env.BUSINESS_ADDRESS && env.BUSINESS_EMAIL && env.LEGAL_EFFECTIVE_DATE);
}
