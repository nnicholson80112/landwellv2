// HTTP API + webhooks. No framework: node:http only.
//
//   Public:    GET /            marketing site
//              GET /apply/:id   application form      POST /api/public/apply/:id
//              GET /sign/:token lease signing page    POST /sign/:token
//   Webhooks:  POST /webhooks/twilio/sms   (texts in)
//              POST /webhooks/email        (Postmark inbound)
//              POST /webhooks/voice        (any voice agent: transcript in, reply out)
//              POST /webhooks/stripe       (Landwell's own subscription billing; never rent)
//              POST /webhooks/screening    (screening partner results)
//              POST /webhooks/identity     (ID verification results)
//   Owner API: /api/... with  Authorization: Bearer <OWNER_API_TOKEN>
//
// Run: npm start   (reads .env from the environment; see .env.example)

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { MemoryStore } from '../store/store.ts';
import { SystemClock } from '../engine/clock.ts';
import { createServices, type Services } from '../services.ts';
import { install } from '../workflows/index.ts';
import { verifyStripeSignature, verifyTwilioSignature } from '../adapters/live.ts';
import { StripeBilling, applyBillingEvent, type Plan } from '../billing/stripe.ts';
import type { SignRequest } from '../adapters/esign-native.ts';
import { prepareTemplate } from '../leases/template.ts';
import { addressKey, money } from '../workflows/lib.ts';
import { seed } from '../sim/seed.ts';
import { BRAND } from '../config/brand.ts';
import type { TableName } from '../domain/types.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

type Req = IncomingMessage & { raw: string; body: any; params: Record<string, string>; query: URLSearchParams };
type Handler = (req: Req, res: ServerResponse, svc: Services) => Promise<void> | void;
interface Route { method: string; pattern: RegExp; keys: string[]; auth: boolean; h: Handler }

