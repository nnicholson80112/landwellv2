// Colorado rules the workflows enforce. Each constant cites where it comes
// from. Laws change: have a Colorado landlord-tenant attorney review this
// file before launch and at least once a year. This is not legal advice.

import { HOUR } from '../engine/clock.ts';

export const CO = {
  /** SB24-094: begin remedial action within 24h for conditions that materially affect life, health or safety; otherwise within 72h of notice. */
  repairStart: { emergency: 24 * HOUR, urgent: 24 * HOUR, routine: 72 * HOUR },

  /** SB21-173 (C.R.S. 38-12-105): no late fee until rent is 7+ days late; fee capped at the greater of $50 or 5% of past-due rent. Must be in the lease. */
  lateFee: { minDaysLate: 7, flatCapCents: 5_000, percentCap: 0.05 },

  /** Nonpayment demand period before an eviction filing (C.R.S. 13-40-104, 10 days since 2021). Landwell never files; it only prepares the notice for the owner. */
  nonpaymentDemandDays: 10,

  /** HB25-1090: advertised rent must include all mandatory fees; a free way to pay rent must exist.
   *  Landwell never collects rent, so the free payment method is the OWNER's to provide; we remind them at setup. */
  allInRentRequired: true,
  freePaymentMethodRequired: true,

  /** HB25-1249 (eff. 2026-01-01): return the deposit (or itemized deductions) within 30 days. Lease may allow up to 60; we use 30. */
  depositReturnDays: 30,

  /** HB24-1098: non-renewal of a covered tenancy needs a statutory reason and generally 90 days' notice. */
  nonRenewalNoticeDays: 90,
  forCauseNonRenewalReasons: [
    'Owner or family member will move in',
    'Selling the home (withdrawing from the rental market)',
    'Substantial repairs or renovation',
    'Demolition or conversion to non-residential use',
    'Tenant refused a new lease with reasonable terms',
    'Rent paid late 3+ times in the rental period',
  ],

  /** HB21-1121: rent can rise only once per 12 months; tenants without a written lease get 60 days' notice. */
  rentIncreaseMinMonthsApart: 12,
  rentIncreaseNoticeDaysNoLease: 60,

  /** HB24-1098: notices go in the tenant's primary language when the landlord knows it. */
  noticesInPrimaryLanguage: true,
} as const;

export function cappedLateFee(requestedCents: number, pastDueRentCents: number): number {
  const cap = Math.max(CO.lateFee.flatCapCents, Math.round(pastDueRentCents * CO.lateFee.percentCap));
  return Math.min(requestedCents, cap);
}
