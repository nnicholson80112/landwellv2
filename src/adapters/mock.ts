// Console / mock adapters. Used by the demo and tests, and as safe defaults
// when an integration has no credentials yet. They never contact anyone.

import { randomInt } from 'node:crypto';
import type { ESignProvider, IdentityProvider, ListingsProvider, LockProvider, MessagingProvider, OutboundMessage, PaymentsProvider, ScreeningProvider } from './types.ts';

export class OutboxMessaging implements MessagingProvider {
  name = 'outbox';
  sent: (OutboundMessage & { at: string })[] = [];
  private log: boolean;
  constructor(opts: { log?: boolean } = {}) {
    this.log = opts.log ?? false;
  }
  async send(msg: OutboundMessage) {
    this.sent.push({ ...msg, at: new Date().toISOString() });
    if (this.log) console.log(`  ↗ ${msg.channel.toUpperCase()} to ${msg.to}: ${msg.body}`);
    return { providerId: 'outbox_' + this.sent.length };
  }
}

export class MockPayments implements PaymentsProvider {
  name = 'mock-payments';
  async createPaymentLink(i: { chargeId: string }) {
    return { url: `https://pay.example.test/c/${i.chargeId}`, providerRef: 'mock_' + i.chargeId };
  }
  async payVendor(i: { vendorId: string }) {
    return { providerRef: 'manual_' + i.vendorId, manual: true };
  }
  async refundDeposit(i: { leaseId: string }) {
    return { providerRef: 'manual_' + i.leaseId, manual: true };
  }
}

export class MockLocks implements LockProvider {
  name = 'mock-locks';
  async createCode(i: { deviceId: string }) {
    const code = String(randomInt(1000, 9999));
    return { code, codeId: `code_${i.deviceId}_${code}` };
  }
  async revokeCode() {}
}

export class MockIdentity implements IdentityProvider {
  name = 'mock-identity';
  async createVerification(i: { refId: string }) {
    return { url: `https://verify.example.test/${i.refId}`, verificationId: 'idv_' + i.refId };
  }
}

export class MockScreening implements ScreeningProvider {
  name = 'mock-screening';
  async createInvite(i: { applicationId: string }) {
    return { url: `https://screening.example.test/apply/${i.applicationId}`, inviteId: 'scr_' + i.applicationId };
  }
}

export class ManualListings implements ListingsProvider {
  name = 'manual-listings';
  async publish() {
    // Until the Zillow feed is approved, the owner posts by hand from the generated copy.
    return { channels: [{ name: 'Zillow Rental Manager (post manually)', status: 'manual' as const }] };
  }
  async unpublish() {}
}

export class MockESign implements ESignProvider {
  name = 'mock-esign';
  async send(i: { refId: string }) {
    return { envelopeId: 'env_' + i.refId, signUrl: `https://sign.example.test/${i.refId}` };
  }
}