const routes: Route[] = [];
function route(method: string, path: string, h: Handler, auth = false) {
  const keys: string[] = [];
  const pattern = new RegExp('^' + path.replace(/:(\w+)/g, (_m, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
  routes.push({ method, pattern, keys, auth, h });
}

const json = (res: ServerResponse, code: number, data: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data, null, 2)); };
const html = (res: ServerResponse, code: number, body: string) => { res.writeHead(code, { 'content-type': 'text/html; charset=utf-8' }); res.end(body); };
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function page(title: string, inner: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{margin:0;background:#F6F9FF;color:#0E1B33;font:16px/1.55 system-ui,sans-serif}main{max-width:720px;margin:0 auto;padding:32px 20px}h1{font-size:28px;margin:0 0 8px}
.card{background:#fff;border:1px solid #D8E1F2;border-radius:18px;padding:22px;margin:16px 0}label{display:block;font-weight:700;margin:12px 0 6px}input{width:100%;box-sizing:border-box;min-height:48px;border:1.5px solid #D8E1F2;border-radius:12px;padding:10px 14px;font:inherit}
button{background:#1B4DFF;color:#fff;border:0;border-radius:12px;padding:14px 22px;font:700 16px system-ui;margin-top:16px;cursor:pointer}pre{white-space:pre-wrap;font:15px/1.6 Georgia,serif;max-height:60vh;overflow:auto;background:#FAFBFF;border:1px solid #D8E1F2;border-radius:12px;padding:18px}.muted{color:#4A5A78;font-size:14px}</style></head><body><main>${inner}</main></body></html>`;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) { size += (c as Buffer).length; if (size > 2_000_000) throw new Error('body too large'); chunks.push(c as Buffer); }
  return Buffer.concat(chunks).toString('utf8');
}

/* ======================= PUBLIC ======================= */

route('GET', '/health', (_q, res) => json(res, 200, { ok: true }));

route('GET', '/', (_q, res) => {
  const f = join(ROOT, 'apps/site/index.html');
  if (existsSync(f)) return html(res, 200, readFileSync(f, 'utf8'));
  html(res, 200, page(BRAND.name, `<h1>${BRAND.name}</h1>`+'<p>Run <code>npm run build:site</code> to build the marketing site.</p>'));
});

route('GET', '/apply/:propertyId', (req, res, svc) => {
  const p = svc.store.get('properties', req.params.propertyId);
  if (!p || !['listed', 'vacant'].includes(p.status)) return html(res, 404, page('Not available', '<h1>This home is not taking applications</h1>'));
  html(res, 200, page(`Apply: ${p.address}`, `<h1>Apply for ${esc(p.address)}</h1><p class="muted">${p.beds} bed · ${p.baths} bath · ${money(p.rent)}/month all-in. Every applicant is reviewed against the same written criteria, in the order received. After you submit, you'll get a link to complete screening with our screening partner.</p>
<form class="card" method="post" action="/api/public/apply/${p.id}"><label for="n">Full name</label><input id="n" name="name" required autocomplete="name"><label for="e">Email</label><input id="e" name="email" type="email" required autocomplete="email"><label for="ph">Mobile phone</label><input id="ph" name="phone" required autocomplete="tel"><button>Submit application</button><p class="muted">Equal Housing Opportunity.</p></form>`));
});

route('POST', '/api/public/apply/:propertyId', async (req, res, svc) => {
  const p = svc.store.get('properties', req.params.propertyId);
  if (!p) return json(res, 404, { error: 'not found' });
  const b = req.body;
  if (!b.name || !(b.email || b.phone)) return json(res, 400, { error: 'name and email or phone required' });
  const app = svc.store.insert('applications', { ownerId: p.ownerId, propertyId: p.id, applicantName: String(b.name).slice(0, 120), email: b.email, phone: b.phone, submittedAt: svc.clock.now().toISOString(), status: 'submitted' });
  svc.engine.emit('application.submitted', { applicationId: app.id });
  await svc.engine.drain();
  if ((req.headers['content-type'] ?? '').includes('form')) return html(res, 200, page('Application received', `<h1>Thanks, ${esc(app.applicantName.split(' ')[0])}!</h1><p>Check your texts and email for the screening link.</p>`));
  json(res, 201, { applicationId: app.id });
});

route('GET', '/sign/:token', (req, res, svc) => {
  const r = svc.store.kvGet<SignRequest>('sign', req.params.token);
  if (!r) return html(res, 404, page('Not found', '<h1>This signing link is not valid</h1>'));
  if (r.status === 'signed') return html(res, 200, page('Signed', `<h1>Signed</h1><p>${esc(r.signedName ?? '')} signed on ${esc(r.signedAt ?? '')}.</p>`));
  html(res, 200, page(r.title, `<h1>${esc(r.title)}</h1><p class="muted">Please read the whole document. Signing below is the same as signing on paper.</p><pre>${esc(r.body)}</pre>
<form class="card" method="post"><label for="n">Type your full legal name to sign</label><input id="n" name="name" required value="${esc(r.signer.name)}"><label style="font-weight:500"><input type="checkbox" name="consent" value="yes" required style="width:auto;min-height:0"> I agree to sign electronically and to receive this document electronically.</label><button>Sign lease</button></form>`));
});

route('POST', '/sign/:token', async (req, res, svc) => {
  const r = svc.store.kvGet<SignRequest>('sign', req.params.token);
  if (!r || r.status === 'signed') return html(res, 400, page('Not available', '<h1>This link was already used or is not valid</h1>'));
  if (req.body.consent !== 'yes' || !req.body.name) return html(res, 400, page('Missing consent', '<h1>Please type your name and check the consent box</h1>'));
  const signed: SignRequest = { ...r, status: 'signed', signedAt: svc.clock.now().toISOString(), signedName: String(req.body.name).slice(0, 120), ip: String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? ''), userAgent: String(req.headers['user-agent'] ?? '') };
  svc.store.kvSet('sign', r.token, signed);
  svc.engine.audit({ ownerId: svc.store.get('leases', r.refId)?.ownerId, actor: r.signer.role, action: 'document.signed', detail: `${signed.signedName} signed "${r.title}" (sha256 ${r.bodyHash.slice(0, 12)}…) from ${signed.ip}` });
  svc.engine.emit('document.signed', { refId: r.refId, role: r.signer.role, name: r.signer.name, envelopeId: r.envelopeId });
  await svc.engine.drain();
  html(res, 200, page('Signed', `<h1>Thank you, ${esc(signed.signedName!.split(' ')[0])}!</h1><p>Your signature is recorded. A copy is available from your landlord.</p>`));
});

/* ======================= WEBHOOKS ======================= */

function ownerForLine(svc: Services, to?: string): string | undefined {
  if (!to) return svc.store.list('owners').length === 1 ? svc.store.list('owners')[0].id : undefined;
  const k = addressKey(to);
  return svc.store.find('owners', (o) => (!!o.lineNumber && addressKey(o.lineNumber) === k) || (!!o.lineEmail && o.lineEmail.toLowerCase() === k))?.id
    ?? (svc.store.list('owners').length === 1 ? svc.store.list('owners')[0].id : undefined);
}

route('POST', '/webhooks/twilio/sms', async (req, res, svc) => {
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (token) {
    const url = (svc.cfg.publicUrl.replace(/\/$/, '')) + req.url;
    if (!verifyTwilioSignature(token, url, req.body, String(req.headers['x-twilio-signature'] ?? ''))) return json(res, 403, { error: 'bad signature' });
  }
  const b = req.body as Record<string, string>;
  const media = Array.from({ length: Number(b.NumMedia ?? 0) }, (_x, i) => b[`MediaUrl${i}`]).filter(Boolean);
  svc.engine.emit('message.received', { from: b.From, to: b.To, channel: 'sms', body: b.Body ?? '', media, ownerId: ownerForLine(svc, b.To), providerMessageId: b.MessageSid });
  res.writeHead(200, { 'content-type': 'text/xml' });
  res.end('<Response></Response>'); // replies go out through the API, not TwiML
  void svc.engine.drain();
});

route('POST', '/webhooks/email', async (req, res, svc) => {
  if (process.env.EMAIL_WEBHOOK_SECRET && req.query.get('key') !== process.env.EMAIL_WEBHOOK_SECRET) return json(res, 403, { error: 'bad key' });
  const b = req.body;
  const from = (b.FromFull?.Email ?? b.From ?? '').toString();
  const text = (b.StrippedTextReply || b.TextBody || '').toString();
  svc.engine.emit('message.received', { from, to: b.OriginalRecipient ?? b.To, channel: 'email', body: text, subject: b.Subject, media: (b.Attachments ?? []).map((a: any) => a.Name), ownerId: ownerForLine(svc, b.OriginalRecipient ?? b.To), providerMessageId: b.MessageID });
  json(res, 200, { ok: true });
  void svc.engine.drain();
});

/**
 * Voice: plug in any voice agent (in-house, Retell, Vapi, Twilio ConversationRelay...).
 * The agent sends each caller turn as { from, to, transcript, callId } and speaks
 * back the `reply` we return. Same brain, same guardrails as texting.
 */
route('POST', '/webhooks/voice', async (req, res, svc) => {
  if (process.env.VOICE_WEBHOOK_SECRET && req.headers.authorization !== `Bearer ${process.env.VOICE_WEBHOOK_SECRET}`) return json(res, 403, { error: 'unauthorized' });
  const b = req.body;
  const since = svc.clock.now().toISOString();
  svc.engine.emit('message.received', { from: b.from, to: b.to, channel: 'voice', body: String(b.transcript ?? ''), ownerId: ownerForLine(svc, b.to), providerMessageId: b.callId && b.turnId ? `${b.callId}:${b.turnId}` : undefined });
  await svc.engine.drain();
  const reply = svc.store.list('messages', (m) => m.direction === 'out' && m.threadKey === addressKey(b.from) && m.channel === 'voice' && m.at >= since).pop();
  json(res, 200, { reply: reply?.body ?? "Thanks, I've passed that along. Is there anything else?" });
});

/* ---- Phone calls with no extra vendor: Twilio Voice speech recognition ----
 * Point the Twilio number's "A call comes in" webhook at /webhooks/twilio/voice.
 * Twilio turns speech into text, we answer through the same front desk as texts,
 * and Twilio reads the reply aloud. Emergencies are transferred to the owner.
 */
const xml = (s: string) => s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);
function twiml(res: ServerResponse, inner: string) {
  res.writeHead(200, { 'content-type': 'text/xml' });
  res.end(`<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`);
}
const VOICE = process.env.TWILIO_VOICE ?? 'Polly.Joanna';
const gather = (prompt: string) => `<Gather input="speech" action="/webhooks/twilio/voice/turn" method="POST" speechTimeout="auto" language="en-US"><Say voice="${VOICE}">${xml(prompt)}</Say></Gather>`;

function twilioOk(req: Req, svc: Services): boolean {
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!token) return true;
  return verifyTwilioSignature(token, svc.cfg.publicUrl.replace(/\/$/, '') + req.url, req.body, String(req.headers['x-twilio-signature'] ?? ''));
}

route('POST', '/webhooks/twilio/voice', (req, res, svc) => {
  if (!twilioOk(req, svc)) return json(res, 403, { error: 'bad signature' });
  const ownerId = ownerForLine(svc, req.body.To);
  const owner = ownerId ? svc.store.get('owners', ownerId) : undefined;
  twiml(res, gather(`Hi, you've reached ${BRAND.name}${owner ? `, the rental line for ${owner.name.split(' ')[0]}'s homes` : ''}. I'm an automated assistant. How can I help you today?`) + `<Say voice="${VOICE}">Sorry, I didn't catch that. You can also text this number anytime. Goodbye.</Say>`);
});

route('POST', '/webhooks/twilio/voice/turn', async (req, res, svc) => {
  if (!twilioOk(req, svc)) return json(res, 403, { error: 'bad signature' });
  const b = req.body as Record<string, string>;
  const speech = (b.SpeechResult ?? '').trim();
  if (!speech) return twiml(res, gather('Sorry, could you say that again?'));
  const ownerId = ownerForLine(svc, b.To);
  const since = svc.clock.now().toISOString();
  svc.engine.emit('message.received', { from: b.From, to: b.To, channel: 'voice', body: speech, ownerId, providerMessageId: `${b.CallSid}:${speech}` });
  await svc.engine.drain();
  const reply = svc.store.list('messages', (m) => m.direction === 'out' && m.threadKey === addressKey(b.From) && m.channel === 'voice' && m.at >= since).pop()?.body
    ?? "Thanks, I've passed that along to the owner.";
  const emergency = svc.store.list('workOrders', (w) => w.urgency === 'emergency' && w.createdAt >= since).length > 0;
  const owner = ownerId ? svc.store.get('owners', ownerId) : undefined;
  if (emergency && owner?.phone) {
    return twiml(res, `<Say voice="${VOICE}">${xml(reply)} I'm connecting you to the owner now.</Say><Dial timeout="25">${xml(owner.phone)}</Dial><Say voice="${VOICE}">The owner didn't pick up, but they've been alerted and the emergency vendor is being contacted. Goodbye.</Say>`);
  }
  twiml(res, `<Say voice="${VOICE}">${xml(reply)}</Say>` + gather('Is there anything else I can help with?') + `<Say voice="${VOICE}">Thanks for calling. Goodbye.</Say>`);
});

// Stripe: Landwell's OWN subscription billing only. Landwell never collects rent.
route('POST', '/webhooks/stripe', async (req, res, svc) => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return json(res, 503, { error: 'STRIPE_WEBHOOK_SECRET is not set' });
  if (!verifyStripeSignature(secret, req.raw, String(req.headers['stripe-signature'] ?? ''))) return json(res, 400, { error: 'bad signature' });
  const done = applyBillingEvent(svc.store, req.body, svc.clock.now().toISOString());
  if (done) svc.engine.audit({ ownerId: done.ownerId, actor: 'system', action: 'billing.updated', detail: `Landwell subscription: ${done.billing.status}${done.billing.plan ? `, ${done.billing.plan}` : ''}${done.billing.doors ? `, ${done.billing.doors} door${done.billing.doors === 1 ? '' : 's'}` : ''} (${req.body.type}).` });
  json(res, 200, { received: true });
});

route('GET', '/billing/done', (_req, res) => {
  html(res, 200, page(`${BRAND.name}: you're subscribed`, `<h1>You're all set</h1><p>Thanks for subscribing to ${BRAND.name}. Your receipt is on its way by email. You can close this page.</p>`));
});

route('POST', '/webhooks/screening', async (req, res, svc) => {
  if (process.env.SCREENING_WEBHOOK_SECRET && req.headers.authorization !== `Bearer ${process.env.SCREENING_WEBHOOK_SECRET}`) return json(res, 403, { error: 'unauthorized' });
  svc.engine.emit('screening.completed', { applicationId: req.body.applicationId, report: req.body.report });
  await svc.engine.drain();
  json(res, 200, { ok: true });
});

route('POST', '/webhooks/identity', async (req, res, svc) => {
  if (process.env.IDENTITY_WEBHOOK_SECRET && req.headers.authorization !== `Bearer ${process.env.IDENTITY_WEBHOOK_SECRET}`) return json(res, 403, { error: 'unauthorized' });
  if (req.body.status === 'verified') svc.engine.emit('identity.verified', { refId: req.body.refId });
  await svc.engine.drain();
  json(res, 200, { ok: true });
});

/* ======================= OWNER API ======================= */
// MVP auth: one bearer token per owner (kv "tokens"), or OWNER_API_TOKEN for the
// first owner. Replace with real sign-in (Clerk, Auth0, Supabase Auth) before launch.

function ownerOf(req: Req, svc: Services): string | undefined {
  const t = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  if (!t) return undefined;
  const id = svc.store.kvGet<string>('tokens', t);
  if (id) return id;
  if (process.env.OWNER_API_TOKEN && t === process.env.OWNER_API_TOKEN) return svc.store.list('owners')[0]?.id;
  return undefined;
}
const mine = <K extends TableName>(svc: Services, table: K, ownerId: string) => svc.store.list(table, (r: any) => r.ownerId === ownerId);

route('GET', '/api/dashboard', (req, res, svc) => {
  const o = req.params.ownerId;
  const runs = svc.engine.runs((r) => r.ownerId === o && r.status === 'waiting');
  json(res, 200, {
    owner: svc.store.get('owners', o),
    approvals: mine(svc, 'approvals', o).filter((a) => a.status === 'pending'),
    tasks: mine(svc, 'tasks', o).filter((t) => t.status === 'open'),
    properties: mine(svc, 'properties', o),
    openWorkOrders: mine(svc, 'workOrders', o).filter((w) => !['paid', 'cancelled'].includes(w.status)),
    openCharges: mine(svc, 'charges', o).filter((c) => c.status === 'open'),
    inProgress: runs.map((r) => ({ id: r.id, workflow: r.workflow, waitingFor: r.waitLabel, since: r.updatedAt })),
    activity: mine(svc, 'audit', o).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 50),
  });
}, true);

route('GET', '/api/approvals', (req, res, svc) => json(res, 200, mine(svc, 'approvals', req.params.ownerId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))), true);
route('POST', '/api/approvals/:id', async (req, res, svc) => {
  const a = svc.store.get('approvals', req.params.id);
  if (!a || a.ownerId !== req.params.ownerId) return json(res, 404, { error: 'not found' });
  try { svc.engine.decide(a.id, req.body.decision, req.body.note, req.body.data); } catch (e) { return json(res, 400, { error: (e as Error).message }); }
  await svc.engine.drain();
  json(res, 200, svc.store.get('approvals', a.id));
}, true);

