// HTTP API + webhooks. No framework: node:http only.
//
//   Public:    GET /            marketing site
//              GET /apply/:id   application form      POST /api/public/apply/:id
//              GET /sign/:token lease signing page    POST /sign/:token
//   Webhooks:  POST /webhooks/twilio/sms   (texts in)
//              POST /webhooks/email        (Postmark inbound)
//              POST /webhooks/voice        (any voice agent: transcript in, reply out)
//              POST /webhooks/stripe       (KeyHelm's own subscription billing; never rent)
//              POST /webhooks/screening    (screening partner results)
//              POST /webhooks/identity     (ID verification results)
//   Owner API: /api/... signed in with the "kh_session" cookie (from /login), or
//              Authorization: Bearer <token> (kv "tokens" or OWNER_API_TOKEN). See ./owner-routes.ts.
//
// Run: npm start   (reads .env from the environment; see .env.example)

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { MemoryStore } from '../store/store.ts';
import { DATA_VERSION, freshStartIfOld } from '../store/data-version.ts';
import { SystemClock } from '../engine/clock.ts';
import { createServices, type Services } from '../services.ts';
import { install } from '../workflows/index.ts';
import { verifyStripeSignature, verifyTwilioSignature } from '../adapters/live.ts';
import { registerBillingRoutes } from './billing-routes.ts';
import { registerOwnerRoutes } from './owner-routes.ts';
import { sessionAuth, withoutSecrets, type AuthResult } from './auth.ts';
import type { SignRequest } from '../adapters/esign-native.ts';
import { addressKey, money } from '../workflows/lib.ts';
import { seed } from '../sim/seed.ts';
import { BRAND } from '../config/brand.ts';
import { BUSINESS } from '../config/business.ts';
import { RateLimiter, StaticCache, clientIp, limitsFromEnv, safeEqual, securityHeaders, tooMany } from './guard.ts';
import { POLICY_LINKS, accessibilityStatement, cookiePolicy, privacyPolicy, refundPolicy, termsOfService } from './legal.ts';
import type { TableName } from '../domain/types.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export type Req = IncomingMessage & { raw: string; body: any; params: Record<string, string>; query: URLSearchParams; auth?: { via: 'bearer' | 'session'; sessionId?: string } };
export type Handler = (req: Req, res: ServerResponse, svc: Services) => Promise<void> | void;
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
button{background:#1B4DFF;color:#fff;border:0;border-radius:10px;padding:14px 22px;font:700 16px system-ui;margin-top:16px;cursor:pointer}pre{white-space:pre-wrap;font:15px/1.6 Georgia,serif;max-height:60vh;overflow:auto;background:#FAFBFF;border:1px solid #D8E1F2;border-radius:12px;padding:18px}.muted{color:#4A5A78;font-size:14px}
.check{display:grid;grid-template-columns:auto 1fr;gap:10px;align-items:start;font-weight:400;font-size:14px;color:#4A5A78}.check input{width:20px;height:20px;min-height:0;margin:2px 0 0}:focus-visible{outline:3px solid #FFC83D;outline-offset:2px}
footer{max-width:720px;margin:0 auto;padding:0 20px 32px;font-size:14px;color:#4A5A78}footer a{color:#4A5A78;margin-right:16px}</style></head><body><main>${inner}</main>
<footer><nav aria-label="Policies">${POLICY_LINKS.map(([h, t]) => `<a href="${h}">${t}</a>`).join('')}</nav></footer></body></html>`;
}

async function readBody(req: IncomingMessage, max: number): Promise<string> {
  if (Number(req.headers['content-length'] ?? 0) > max) throw new Error('body too large');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) { size += (c as Buffer).length; if (size > max) throw new Error('body too large'); chunks.push(c as Buffer); }
  return Buffer.concat(chunks).toString('utf8');
}

/* ======================= PUBLIC ======================= */

const STARTED = new Date().toISOString();
route('GET', '/health', (_q, res, svc) => json(res, 200, {
  ok: true,
  brand: BRAND.name,
  // Which commit is live (Railway sets this), so a deploy can be checked from outside.
  commit: (process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.GIT_COMMIT ?? 'unknown').slice(0, 7),
  dataVersion: svc.store.kvGet<number>('meta', 'dataVersion') ?? null,
  ai: svc.ai.name,
  messaging: svc.adapters.messaging.name,
  startedAt: STARTED,
}));

/* Pages and files that are the same for everyone are built once and served from memory (see guard.ts). */
const STATIC = new StaticCache();
const DAY_S = 86_400, YEAR_S = 31_536_000;
export function loadStatic() {
  const f = join(ROOT, 'apps/site/index.html');
  const year = String(new Date().getUTCFullYear());
  const site = existsSync(f) ? readFileSync(f, 'utf8') : page(BRAND.name, `<h1>${BRAND.name}</h1><p>Run <code>npm run build:site</code> to build the marketing site.</p>`);
  const filled = site.replaceAll('{{BUSINESS_LEGAL_NAME}}', esc(BUSINESS.legalName)).replaceAll('{{BUSINESS_ADDRESS}}', esc(BUSINESS.address)).replaceAll('{{BUSINESS_EMAIL}}', esc(BUSINESS.email)).replaceAll('{{YEAR}}', year);
  STATIC.put('/', filled, 'text/html; charset=utf-8', 300);
  for (const [path, build] of [['/privacy', privacyPolicy], ['/terms', termsOfService], ['/cookies', cookiePolicy], ['/refunds', refundPolicy], ['/accessibility', accessibilityStatement]] as const) {
    STATIC.put(path, build(), 'text/html; charset=utf-8', 3600);
  }
  STATIC.put('/favicon.svg', FAVICON, 'image/svg+xml', DAY_S * 7);
  STATIC.put('/favicon.ico', FAVICON, 'image/svg+xml', DAY_S * 7);
  STATIC.put('/robots.txt', 'User-agent: *\nDisallow: /api/\nDisallow: /play\nDisallow: /admin\nDisallow: /sign/\nDisallow: /offer/\n', 'text/plain; charset=utf-8', DAY_S);
  for (const font of ['bricolage-grotesque-latin.woff2', 'figtree-latin.woff2']) {
    const p = join(ROOT, 'apps/site/fonts', font);
    if (existsSync(p)) STATIC.put(`/fonts/${font}`, readFileSync(p), 'font/woff2', YEAR_S);
  }
  for (const lic of ['OFL-Figtree.txt', 'OFL-BricolageGrotesque.txt']) {
    const p = join(ROOT, 'apps/site/fonts', lic);
    if (existsSync(p)) STATIC.put(`/fonts/${lic}`, readFileSync(p), 'text/plain; charset=utf-8', DAY_S);
  }
}
const FAVICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 34 34"><rect width="34" height="34" rx="8" fill="#1B4DFF"/><circle cx="24.5" cy="10" r="4" fill="#FFC83D"/><path d="M8 18.5 15.5 11.5 23 18.5M10.5 16.5V25h10v-8.5" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
loadStatic();

/** "Book a demo" goes straight to the scheduling page; nothing is collected on our side. */
route('GET', '/demo', (_q, res) => {
  const cal = process.env.CALENDLY_URL;
  if (cal) { res.writeHead(302, { location: cal }); res.end(); return; }
  html(res, 200, page(`${BRAND.name}: book a demo`, `<h1>Book a demo</h1><p>Email <a href="mailto:${esc(BUSINESS.email)}">${esc(BUSINESS.email)}</a> and we'll find a time.</p>`));
});

route('GET', '/apply/:propertyId', (req, res, svc) => {
  const p = svc.store.get('properties', req.params.propertyId);
  if (!p || !['listed', 'vacant'].includes(p.status)) return html(res, 404, page('Not available', '<h1>This home is not taking applications</h1>'));
  html(res, 200, page(`Apply: ${p.address}`, `<h1>Apply for ${esc(p.address)}</h1><p class="muted">${p.beds} bed · ${p.baths} bath · ${money(p.rent)}/month all-in. Every applicant is reviewed against the same written criteria, in the order received. After you submit, you'll get a link to complete screening with our screening partner.</p>
<form class="card" method="post" action="/api/public/apply/${p.id}"><label for="n">Full name</label><input id="n" name="name" required autocomplete="name"><label for="e">Email</label><input id="e" name="email" type="email" required autocomplete="email"><label for="ph">Mobile phone</label><input id="ph" name="phone" required autocomplete="tel">
<label class="check"><input type="checkbox" name="agree" value="yes" required><span>I agree to be contacted by text and email about this application and the home. Message frequency varies. Msg and data rates may apply. Reply STOP to opt out. See the <a href="/privacy">Privacy policy</a>.</span></label>
<button>Submit application</button><p class="muted">Equal Housing Opportunity.</p></form>`));
});

route('POST', '/api/public/apply/:propertyId', async (req, res, svc) => {
  const p = svc.store.get('properties', req.params.propertyId);
  if (!p) return json(res, 404, { error: 'not found' });
  const b = req.body;
  if (!b.name || !(b.email || b.phone)) return json(res, 400, { error: 'name and email or phone required' });
  if (b.agree !== 'yes' && b.agree !== true) return json(res, 400, { error: 'Please agree to be contacted about your application.' });
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

/** Too many messages from one phone number or email: drop quietly instead of paying for AI replies. */
function senderBlocked(from: string | undefined): boolean {
  if (!from) return false;
  const k = addressKey(String(from));
  if (LIMIT.sender.take(k) || LIMIT.senderDay.take(k)) { console.warn(`[limit] dropped message from ${k.slice(0, 6)}… (too many messages)`); return true; }
  return false;
}

route('POST', '/webhooks/twilio/sms', async (req, res, svc) => {
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (token) {
    const url = (svc.cfg.publicUrl.replace(/\/$/, '')) + req.url;
    if (!verifyTwilioSignature(token, url, req.body, String(req.headers['x-twilio-signature'] ?? ''))) return json(res, 403, { error: 'bad signature' });
  }
  const b = req.body as Record<string, string>;
  const media = Array.from({ length: Math.min(10, Number(b.NumMedia ?? 0)) }, (_x, i) => b[`MediaUrl${i}`]).filter(Boolean);
  if (senderBlocked(b.From)) { res.writeHead(200, { 'content-type': 'text/xml' }); res.end('<Response></Response>'); return; }
  svc.engine.emit('message.received', { from: b.From, to: b.To, channel: 'sms', body: b.Body ?? '', media, ownerId: ownerForLine(svc, b.To), providerMessageId: b.MessageSid });
  res.writeHead(200, { 'content-type': 'text/xml' });
  res.end('<Response></Response>'); // replies go out through the API, not TwiML
  void svc.engine.drain();
});

route('POST', '/webhooks/email', async (req, res, svc) => {
  if (process.env.EMAIL_WEBHOOK_SECRET && !safeEqual(req.query.get('key') ?? '', process.env.EMAIL_WEBHOOK_SECRET)) return json(res, 403, { error: 'bad key' });
  const b = req.body;
  const from = (b.FromFull?.Email ?? b.From ?? '').toString();
  if (senderBlocked(from)) return json(res, 200, { ok: true, dropped: true });
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
  if (process.env.VOICE_WEBHOOK_SECRET && !safeEqual(String(req.headers.authorization ?? ''), `Bearer ${process.env.VOICE_WEBHOOK_SECRET}`)) return json(res, 403, { error: 'unauthorized' });
  const b = req.body;
  if (senderBlocked(b.from)) return json(res, 429, { reply: "Sorry, I can't take more messages from this number right now. Please try again later." });
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
  if (senderBlocked(b.From)) return twiml(res, `<Say voice="${VOICE}">Sorry, I can't take more requests from this number right now. Please text or try again later. Goodbye.</Say>`);
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

// Stripe + Calendly webhooks, signup, offers and admin live in ./billing-routes.ts

route('POST', '/webhooks/screening', async (req, res, svc) => {
  if (process.env.SCREENING_WEBHOOK_SECRET && !safeEqual(String(req.headers.authorization ?? ''), `Bearer ${process.env.SCREENING_WEBHOOK_SECRET}`)) return json(res, 403, { error: 'unauthorized' });
  svc.engine.emit('screening.completed', { applicationId: req.body.applicationId, report: req.body.report });
  await svc.engine.drain();
  json(res, 200, { ok: true });
});

route('POST', '/webhooks/identity', async (req, res, svc) => {
  if (process.env.IDENTITY_WEBHOOK_SECRET && !safeEqual(String(req.headers.authorization ?? ''), `Bearer ${process.env.IDENTITY_WEBHOOK_SECRET}`)) return json(res, 403, { error: 'unauthorized' });
  if (req.body.status === 'verified') svc.engine.emit('identity.verified', { refId: req.body.refId });
  await svc.engine.drain();
  json(res, 200, { ok: true });
});

/* ======================= OWNER API ======================= */
// Owners sign in at /login (cookie "kh_session"; see ./auth.ts). API clients and /play can
// still use a bearer token: one per owner (kv "tokens"), or OWNER_API_TOKEN for the first owner.

function ownerOf(req: Req, svc: Services): AuthResult {
  const t = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  if (t) {
    const id = svc.store.kvGet<string>('tokens', t) ?? (process.env.OWNER_API_TOKEN && safeEqual(t, process.env.OWNER_API_TOKEN) ? svc.store.list('owners')[0]?.id : undefined);
    return id ? { ownerId: id, via: 'bearer' } : { status: 401, error: 'unauthorized', guess: true };
  }
  return sessionAuth(req, svc); // cookie sign-in; changes need the X-KeyHelm header (CSRF)
}
const mine = <K extends TableName>(svc: Services, table: K, ownerId: string) => svc.store.list(table, (r: any) => r.ownerId === ownerId);

route('GET', '/api/dashboard', (req, res, svc) => {
  const o = req.params.ownerId;
  const runs = svc.engine.runs((r) => r.ownerId === o && r.status === 'waiting');
  json(res, 200, {
    owner: withoutSecrets(svc.store.get('owners', o)),
    approvals: mine(svc, 'approvals', o).filter((a) => a.status === 'pending'),
    tasks: mine(svc, 'tasks', o).filter((t) => t.status === 'open'),
    properties: mine(svc, 'properties', o),
    openWorkOrders: mine(svc, 'workOrders', o).filter((w) => !['paid', 'cancelled'].includes(w.status)),
    openCharges: mine(svc, 'charges', o).filter((c) => c.status === 'open'),
    inProgress: runs.map((r) => ({ id: r.id, workflow: r.workflow, waitingFor: r.waitLabel, since: r.updatedAt })),
    activity: mine(svc, 'audit', o).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 50),
  });
}, true);

// Sign-in pages and the owner app's API (profile, rules, homes, tenants, vendors, leases, decisions,
// to-dos, rent, repairs, messages, activity) live in ./owner-routes.ts. Registered before the plain
// lists below, so its checked and filled-in versions answer first.
registerOwnerRoutes({ route, json, html });

for (const [path, table] of [['properties', 'properties'], ['tenants', 'tenants'], ['vendors', 'vendors'], ['leases', 'leases'], ['work-orders', 'workOrders'], ['charges', 'charges'], ['payments', 'payments'], ['expenses', 'expenses'], ['applications', 'applications'], ['showings', 'showings'], ['tasks', 'tasks'], ['messages', 'messages'], ['audit', 'audit']] as [string, TableName][]) {
  route('GET', `/api/${path}`, (req, res, svc) => json(res, 200, mine(svc, table, req.params.ownerId)), true);
}

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

registerBillingRoutes({ route, json, html, page, esc, mine });

/* ======================= SERVER ======================= */

/* ======================= LIMITS ======================= */
// Rate limits by IP, owner and sender. Values can be changed in Railway Variables (see guard.ts).
const L = limitsFromEnv();
export const LIMIT = {
  ip: new RateLimiter(L.ip), signup: new RateLimiter(L.signup), publicForm: new RateLimiter(L.publicForm),
  owner: new RateLimiter(L.owner), sender: new RateLimiter(L.sender), senderDay: new RateLimiter(L.senderDay), authFail: new RateLimiter(L.authFail),
};
/** Stricter per-IP limits for routes that create records, start checkouts or take form posts. */
function routeLimiter(method: string, path: string): RateLimiter | undefined {
  if (method !== 'POST') return undefined;
  if (path === '/api/public/signup' || path === '/api/billing/checkout') return LIMIT.signup;
  if (path.startsWith('/api/public/') || path.startsWith('/sign/')) return LIMIT.publicForm;
  return undefined;
}

export function createApp(svc: Services) {
  const server = createServer(async (rq, res) => {
    const req = rq as Req;
    securityHeaders(res);
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      const ip = clientIp(req);
      const isWebhook = url.pathname.startsWith('/webhooks/');
      // Webhooks come from a few provider IPs (Twilio, Stripe...), so they are limited per sender instead.
      if (!isWebhook) { const wait = LIMIT.ip.take(ip); if (wait) return tooMany(res, wait); }
      if ((req.method === 'GET' || req.method === 'HEAD') && STATIC.serve(req, res, url.pathname)) return;
      const r = routes.find((x) => x.method === req.method && x.pattern.test(url.pathname));
      if (!r) return json(res, 404, { error: 'not found' });
      const strict = routeLimiter(req.method!, url.pathname);
      if (strict) { const wait = strict.take(ip); if (wait) return tooMany(res, wait); }
      const m = url.pathname.match(r.pattern)!;
      req.params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      req.query = url.searchParams;
      if (r.auth) {
        if (LIMIT.authFail.blocked(ip)) return tooMany(res, 60, 'Too many failed sign-in attempts');
        const who = ownerOf(req, svc);
        if (who.setCookie) res.setHeader('set-cookie', who.setCookie);
        if (!('ownerId' in who)) { if (who.guess) LIMIT.authFail.take(ip); return json(res, who.status, { error: who.error }); }
        const wait = LIMIT.owner.take(who.ownerId);
        if (wait) return tooMany(res, wait);
        req.params.ownerId = who.ownerId;
        req.auth = { via: who.via, sessionId: who.sessionId };
      }
      // Signed-in owners may upload lease templates; everything else is small.
      req.raw = req.method === 'GET' ? '' : await readBody(req, r.auth ? 2_000_000 : 256_000);
      const ct = String(req.headers['content-type'] ?? '');
      try {
        req.body = !req.raw ? {} : ct.includes('json') ? JSON.parse(req.raw) : ct.includes('urlencoded') ? Object.fromEntries(new URLSearchParams(req.raw)) : { text: req.raw };
      } catch { return json(res, 400, { error: 'invalid request body' }); }
      await r.h(req, res, svc);
    } catch (e) {
      if ((e as Error).message === 'body too large') return json(res, 413, { error: 'request too large' });
      console.error(e);
      if (!res.headersSent) json(res, 500, { error: 'server error' });
    }
  });
  // Slow or stuck clients can't hold connections open: whole request 30s, headers 15s.
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 65_000;
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dataFile = process.env.DATA_FILE ?? join(ROOT, 'data/keyhelm.json');
  const setAside = freshStartIfOld(dataFile);
  if (setAside) console.log(`Fresh start (data version ${DATA_VERSION}): old data moved to ${setAside}`);
  const store = new MemoryStore({ file: dataFile });
  store.kvSet('meta', 'dataVersion', DATA_VERSION);
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
  const server = createApp(svc).listen(port, () => console.log(`${BRAND.name} API on http://localhost:${port}  (AI: ${svc.ai.name}, messaging: ${svc.adapters.messaging.name}, billing: ${process.env.STRIPE_SECRET_KEY ? "stripe" : "off"})`));
  // Railway sends SIGTERM when a new deploy replaces this one; exit cleanly so it isn't marked Crashed.
  const stop = () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5_000).unref(); };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
