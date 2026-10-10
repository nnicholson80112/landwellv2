// Built-in click-to-sign. Each signer gets a private link; the API serves a
// page showing the full document, and records name, time, IP and consent when
// they sign (see src/api/server.ts → /sign/:token). The API then emits
// `document.signed`, which the lease workflow is waiting for.
// Have an attorney confirm this meets ESIGN/UETA for your use, or swap in a
// vendor (Dropbox Sign, DocuSign) behind the same ESignProvider interface.

import { randomBytes, createHash } from 'node:crypto';
import type { ESignProvider } from './types.ts';
import type { Store } from '../store/store.ts';

export interface SignRequest {
  token: string;
  refId: string; // e.g. lease id
  envelopeId: string;
  title: string;
  body: string;
  bodyHash: string; // sha256 of the exact text shown, stored with the signature
  signer: { name: string; email?: string; phone?: string; role: 'tenant' | 'owner' };
  status: 'pending' | 'signed';
  signedAt?: string;
  signedName?: string;
  ip?: string;
  userAgent?: string;
}

export class NativeESign implements ESignProvider {
  name = 'native-esign';
  private store: Store;
  private publicUrl: string;
  constructor(o: { store: Store; publicUrl: string }) {
    this.store = o.store;
    this.publicUrl = o.publicUrl.replace(/\/$/, '');
  }
  async send(i: { documentTitle: string; body: string; signers: SignRequest['signer'][]; refId: string }) {
    const envelopeId = 'env_' + randomBytes(6).toString('hex');
    const bodyHash = createHash('sha256').update(i.body).digest('hex');
    let firstUrl: string | undefined;
    for (const s of i.signers) {
      const token = randomBytes(18).toString('base64url');
      const req: SignRequest = { token, refId: i.refId, envelopeId, title: i.documentTitle, body: i.body, bodyHash, signer: s, status: 'pending' };
      this.store.kvSet('sign', token, req);
      firstUrl ??= `${this.publicUrl}/sign/${token}`;
    }
    return { envelopeId, signUrl: firstUrl };
  }
  /** Links for each signer of an envelope (workflows text these out). */
  links(envelopeId: string): { role: string; name: string; url: string }[] {
    return this.store
      .kvList<SignRequest>('sign')
      .filter((r) => r.envelopeId === envelopeId)
      .map((r) => ({ role: r.signer.role, name: r.signer.name, url: `${this.publicUrl}/sign/${r.token}` }));
  }
}