/* Billing: start or change the owner's Landwell subscription. */
const PLANS: Plan[] = ['essentials', 'autopilot', 'plus'];
route('GET', '/api/billing', (req, res, svc) => json(res, 200, { plan: svc.store.get('owners', req.params.ownerId)?.plan, billing: svc.store.get('owners', req.params.ownerId)?.billing ?? null, enabled: !!process.env.STRIPE_SECRET_KEY }), true);
route('POST', '/api/billing/checkout', async (req, res, svc) => {
  if (!process.env.STRIPE_SECRET_KEY) return json(res, 503, { error: 'Billing is not set up yet: add STRIPE_SECRET_KEY in Railway.' });
  const owner = svc.store.get('owners', req.params.ownerId)!;
  const plan: Plan = PLANS.includes(req.body?.plan) ? req.body.plan : owner.plan;
  const doors = Math.max(1, Math.min(500, Number(req.body?.doors) || mine(svc, 'properties', owner.id).length || 1));
  try {
    const billing = new StripeBilling({ secretKey: process.env.STRIPE_SECRET_KEY, publicUrl: svc.cfg.publicUrl });
    const s = await billing.createCheckout({ owner, plan, doors });
    svc.store.update('owners', owner.id, { billing: { ...(owner.billing ?? {}), status: owner.billing?.status === 'active' ? 'active' : 'checkout_started', plan, doors, updatedAt: svc.clock.now().toISOString() } });
    json(res, 200, { url: s.url, plan, doors });
  } catch (e) { json(res, 502, { error: (e as Error).message }); }
}, true);

