// Real integrations, written against each vendor's public HTTP API with fetch
// (no SDKs, so there is nothing extra to install). Each needs credentials in
// .env; without them, src/services.ts falls back to the mock versions.
// IMPORTANT: these have not been run against live accounts yet. Test each one
// in the vendor's sandbox/test mode before going live.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { BRAND } from '../config/brand.ts';
import type { LockProvider, MessagingProvider, OutboundMessage, PaymentsProvider } from './types.ts';

async function call(url: string, init: RequestInit): Promise<any> {
  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${url} → ${res.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : {};
}

/* ---------------- Twilio (SMS) ---------------- */
export class TwilioSMS implements MessagingProvider {
  name = 'twilio';
  private sid: string;
  private token: string;
  private from: string; // E.164 number or Messaging Service SID (MG...)
  constructor(o: { accountSid: string; authToken: string; from: string }) {
    this.sid = o.accountSid;
    this.token = o.authToken;
    this.from = o.from;
  }
  async send(msg: OutboundMessage) {
    const body = new URLSearchParams({ To: msg.to, Body: msg.body });
    if (this.from.startsWith('MG')) body.set('MessagingServiceSid', this.from);
    else body.set('From', this.from);
    for (const m of msg.media ?? []) body.append('MediaUrl', m);
    const data = await call(`https://api.twilio.com/2010-04-01/Accounts/${this.sid}/Messages.json`, {
      method: 'POST',
      headers: { authorization: 'Basic ' + Buffer.from(`${this.sid}:${this.token}`).toString('base64'), 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    return { providerId: data.sid as string };
  }
}

/** Twilio signs webhooks: HMAC-SHA1 of the full URL + sorted POST params. */
export function verifyTwilioSignature(authToken: string, url: string, params: Record<string, string>, signature: string): boolean {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  const expected = createHmac('sha1', authToken).update(data).digest('base64');
  return safeEqual(expected, signature);
}

/* ---------------- Postmark (email) ---------------- */
export class PostmarkEmail implements MessagingProvider {
  name = 'postmark';
  private token: string;
  private from: string;
  constructor(o: { serverToken: string; from: string }) {
    this.token = o.serverToken;
    this.from = o.from;
  }
  async send(msg: OutboundMessage) {
    const data = await call('https://api.postmarkapp.com/email', {
      method: 'POST',
      headers: { 'x-postmark-server-token': this.token, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ From: this.from, To: msg.to, Subject: msg.subject ?? `Message from ${BRAND.name}`, TextBody: msg.body, MessageStream: 'outbound' }),
    });
    return { providerId: data.MessageID as string };
  }
}

/** Routes each message to the right provider by channel. */
export class ChannelRouter implements MessagingProvider {
  name = 'router';
  private by: Partial<Record<OutboundMessage['channel'], MessagingProvider>>;
  private fallback: MessagingProvider;
  constructor(by: Partial<Record<OutboundMessage['channel'], MessagingProvider>>, fallback: MessagingProvider) {
    this.by = by;
    this.fallback = fallback;
  }
  async send(msg: OutboundMessage) {
    return (this.by[msg.channel] ?? this.fallback).send(msg);
  }
}

/* ---------------- Stripe (rent by ACH) ---------------- */
// Rent is collected with Stripe Checkout using US bank accounts (ACH), and
// paid to the owner's Stripe Connect account so money never sits with us.
export class StripePayments implements PaymentsProvider {
  name = 'stripe';
  private key: string;
  private successUrl: string;
  constructor(o: { secretKey: string; publicUrl: string }) {
    this.key = o.secretKey;
    this.successUrl = o.publicUrl.replace(/\/$/, '') + '/paid';
  }
  private form(path: string, params: Record<string, string>) {
    return call('https://api.stripe.com/v1/' + path, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.key}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params),
    });
  }
  async createPaymentLink(i: { chargeId: string; amount: number; description: string; ownerAccountId?: string; tenantEmail?: string }) {
    const p: Record<string, string> = {
      mode: 'payment',
      'payment_method_types[0]': 'us_bank_account',
      'line_items[0][quantity]': '1',
      'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][unit_amount]': String(i.amount),
      'line_items[0][price_data][product_data][name]': i.description,
      'metadata[charge_id]': i.chargeId,
      'payment_intent_data[metadata][charge_id]': i.chargeId,
      success_url: this.successUrl,
    };
    if (i.tenantEmail) p.customer_email = i.tenantEmail;
    if (i.ownerAccountId) p['payment_intent_data[transfer_data][destination]'] = i.ownerAccountId;
    const s = await this.form('checkout/sessions', p);
    return { url: s.url as string, providerRef: s.id as string };
  }
  // Vendor payouts and deposit refunds are recorded as manual in the MVP:
  // the owner pays from their own bank and Landwell records it.
  async payVendor(i: { vendorId: string }) {
    return { providerRef: 'manual_' + i.vendorId, manual: true };
  }
  async refundDeposit(i: { leaseId: string }) {
    return { providerRef: 'manual_' + i.leaseId, manual: true };
  }
}

/** Stripe-Signature header: t=timestamp,v1=HMAC-SHA256(timestamp.payload). */
export function verifyStripeSignature(secret: string, payload: string, header: string, toleranceSec = 300): boolean {
  const parts = Object.fromEntries(header.split(',').map((kv) => kv.split('=') as [string, string]));
  if (!parts.t || !parts.v1) return false;
  if (Math.abs(Date.now() / 1000 - Number(parts.t)) > toleranceSec) return false;
  const expected = createHmac('sha256', secret).update(`${parts.t}.${payload}`).digest('hex');
  return safeEqual(expected, parts.v1);
}

/* ---------------- Seam (smart locks, many brands) ---------------- */
export class SeamLocks implements LockProvider {
  name = 'seam';
  private key: string;
  constructor(o: { apiKey: string }) {
    this.key = o.apiKey;
  }
  private post(path: string, body: unknown) {
    return call('https://connect.getseam.com' + path, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.key}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
  async createCode(i: { deviceId: string; from: string; to: string; label: string }) {
    const r = await this.post('/access_codes/create', { device_id: i.deviceId, name: i.label, starts_at: i.from, ends_at: i.to });
    return { code: r.access_code.code as string, codeId: r.access_code.access_code_id as string };
  }
  async revokeCode(i: { codeId: string }) {
    await this.post('/access_codes/delete', { access_code_id: i.codeId });
  }
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
