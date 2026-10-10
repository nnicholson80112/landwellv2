// Every outside service sits behind one of these interfaces. Each has a
// console/mock version (for the demo and tests) and a real version.
// Swap them in src/services.ts based on environment variables.

import type { Cents, Channel } from '../domain/types.ts';

export interface OutboundMessage {
  channel: Channel;
  to: string; // phone (E.164) or email
  body: string;
  subject?: string; // email only
  media?: string[];
}
export interface MessagingProvider {
  name: string;
  send(msg: OutboundMessage): Promise<{ providerId: string }>;
}

export interface PaymentsProvider {
  name: string;
  /** A hosted link where the tenant pays a charge by free ACH (or card if the owner allows). */
  createPaymentLink(input: { chargeId: string; amount: Cents; description: string; ownerAccountId?: string; tenantEmail?: string }): Promise<{ url: string; providerRef: string }>;
  /** Pay a vendor from the owner's connected account (or record a manual payment). */
  payVendor(input: { vendorId: string; amount: Cents; memo: string; ownerAccountId?: string }): Promise<{ providerRef: string; manual: boolean }>;
  refundDeposit(input: { leaseId: string; amount: Cents; memo: string }): Promise<{ providerRef: string; manual: boolean }>;
}

export interface ESignProvider {
  name: string;
  send(input: { documentTitle: string; body: string; signers: { name: string; email?: string; phone?: string; role: 'tenant' | 'owner' }[]; refId: string }): Promise<{ envelopeId: string; signUrl?: string }>;
}

export interface LockProvider {
  name: string;
  /** One-time access code valid only between from and to. */
  createCode(input: { deviceId: string; from: string; to: string; label: string }): Promise<{ code: string; codeId: string }>;
  revokeCode(input: { deviceId: string; codeId: string }): Promise<void>;
}

export interface IdentityProvider {
  name: string;
  /** Link where a prospect verifies a government ID before a self-showing. */
  createVerification(input: { refId: string; name?: string }): Promise<{ url: string; verificationId: string }>;
}

export interface ScreeningProvider {
  name: string;
  /** Link where the applicant authorizes and pays for their own screening. */
  createInvite(input: { applicationId: string; applicantName: string; email?: string; phone?: string }): Promise<{ url: string; inviteId: string }>;
}

export interface ListingsProvider {
  name: string;
  publish(input: { propertyId: string; title: string; description: string; rent: Cents; beds: number; baths: number; address: string }): Promise<{ channels: { name: string; status: 'live' | 'pending' | 'manual' }[] }>;
  unpublish(input: { propertyId: string }): Promise<void>;
}

export interface Adapters {
  messaging: MessagingProvider;
  payments: PaymentsProvider;
  esign: ESignProvider;
  locks: LockProvider;
  identity: IdentityProvider;
  screening: ScreeningProvider;
  listings: ListingsProvider;
}