/* Rent: the owner marks rent (or a deposit) received. Tenants pay the owner directly; Landwell never handles it. */
route('POST', '/api/charges/:id/received', async (req, res, svc) => {
  const c = svc.store.get('charges', req.params.id);
  if (!c || c.ownerId !== req.params.ownerId) return json(res, 404, { error: 'not found' });
  if (c.status !== 'open') return json(res, 400, { error: `already ${c.status}` });
  const amount = Math.min(c.amount - c.paid, Math.round(Number(req.body?.amount) || c.amount - c.paid));
  svc.engine.emit('payment.received', { chargeId: c.id, amount, method: 'owner_recorded', providerRef: `owner_${c.id}_${svc.clock.now().getTime()}` });
  await svc.engine.drain();
  json(res, 200, svc.store.get('charges', c.id));
}, true);

for (const [path, table] of [['properties', 'properties'], ['tenants', 'tenants'], ['vendors', 'vendors'], ['leases', 'leases'], ['work-orders', 'workOrders'], ['charges', 'charges'], ['payments', 'payments'], ['expenses', 'expenses'], ['applications', 'applications'], ['showings', 'showings'], ['tasks', 'tasks'], ['messages', 'messages'], ['audit', 'audit']] as [string, TableName][]) {
  route('GET', `/api/${path}`, (req, res, svc) => json(res, 200, mine(svc, table, req.params.ownerId)), true);
}

route('POST', '/api/properties', (req, res, svc) => {
  const b = req.body;
  const p = svc.store.insert('properties', { ownerId: req.params.ownerId, address: b.address, city: b.city ?? '', state: b.state ?? 'CO', zip: b.zip ?? '', beds: Number(b.beds ?? 0), baths: Number(b.baths ?? 0), rent: Math.round(Number(b.rent) * 100), deposit: Math.round(Number(b.deposit ?? b.rent) * 100), status: b.status ?? 'occupied', lock: b.lock, facts: b.facts ?? {} });
  json(res, 201, p);
}, true);

route('POST', '/api/tenants', async (req, res, svc) => {
  const b = req.body;
  const t = svc.store.insert('tenants', { ownerId: req.params.ownerId, propertyId: b.propertyId, name: b.name, phone: b.phone, email: b.email, preferredChannel: b.phone ? 'sms' : 'email', autopay: false, status: 'active' });
  if (b.invite !== false) svc.engine.emit('tenant.added', { tenantId: t.id });
  await svc.engine.drain();
  json(res, 201, t);
}, true);

route('POST', '/api/vendors', (req, res, svc) => {
  const b = req.body;
  json(res, 201, svc.store.insert('vendors', { ownerId: req.params.ownerId, name: b.name, trades: b.trades ?? ['general'], phone: b.phone, email: b.email, emergency: !!b.emergency, preferred: b.preferred !== false }));
}, true);

route('PUT', '/api/rules', (req, res, svc) => {
  const cur = svc.store.get('rules', req.params.ownerId);
  if (!cur) return json(res, 404, { error: 'no rules' });
  const { id: _i, ownerId: _o, ...patch } = req.body ?? {};
  json(res, 200, svc.store.update('rules', cur.id, patch));
}, true);

route('POST', '/api/lease-templates', async (req, res, svc) => {
  const prepared = prepareTemplate(String(req.body.text ?? ''));
  if (!prepared.body.trim()) return json(res, 400, { error: 'text required (paste the lease text; PDF/Word upload converts to text first)' });
  const t = svc.store.insert('leaseTemplates', { ownerId: req.params.ownerId, name: req.body.name ?? 'My lease', body: prepared.body, fields: prepared.fields, uploadedAt: svc.clock.now().toISOString() });
  svc.engine.emit('template.uploaded', { ownerId: req.params.ownerId, templateId: t.id });
  await svc.engine.drain();
  json(res, 201, t);
}, true);

route('POST', '/api/work-orders', async (req, res, svc) => {
  const b = req.body;
  svc.engine.emit('maintenance.requested', { ownerId: req.params.ownerId, propertyId: b.propertyId, tenantId: b.tenantId, summary: b.summary, trade: b.trade ?? 'general', urgency: b.urgency ?? 'routine', photos: b.photos ?? [] });
  await svc.engine.drain();
  json(res, 202, { ok: true });
}, true);

route('POST', '/api/listings/:propertyId', async (req, res, svc) => {
  svc.engine.emit('listing.requested', { ownerId: req.params.ownerId, propertyId: req.params.propertyId, availableFrom: req.body.availableFrom ?? svc.clock.now().toISOString().slice(0, 10) });
  await svc.engine.drain();
  json(res, 202, { ok: true });
}, true);

route('POST', '/api/applications/:id/report', async (req, res, svc) => {
  svc.engine.emit('screening.completed', { applicationId: req.params.id, report: req.body });
  await svc.engine.drain();
  json(res, 200, { ok: true });
}, true);

route('GET', '/api/workflows', (_req, res, svc) => json(res, 200, svc.engine.workflows().map((w) => ({ name: w.name, title: w.title, description: w.description, trigger: 'event' in w.trigger ? { event: w.trigger.event } : 'schedule' in w.trigger ? { schedule: w.trigger.schedule } : { manual: true } }))), true);
route('GET', '/api/runs', (req, res, svc) => json(res, 200, svc.engine.runs((r) => r.ownerId === req.params.ownerId).map(({ steps: _s, ...r }) => r)), true);

/** Test tools (on unless NODE_ENV=production without DEV_TOOLS=true): pretend a text arrived. */
const devTools = () => process.env.NODE_ENV !== 'production' || process.env.DEV_TOOLS === 'true';
route('POST', '/api/dev/inbound', async (req, res, svc) => {
  if (!devTools()) return json(res, 404, { error: 'not found' });
  const since = svc.clock.now().toISOString();
  svc.engine.emit('message.received', { from: req.body.from, channel: req.body.channel ?? 'sms', body: req.body.body, media: req.body.media ?? [], ownerId: req.params.ownerId });
  await svc.engine.drain();
  json(res, 200, { sent: svc.store.list('messages', (m) => m.direction === 'out' && m.at >= since) });
}, true);

/** Test tools: fire a partner event that would normally come from a webhook. */
const DEV_EVENTS = ['identity.verified', 'screening.completed', 'showing.slot_chosen'];
route('POST', '/api/dev/event', async (req, res, svc) => {
  if (!devTools()) return json(res, 404, { error: 'not found' });
  if (!DEV_EVENTS.includes(req.body.event)) return json(res, 400, { error: `event must be one of ${DEV_EVENTS.join(', ')}` });
  svc.engine.emit(req.body.event, req.body.payload ?? {});
  await svc.engine.drain();
  json(res, 200, { ok: true });
}, true);

route('GET', '/play', (_req, res) => {
  if (!devTools()) return json(res, 404, { error: 'not found' });
  const f = join(ROOT, 'apps/play/index.html');
  html(res, 200, existsSync(f) ? readFileSync(f, 'utf8') : 'play page missing');
});

/* ======================= SERVER ======================= */

export function createApp(svc: Services) {
  return createServer(async (rq, res) => {
    const req = rq as Req;
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      const r = routes.find((x) => x.method === req.method && x.pattern.test(url.pathname));
      if (!r) return json(res, 404, { error: 'not found' });
      const m = url.pathname.match(r.pattern)!;
      req.params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      req.query = url.searchParams;
      req.raw = req.method === 'GET' ? '' : await readBody(req);
      const ct = String(req.headers['content-type'] ?? '');
      req.body = !req.raw ? {} : ct.includes('json') ? JSON.parse(req.raw) : ct.includes('urlencoded') ? Object.fromEntries(new URLSearchParams(req.raw)) : { text: req.raw };
      if (r.auth) {
        const ownerId = ownerOf(req, svc);
        if (!ownerId) return json(res, 401, { error: 'unauthorized' });
        req.params.ownerId = ownerId;
      }
      await r.h(req, res, svc);
    } catch (e) {
      console.error(e);
      if (!res.headersSent) json(res, 500, { error: 'server error' });
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const store = new MemoryStore({ file: process.env.DATA_FILE ?? join(ROOT, 'data/landwell.json') });
  const svc = createServices({ store, clock: new SystemClock(), logMessages: true });
  install(svc, { log: console.log });
  if (!store.list('owners').length && process.env.SEED_DEMO !== 'false') {
    const s = seed(store);
    const token = process.env.OWNER_API_TOKEN ?? 'dev-token';
    store.kvSet('tokens', token, s.owner.id);
    console.log(`Seeded demo owner ${s.owner.name}. API token: ${token}`);
  }
  setInterval(() => { svc.engine.tick(); void svc.engine.drain(); }, 30_000);
  svc.engine.tick();
  const port = Number(process.env.PORT ?? 8787);
  createApp(svc).listen(port, () => console.log(`${BRAND.name} API on http://localhost:${port}  (AI: ${svc.ai.name}, messaging: ${svc.adapters.messaging.name}, billing: ${process.env.STRIPE_SECRET_KEY ? "stripe" : "off"})`));
}
