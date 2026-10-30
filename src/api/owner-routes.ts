// Owner sign-in and the owner app's API. Full contract: docs/notes/owner-api.md.
//
//   Pages:  GET /login · POST /login · POST /logout · GET+POST /login/link/:token · GET+POST /forgot
//   App:    GET /app (and /app/rent, /app/messages/<key>...) · GET /app/manifest.webmanifest · GET /app/icon.svg
//   Admin:  POST /api/admin/owners/:id/login-link   (Authorization: Bearer <ADMIN_API_TOKEN>)
//   Owner (cookie "kh_session" + X-KeyHelm: 1 on changes, or Authorization: Bearer <token>):
//     GET/PATCH /api/me · POST /api/me/password · GET/PUT /api/rules
//     GET/POST /api/properties · PATCH/DELETE /api/properties/:id
//     GET/POST /api/tenants · PATCH /api/tenants/:id · POST /api/tenants/:id/former
//     GET/POST /api/vendors · PATCH/DELETE /api/vendors/:id · GET/POST /api/lease-templates
//     GET /api/approvals · POST /api/approvals/:id · GET /api/tasks · POST /api/tasks/:id/done
//     GET /api/charges · POST /api/charges/:id/received · GET/POST /api/work-orders
//     GET /api/messages/threads · GET /api/messages/threads/:key · POST /api/messages/send · GET /api/activity
//
// Every owner route is scoped to the signed-in owner: anything else is a 404. Bad input is a
// 400 with a plain message ({ error, field }). Money: requests in dollars, responses in cents.

import type { ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Req, Handler } from './server.ts';
import type { Services } from '../services.ts';
import type { Charge, Lease, Owner, Property, Tenant, Vendor, WorkOrder } from '../domain/types.ts';
import { BUSINESS } from '../config/business.ts';
import { BRAND } from '../config/brand.ts';
import { CO } from '../config/colorado.ts';
import { prepareTemplate } from '../leases/template.ts';
import { termLabel } from '../billing/offers.ts';
import { addressKey, firstName, money, optedOut } from '../workflows/lib.ts';
import { RateLimiter, StaticCache, clientIp, safeEqual } from './guard.ts';
import {
  LINK_TTL_MS, LOGIN_LIMIT, MAX_PASSWORD, RESET_TTL_MS, clearedCookie, consumeLoginLink, createSession, currentSession, emailConfigured,
  hashPassword, issueLoginLink, passwordProblem, peekLoginLink, revokeAllSessions, revokeLoginLinks, revokeSession, safeNext, sameOrigin, verifyPassword,
  ROLE_NAMES, getMember, issueMfaTicket, memberByEmail, memberView, membersOf, redeemMfaTicket, saveMember, sessionsOf, type Member, type Role, type SessionRec,
} from './auth.ts';
import { newTotpSecret, otpauthUri, verifyTotp } from './totp.ts';
import { entitlementsOf } from '../billing/entitlements.ts';
import {
  Invalid, approvalView, body, bool, calendlyUrlFor, checkDecision, checklist, conflict, contactFor, defaultRules, dollars, email, ensureRules, fail,
  facts, int, isObj, links, notFound, oneOf, phone, planId, planName, rooms, rulesPatch, rulesSaved, stepOfTask, syncSetupTasks, text,
  threadMessages, threads, trades, ymd,
} from './owner-data.ts';
import {
  appPlaceholderPage, blockedPage, checkoutEmailPage, checkoutWaitingPage, codePage, forgotPage, forgotSentPage, linkInvalidPage, loginPage, setPasswordPage,
} from './owner-pages.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DAY_MS = 86_400_000;

export interface OwnerKit {
  route: (method: string, path: string, h: Handler, auth?: boolean) => void;
  json: (res: ServerResponse, code: number, data: unknown) => void;
  html: (res: ServerResponse, code: number, body: string) => void;
}

/* ---------------- small helpers ---------------- */

/** Our own pages have no scripts, so they get a strict Content-Security-Policy. */
const CSP = "default-src 'self'; script-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; font-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
const sendHtml = (res: ServerResponse, code: number, page: string, o: { csp?: boolean } = {}) => {
  res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...(o.csp === false ? {} : { 'content-security-policy': CSP }) });
  res.end(page);
};
const redirect = (res: ServerResponse, location: string, code = 303) => { res.writeHead(code, { location, 'cache-control': 'no-store' }); res.end(); };
const wantsJson = (req: Req) => String(req.headers['content-type'] ?? '').includes('json') || !!req.headers['x-keyhelm'] || /application\/json/.test(String(req.headers.accept ?? ''));
const mins = (sec: number) => (sec < 90 ? `${sec} seconds` : `${Math.ceil(sec / 60)} minutes`);
const nowIso = (svc: Services) => svc.clock.now().toISOString();
const sameEmail = (a: string | undefined, b: string) => (a ?? '').trim().toLowerCase() === b;
const ownedBy = <T extends { ownerId: string }>(r: T | undefined, ownerId: string): T => (r && r.ownerId === ownerId ? r : notFound());

/** Owner sends per hour (texts and emails the owner writes in the app). */
const SEND_LIMIT = { owner: new RateLimiter({ capacity: Number(process.env.RL_OWNER_SEND_PER_HOUR) > 0 ? Number(process.env.RL_OWNER_SEND_PER_HOUR) : 60, perMs: 3_600_000 }) };

function isAdmin(req: Req): boolean {
  const want = process.env.ADMIN_API_TOKEN;
  const got = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  return !!want && !!got && safeEqual(got, want);
}

/** JSON route that turns bad input into a 400/404/409 with a plain message, and saves changes. */
function api(kit: OwnerKit, fn: (req: Req, res: ServerResponse, svc: Services, ownerId: string) => Promise<void> | void): Handler {
  return async (req, res, svc) => {
    try {
      await fn(req, res, svc, req.params.ownerId);
      if (req.method !== 'GET') svc.store.flush();
    } catch (e) {
      if (e instanceof Invalid) return kit.json(res, e.status, e.field ? { error: e.message, field: e.field } : { error: e.message });
      throw e;
    }
  };
}

/** Start a session, set the cookie, remember the sign-in. */
function signIn(req: Req, res: ServerResponse, svc: Services, ownerId: string, memberId?: string): void {
  const s = createSession(svc, ownerId, { ip: clientIp(req), ua: String(req.headers['user-agent'] ?? ''), memberId });
  res.setHeader('set-cookie', s.cookie);
  const m = getMember(svc, memberId);
  if (m) saveMember(svc, { ...m, lastLoginAt: nowIso(svc) });
  else svc.store.update('owners', ownerId, { lastLoginAt: nowIso(svc) });
  ensureRules(svc, ownerId); // workflows read the owner's rules, so a new owner starts with safe defaults
  svc.store.flush();
}

/* ======================= the owner app (apps/owner) ======================= */

const APP_DIR = join(ROOT, 'apps/owner');
/** The app's screens. /app/<tab> and /app/messages/<key> open the same page on that screen. */
export const APP_TABS = ['today', 'rent', 'repairs', 'messages', 'leasing', 'homes', 'calendar', 'documents', 'books', 'settings', 'lab'] as const;
let appCache: { mtimeMs: number; html: string } | undefined;

/** apps/owner/index.html from memory (read again when the file changes), or undefined when it doesn't exist. */
function appHtml(): string | undefined {
  const f = join(APP_DIR, 'index.html');
  let mtimeMs: number;
  try { mtimeMs = statSync(f).mtimeMs; } catch { return undefined; }
  if (appCache?.mtimeMs !== mtimeMs) appCache = { mtimeMs, html: readFileSync(f, 'utf8') };
  return appCache.html;
}

/**
 * The app page's Content-Security-Policy: only its own inline script and style run (a fresh nonce on every
 * response), data comes only from this site, nothing can frame it, and Trusted Types blocks HTML string sinks
 * (the app builds every element with DOM calls, so server data is never parsed as HTML). The one frame it
 * shows is a state document, served from this site as its own script-free page.
 */
export function appCsp(nonce: string): string {
  return [
    "default-src 'none'", `script-src 'nonce-${nonce}'`, `style-src 'nonce-${nonce}'`, "img-src 'self' data:", "font-src 'self'",
    "connect-src 'self'", "frame-src 'self'", "manifest-src 'self'", "form-action 'self'", "frame-ancestors 'none'", "base-uri 'none'", "object-src 'none'",
    "require-trusted-types-for 'script'",
  ].join('; ');
}

function sendApp(res: ServerResponse, page: string): void {
  const nonce = randomBytes(18).toString('base64');
  const body = page.replace(/<(script|style)(?=[\s>])/gi, `<$1 nonce="${nonce}"`);
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': appCsp(nonce) });
  res.end(body);
}

/** The install manifest and icon: the same for everyone, so public, cached and served from memory. */
const APP_FILES = new StaticCache();
const APP_STATIC: [path: string, file: string, type: string, maxAge: number][] = [
  ['/app/manifest.webmanifest', 'manifest.webmanifest', 'application/manifest+json', 86_400],
  ['/app/icon.svg', 'icon.svg', 'image/svg+xml', 7 * 86_400],
  ['/app/icon-192.png', 'icon-192.png', 'image/png', 7 * 86_400],
  ['/app/icon-512.png', 'icon-512.png', 'image/png', 7 * 86_400],
  // iPhones use this for "Add to Home Screen" (they ignore SVG icons); also asked for at the root.
  ['/app/apple-touch-icon.png', 'apple-touch-icon.png', 'image/png', 7 * 86_400],
  ['/apple-touch-icon.png', 'apple-touch-icon.png', 'image/png', 7 * 86_400],
];
function loadAppFiles(): void {
  for (const [path, file, type, maxAge] of APP_STATIC) {
    const f = join(APP_DIR, file);
    if (existsSync(f)) APP_FILES.put(path, readFileSync(f), type, maxAge);
  }
}

/* ======================= after checkout ======================= */

/** Asks Stripe whether this checkout is paid (for when the browser beats the webhook here). */
async function stripeCheckoutPaid(sessionId: string, ownerId: string): Promise<boolean> {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key || !/^cs_[A-Za-z0-9_]{6,200}$/.test(sessionId)) return false;
  try {
    const r = await fetch(`https://api.stripe.com/v1/checkout/sessions/${sessionId}`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(5000) });
    if (!r.ok) return false;
    const s: any = await r.json();
    return s?.mode === 'subscription' && s.status === 'complete' && (s.payment_status === 'paid' || s.payment_status === 'no_payment_required') && (s.client_reference_id === ownerId || s.metadata?.owner_id === ownerId);
  } catch {
    return false;
  }
}

/**
 * GET /billing/done for an owner found by their paid checkout session.
 *  - Already has a password → the app (which asks them to sign in if needed).
 *  - Payment not confirmed yet → a page that refreshes itself for about a minute.
 *  - New account → a fresh one-time setup link: set a password, land in /app.
 *  - Account that already has homes or tenants (or an old checkout) → the link goes to the email on file instead,
 *    so a checkout URL alone can never open an account with someone's data in it.
 */
export async function checkoutDone(req: Req, res: ServerResponse, svc: Services, owner: Owner, sessionId: string): Promise<void> {
  if (owner.passwordHash) return redirect(res, '/app');
  const paid = owner.billing?.status === 'active' || await stripeCheckoutPaid(sessionId, owner.id);
  if (!paid) {
    const n = Math.max(0, Math.min(99, Number(req.query?.get('n')) || 0));
    return sendHtml(res, 200, checkoutWaitingPage(n < 20 ? `/billing/done?session=${encodeURIComponent(sessionId)}&n=${n + 1}` : undefined));
  }
  const has = (t: 'properties' | 'tenants' | 'vendors' | 'leaseTemplates') => svc.store.find(t, (r: { ownerId: string }) => r.ownerId === owner.id);
  const started = Date.parse(owner.billing?.startedAt ?? nowIso(svc));
  const fresh = svc.clock.now().getTime() - started < 14 * DAY_MS && !has('properties') && !has('tenants') && !has('vendors') && !has('leaseTemplates');
  if (fresh) {
    const link = issueLoginLink(svc, owner.id, { purpose: 'setup', via: 'checkout' });
    svc.engine.audit({ ownerId: owner.id, actor: 'system', action: 'owner.setup_link', detail: 'Sign-in setup link created after checkout.' });
    return redirect(res, link.path);
  }
  const works = emailConfigured();
  if (works) {
    const link = issueLoginLink(svc, owner.id, { purpose: 'setup', via: 'checkout' });
    void sendLinkEmail(svc, owner, link.url, 'setup').catch((e) => console.error('[auth] setup email failed:', (e as Error).message));
  }
  sendHtml(res, 200, checkoutEmailPage(works, owner.email));
}

async function sendLinkEmail(svc: Services, owner: Owner, url: string, purpose: 'setup' | 'reset'): Promise<void> {
  const first = firstName(owner.name);
  const body = purpose === 'reset'
    ? `Hi ${first},\n\nUse this link to choose a new ${BRAND.name} password. It works once, for 1 hour:\n${url}\n\nIf you didn't ask for this, you can ignore this email. Your password stays the same.\n\n${BRAND.name}`
    : `Hi ${first},\n\nUse this link to create your ${BRAND.name} password and open your account. It works once:\n${url}\n\nQuestions? Reply to this email.\n\n${BRAND.name}`;
  // Not saved to the message history: the link is a key to the account.
  await svc.adapters.messaging.send({ channel: 'email', to: owner.email, subject: purpose === 'reset' ? `Reset your ${BRAND.name} password` : `Set up your ${BRAND.name} sign-in`, body });
}

async function sendMemberEmail(svc: Services, m: Member, url: string, purpose: 'invite' | 'reset'): Promise<void> {
  const owner = svc.store.get('owners', m.ownerId);
  const first = firstName(m.name);
  const body = purpose === 'reset'
    ? `Hi ${first},\n\nUse this link to choose a new ${BRAND.name} password. It works once, for 1 hour:\n${url}\n\nIf you didn't ask for this, you can ignore this email.\n\n${BRAND.name}`
    : `Hi ${first},\n\n${owner?.name ?? 'The owner'} added you to their ${BRAND.name} account (${ROLE_NAMES[m.role]}). Use this link to create your password. It works once, for 7 days:\n${url}\n\n${BRAND.name}`;
  await svc.adapters.messaging.send({ channel: 'email', to: m.email, subject: purpose === 'reset' ? `Reset your ${BRAND.name} password` : `You're invited to ${owner?.name ?? 'a'} ${BRAND.name} account`, body });
}

/** Who is signed in, for /api/me: the owner, or a team member and their role. */
function meWho(svc: Services, o: Owner, auth: Req['auth']) {
  const m = getMember(svc, auth?.memberId);
  return m ? { kind: 'member' as const, ...memberView(m) } : { kind: 'owner' as const, name: o.name, email: o.email, role: 'owner' as const, roleName: 'Owner', twoStep: !!o.totpSecret };
}

/** A device in "where you're signed in". Only part of the IP address is shown. */
function sessionView(s: SessionRec, currentId?: string) {
  const ua = s.ua ?? '';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /Firefox\//.test(ua) ? 'Firefox' : 'A browser';
  const device = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : 'a computer';
  return { id: s.id.slice(0, 16), device: `${browser} on ${device}`, ip: s.ip ? s.ip.replace(/(\d+\.\d+)\.\d+\.\d+$/, '$1.x.x') : null, createdAt: s.createdAt, lastSeenAt: s.lastSeenAt, current: s.id === currentId };
}

/* ======================= views ======================= */

function meView(svc: Services, o: Owner, via: string) {
  const s = svc.store;
  const b = o.billing;
  return {
    owner: {
      id: o.id, name: o.name, email: o.email, phone: o.phone, timezone: o.timezone, lineNumber: o.lineNumber ?? null, lineEmail: o.lineEmail ?? null,
      smsConsent: o.consents?.smsConsent ?? null, hasPassword: !!o.passwordHash, lastLoginAt: o.lastLoginAt ?? null, createdAt: o.createdAt,
    },
    plan: { id: planId(o.plan), name: planName(o.plan) },
    billing: b ? {
      status: b.status, plan: planId(b.plan ?? o.plan), planName: planName(b.plan ?? o.plan), term: b.term ?? null, termLabel: b.term ? termLabel(b.term) : null,
      doors: b.doors ?? null, startedAt: b.startedAt ?? null, contractEndsAt: b.contractEndsAt ?? null, canceledAt: b.canceledAt ?? null,
    } : null,
    onboarding: { status: o.onboarding?.status ?? null, startTime: o.onboarding?.startTime ?? null, calendlyUrl: calendlyUrlFor(o), ...checklist(s, o.id) },
    counts: {
      homes: s.list('properties', (x) => x.ownerId === o.id).length,
      tenants: s.list('tenants', (x) => x.ownerId === o.id && x.status !== 'former').length,
      vendors: s.list('vendors', (x) => x.ownerId === o.id).length,
      pendingApprovals: s.list('approvals', (x) => x.ownerId === o.id && x.status === 'pending').length,
      openTasks: s.list('tasks', (x) => x.ownerId === o.id && x.status === 'open').length,
      openWorkOrders: s.list('workOrders', (x) => x.ownerId === o.id && !['paid', 'cancelled'].includes(x.status)).length,
    },
    signedInWith: via,
    support: { email: BUSINESS.email },
  };
}

const LIVE_LEASE: Lease['status'][] = ['active', 'out_for_signature', 'draft'];
function propertyView(svc: Services, p: Property) {
  const tenants = svc.store.list('tenants', (t) => t.propertyId === p.id && t.ownerId === p.ownerId && t.status !== 'former');
  const lease = svc.store.find('leases', (l) => l.propertyId === p.id && l.status === 'active');
  const busy = !!svc.store.find('leases', (l) => l.propertyId === p.id && LIVE_LEASE.includes(l.status));
  return {
    ...p, tenants: tenants.map((t) => ({ id: t.id, name: t.name, status: t.status })),
    lease: lease ? { id: lease.id, startDate: lease.startDate, endDate: lease.endDate, rent: lease.rent, deposit: lease.deposit, tenantIds: lease.tenantIds } : null,
    canDelete: !busy && !tenants.length,
  };
}

function tenantView(svc: Services, t: Tenant) {
  const lease = svc.store.find('leases', (l) => l.tenantIds.includes(t.id) && l.status === 'active');
  return {
    ...t, propertyAddress: svc.store.get('properties', t.propertyId)?.address ?? null,
    lease: lease ? { id: lease.id, startDate: lease.startDate, endDate: lease.endDate, rent: lease.rent, deposit: lease.deposit } : null,
    textsOff: !!t.phone && optedOut(svc.store, t.phone, 'sms'),
  };
}

const CLOSED_WO: WorkOrder['status'][] = ['paid', 'cancelled'];
function workOrderView(svc: Services, w: WorkOrder) {
  const v = w.vendorId ? svc.store.get('vendors', w.vendorId) : undefined;
  return {
    ...w, open: !CLOSED_WO.includes(w.status), vendorName: v?.name ?? null, vendorPhone: v?.phone ?? null,
    propertyAddress: svc.store.get('properties', w.propertyId)?.address ?? null, tenantName: w.tenantId ? svc.store.get('tenants', w.tenantId)?.name ?? null : null,
  };
}

const KIND_LABEL: Record<Charge['kind'], string> = { rent: 'Rent', late_fee: 'Late fee', deposit: 'Deposit', other: 'Charge' };
function chargeView(svc: Services, c: Charge) {
  const lease = svc.store.get('leases', c.leaseId);
  const tenants = (lease?.tenantIds ?? []).map((id) => svc.store.get('tenants', id)?.name).filter(Boolean);
  const month = c.period ? new Date(c.period + '-15T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', year: 'numeric' }) : '';
  return {
    ...c, balance: c.amount - c.paid, label: `${KIND_LABEL[c.kind]}${month ? ` for ${month}` : ''}`,
    propertyId: lease?.propertyId ?? null, propertyAddress: lease ? svc.store.get('properties', lease.propertyId)?.address ?? null : null, tenantNames: tenants,
  };
}

function rulesView(svc: Services, ownerId: string) {
  const r = svc.store.get('rules', ownerId) ?? defaultRules(ownerId);
  return {
    ...r, saved: rulesSaved(svc.store, ownerId), savedAt: svc.store.kvGet<string>('rulesSaved', ownerId) ?? null,
    coloradoLateFee: { minDaysLate: CO.lateFee.minDaysLate, flatCapCents: CO.lateFee.flatCapCents, percentCap: CO.lateFee.percentCap },
  };
}

const status = <T extends string>(req: Req, allowed: readonly T[]) => {
  const s = req.query.get('status');
  if (!s || s === 'all') return undefined;
  if (!allowed.includes(s as T)) fail(`status should be one of: all, ${allowed.join(', ')}.`, 'status');
  return s as T;
};

/* ======================= routes ======================= */

export function registerOwnerRoutes(kit: OwnerKit) {
  const { route, json } = kit;
  const r = (method: string, path: string, fn: Parameters<typeof api>[1]) => route(method, path, api(kit, fn), true);

  /* ---------------- sign in ---------------- */
  route('GET', '/login', (req, res, svc) => {
    const next = safeNext(req.query.get('next'));
    const cur = currentSession(req, svc);
    if (cur && cur !== 'invalid') return redirect(res, next);
    if (cur === 'invalid') res.setHeader('set-cookie', clearedCookie(svc));
    sendHtml(res, 200, loginPage({ next, notice: req.query.get('signed_out') ? "You're signed out. See you soon." : undefined }));
  });

  route('POST', '/login', async (req, res, svc) => {
    const b = isObj(req.body) ? req.body : {};
    const asJson = wantsJson(req);
    const emailIn = String(b.email ?? '').trim().toLowerCase().slice(0, 254);
    const next = safeNext(b.next);
    const reply = (code: number, error: string) => (asJson ? json(res, code, { error }) : sendHtml(res, code, loginPage({ email: emailIn, next, error })));
    if (!sameOrigin(req, svc)) return reply(403, 'This sign-in came from another website, so it was blocked.');
    const wait = LOGIN_LIMIT.ip.take(clientIp(req)) || (emailIn ? LOGIN_LIMIT.email.take(emailIn) : 0);
    if (wait) { res.setHeader('retry-after', String(wait)); return reply(429, `Too many sign-in attempts. Please wait ${mins(wait)} and try again, or reset your password.`); }
    const owner = emailIn ? svc.store.find('owners', (o) => sameEmail(o.email, emailIn)) : undefined;
    const member = !owner && emailIn ? memberByEmail(svc, emailIn) : undefined;
    const rec = owner ?? (member?.status === 'active' ? member : undefined);
    // Always run the full password check, so a wrong email takes as long as a wrong password.
    const ok = await verifyPassword(String(b.password ?? '').slice(0, MAX_PASSWORD + 1), rec?.passwordHash);
    if (!ok || !rec) return reply(401, "That email and password don't match. Try again, or reset your password.");
    const ownerId = owner ? owner.id : member!.ownerId;
    if (rec.totpSecret) return askForCode(res, svc, asJson, { ownerId, memberId: member?.id }, next);
    signIn(req, res, svc, ownerId, member?.id);
    asJson ? json(res, 200, { ok: true, next }) : redirect(res, next);
  });

  /* Two-step sign-in: the password step handed out a ticket; a good code trades it for a session. */
  function askForCode(res: ServerResponse, svc: Services, asJson: boolean, who: { ownerId: string; memberId?: string }, next: string) {
    const ticket = issueMfaTicket(svc, who, next);
    asJson ? json(res, 200, { needsCode: true, ticket }) : sendHtml(res, 200, codePage({ ticket }));
  }

  route('POST', '/login/code', (req, res, svc) => {
    const b = isObj(req.body) ? req.body : {};
    const asJson = wantsJson(req);
    const ticket = String(b.ticket ?? '');
    const reply = (code: number, error: string, again = true) => (asJson ? json(res, code, { error, again }) : sendHtml(res, code, again ? codePage({ ticket, error }) : loginPage({ error })));
    if (!sameOrigin(req, svc)) return reply(403, 'This sign-in came from another website, so it was blocked.', false);
    const wait = LOGIN_LIMIT.ip.take(clientIp(req));
    if (wait) { res.setHeader('retry-after', String(wait)); return reply(429, `Too many tries. Please wait ${mins(wait)} and try again.`); }
    const out = redeemMfaTicket(svc, ticket, b.code);
    if (out.result !== 'ok') {
      return out.result === 'expired'
        ? reply(401, 'That took too long or had too many tries. Please sign in again.', false)
        : reply(401, "That code didn't work. Check your authenticator app and try the newest code.");
    }
    signIn(req, res, svc, out.ticket.ownerId, out.ticket.memberId);
    asJson ? json(res, 200, { ok: true, next: out.ticket.next }) : redirect(res, out.ticket.next);
  });

  route('POST', '/logout', (req, res, svc) => {
    const asJson = wantsJson(req);
    if (!sameOrigin(req, svc)) return asJson ? json(res, 403, { error: 'This request came from another website, so it was blocked.' }) : sendHtml(res, 403, blockedPage('This request came from another website, so it was blocked.'));
    const cur = currentSession(req, svc);
    const all = req.query.get('all') === '1' || (isObj(req.body) && [true, 'true', '1', 'yes', 'on'].includes(req.body.all as never));
    if (cur && cur !== 'invalid') { if (all) revokeAllSessions(svc, cur.session.ownerId); else revokeSession(svc, cur.token); }
    res.setHeader('set-cookie', clearedCookie(svc));
    asJson ? json(res, 200, { ok: true }) : redirect(res, '/login?signed_out=1');
  });

  /* One-time links: set a password (after checkout, from admin, or "forgot password"). Used up only on POST, so link scanners can't burn them.
     Referrer-Policy same-origin: the token in the URL never goes to another site, and the browser still sends this site's
     Origin on the password form (with no-referrer, browsers send "Origin: null" and the same-site check refuses it). */
  route('GET', '/login/link/:token', (req, res, svc) => {
    res.setHeader('referrer-policy', 'same-origin');
    const rec = peekLoginLink(svc, req.params.token);
    if (!rec) return sendHtml(res, 410, linkInvalidPage());
    const owner = svc.store.get('owners', rec.ownerId)!;
    const member = getMember(svc, rec.memberId);
    sendHtml(res, 200, setPasswordPage({ email: member?.email ?? owner.email, purpose: rec.purpose, action: `/login/link/${req.params.token}`, ownerName: owner.name }));
  });

  route('POST', '/login/link/:token', async (req, res, svc) => {
    res.setHeader('referrer-policy', 'same-origin');
    const asJson = wantsJson(req);
    const b = isObj(req.body) ? req.body : {};
    const rec = peekLoginLink(svc, req.params.token);
    if (!sameOrigin(req, svc)) return asJson ? json(res, 403, { error: 'This request came from another website, so it was blocked.' }) : sendHtml(res, 403, blockedPage('This request came from another website, so it was blocked.'));
    const wait = LOGIN_LIMIT.ip.take(clientIp(req));
    if (wait) return asJson ? json(res, 429, { error: `Too many attempts. Please wait ${mins(wait)}.` }) : sendHtml(res, 429, blockedPage(`Too many attempts. Please wait ${mins(wait)} and try again.`));
    if (!rec) return asJson ? json(res, 410, { error: 'This link has expired or was already used. Ask for a new one.' }) : sendHtml(res, 410, linkInvalidPage());
    const owner = svc.store.get('owners', rec.ownerId)!;
    const member = getMember(svc, rec.memberId);
    const who = member ?? owner;
    const pw = typeof b.password === 'string' ? b.password : '';
    const problem = passwordProblem(pw, who.email) ?? (b.confirm !== undefined && b.confirm !== pw ? "The two passwords don't match. Please type them again." : undefined);
    if (problem) return asJson ? json(res, 400, { error: problem, field: 'password' }) : sendHtml(res, 400, setPasswordPage({ email: who.email, purpose: rec.purpose, action: `/login/link/${req.params.token}`, error: problem, ownerName: owner.name }));
    if (!consumeLoginLink(svc, req.params.token)) return asJson ? json(res, 410, { error: 'This link has expired or was already used. Ask for a new one.' }) : sendHtml(res, 410, linkInvalidPage());
    const now = nowIso(svc);
    const hash = await hashPassword(pw);
    if (member) {
      saveMember(svc, { ...member, passwordHash: hash, passwordSetAt: now, status: 'active' });
      revokeAllSessions(svc, owner.id, undefined, { memberId: member.id });
      revokeLoginLinks(svc, owner.id, member.id);
      svc.engine.audit({ ownerId: owner.id, actor: 'owner', action: member.passwordHash ? 'team.password_reset' : 'team.joined', detail: member.passwordHash ? `${member.name} changed their password with a one-time link.` : `${member.name} joined your team (${ROLE_NAMES[member.role]}).` });
    } else {
      svc.store.update('owners', owner.id, { passwordHash: hash, passwordSetAt: now });
      revokeAllSessions(svc, owner.id, undefined, { memberId: null });
      revokeLoginLinks(svc, owner.id, null);
      svc.engine.audit({ ownerId: owner.id, actor: 'owner', action: owner.passwordHash ? 'owner.password_reset' : 'owner.password_set', detail: owner.passwordHash ? 'Password changed with a one-time link. Other devices were signed out.' : 'Password created.' });
    }
    // A reset link proves the email, not the phone: two-step sign-in still asks for the code.
    if (who.totpSecret) return askForCode(res, svc, asJson, { ownerId: owner.id, memberId: member?.id }, '/app');
    signIn(req, res, svc, owner.id, member?.id);
    asJson ? json(res, 200, { ok: true, next: '/app' }) : redirect(res, '/app');
  });

  route('GET', '/forgot', (_req, res) => sendHtml(res, 200, forgotPage()));

  route('POST', '/forgot', async (req, res, svc) => {
    const asJson = wantsJson(req);
    const b = isObj(req.body) ? req.body : {};
    const emailIn = String(b.email ?? '').trim().toLowerCase().slice(0, 254);
    if (!sameOrigin(req, svc)) return asJson ? json(res, 403, { error: 'This request came from another website, so it was blocked.' }) : sendHtml(res, 403, blockedPage('This request came from another website, so it was blocked.'));
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(emailIn)) return asJson ? json(res, 400, { error: 'Please enter the email on your account.', field: 'email' }) : sendHtml(res, 400, forgotPage({ email: emailIn, error: 'Please enter the email on your account.' }));
    const wait = LOGIN_LIMIT.ip.take(clientIp(req)) || LOGIN_LIMIT.email.take(emailIn);
    if (wait) return asJson ? json(res, 429, { error: `Too many requests. Please wait ${mins(wait)} and try again.` }) : sendHtml(res, 429, blockedPage(`Too many requests. Please wait ${mins(wait)} and try again.`));
    const works = emailConfigured();
    const owner = works ? svc.store.find('owners', (o) => sameEmail(o.email, emailIn)) : undefined;
    const member = works && !owner ? memberByEmail(svc, emailIn) : undefined;
    if (member && member.status === 'active') {
      const link = issueLoginLink(svc, member.ownerId, { purpose: 'reset', via: 'forgot', ttlMs: RESET_TTL_MS, memberId: member.id });
      void sendMemberEmail(svc, member, link.url, 'reset').catch((e) => console.error('[auth] reset email failed:', (e as Error).message));
    }
    if (owner) {
      const link = issueLoginLink(svc, owner.id, { purpose: owner.passwordHash ? 'reset' : 'setup', via: 'forgot', ttlMs: RESET_TTL_MS });
      svc.engine.audit({ ownerId: owner.id, actor: 'owner', action: 'owner.reset_requested', detail: 'A password reset link was emailed.' });
      // Not awaited: the answer must take the same time whether or not the email has an account.
      void sendLinkEmail(svc, owner, link.url, 'reset').catch((e) => console.error('[auth] reset email failed:', (e as Error).message));
    }
    asJson ? json(res, 200, { ok: true, emailSent: works }) : sendHtml(res, 200, forgotSentPage(works));
  });

  /* The owner app (apps/owner). Install files are public; registered before /app/:tab so they answer first. */
  loadAppFiles();
  for (const [path] of APP_STATIC) route('GET', path, (req, res) => { if (!APP_FILES.serve(req, res, path)) json(res, 404, { error: 'not found' }); });

  /* Signed out → sign in, then back to the same screen. Signed in → apps/owner/index.html, or a simple page until it exists. */
  const openApp: Handler = (req, res, svc) => {
    const cur = currentSession(req, svc);
    if (!cur || cur === 'invalid') {
      if (cur === 'invalid') res.setHeader('set-cookie', clearedCookie(svc));
      const here = safeNext(new URL(req.url ?? '/app', 'http://x').pathname);
      return redirect(res, `/login?next=${encodeURIComponent(here)}`, 302);
    }
    if (cur.refreshCookie) res.setHeader('set-cookie', cur.refreshCookie);
    const page = appHtml();
    if (page) return sendApp(res, page);
    const owner = svc.store.get('owners', cur.session.ownerId)!;
    sendHtml(res, 200, appPlaceholderPage(owner.name, owner.email, owner.onboarding?.status === 'booked' ? null : calendlyUrlFor(owner)));
  };
  route('GET', '/app', openApp);
  route('GET', '/app/:tab', (req, res, svc) => ((APP_TABS as readonly string[]).includes(req.params.tab) ? openApp(req, res, svc) : json(res, 404, { error: 'not found' })));
  route('GET', '/app/:tab/:item', (req, res, svc) => (req.params.tab === 'messages' ? openApp(req, res, svc) : json(res, 404, { error: 'not found' })));

  /* ---------------- admin: a one-time sign-in link for onboarding a client by hand ---------------- */
  route('POST', '/api/admin/owners/:id/login-link', (req, res, svc) => {
    if (!isAdmin(req)) return json(res, 401, { error: 'admin only' });
    const owner = svc.store.get('owners', req.params.id);
    if (!owner) return json(res, 404, { error: 'Not found.' });
    const purpose = owner.passwordHash ? 'reset' : 'setup';
    const link = issueLoginLink(svc, owner.id, { purpose, via: 'admin', ttlMs: LINK_TTL_MS });
    svc.engine.audit({ ownerId: owner.id, actor: 'system', action: 'owner.login_link', detail: `${BRAND.name} support created a one-time sign-in link (${purpose === 'setup' ? 'create a password' : 'reset the password'}).` });
    svc.store.flush();
    json(res, 201, { url: link.url, expiresAt: link.expiresAt, purpose, owner: { id: owner.id, name: owner.name, email: owner.email } });
  });

  route('POST', '/api/admin/owners/:id/two-step/off', (req, res, svc) => {
    if (!isAdmin(req)) return json(res, 401, { error: 'unauthorized' });
    const owner = svc.store.get('owners', req.params.id);
    if (!owner) return json(res, 404, { error: 'not found' });
    svc.store.update('owners', owner.id, { totpSecret: undefined, totpPending: undefined, totpEnabledAt: undefined, totpLastStep: undefined });
    revokeAllSessions(svc, owner.id, undefined, { memberId: null });
    svc.engine.audit({ ownerId: owner.id, actor: 'system', action: 'auth.two_step_reset', detail: `${BRAND.name} support turned off two-step sign-in (lost phone). You were signed out everywhere.` });
    svc.store.flush();
    json(res, 200, { ok: true });
  });

  /* ---------------- me ---------------- */
  r('GET', '/api/me', (req, res, svc, ownerId) => {
    if (syncSetupTasks(svc, ownerId)) svc.store.flush();
    const o = svc.store.get('owners', ownerId) ?? notFound();
    json(res, 200, { ...meView(svc, o, req.auth?.via ?? 'bearer'), me: meWho(svc, o, req.auth), entitlements: entitlementsOf(o), ...(svc.lab ? { lab: true } : {}) });
  });

  r('PATCH', '/api/me', async (req, res, svc, ownerId) => {
    const b = body(req.body);
    const o = svc.store.get('owners', ownerId) ?? notFound();
    const p: Partial<Owner> = {};
    if ('name' in b) p.name = text(b.name, { field: 'name', label: 'your name', max: 80, required: true });
    if ('phone' in b) {
      p.phone = phone(b.phone, { field: 'phone', label: 'your mobile number', required: true });
      if (p.phone !== o.phone && svc.store.find('owners', (x) => x.id !== ownerId && !!x.phone && addressKey(x.phone) === p.phone)) conflict('That number is already on another account.', 'phone');
    }
    if ('email' in b) {
      p.email = email(b.email, { field: 'email', label: 'your email', required: true });
      if (!sameEmail(o.email, p.email!)) {
        if (svc.store.find('owners', (x) => x.id !== ownerId && sameEmail(x.email, p.email!))) conflict("That email can't be used. Try another.", 'email');
        if (req.auth?.via === 'session' && o.passwordHash) {
          if (LOGIN_LIMIT.email.blocked(o.email.toLowerCase())) fail('Too many tries. Please wait a few minutes.', 'password', 429);
          if (!(await verifyPassword(String(b.password ?? ''), o.passwordHash))) { LOGIN_LIMIT.email.take(o.email.toLowerCase()); fail('Enter your current password to change your email.', 'password'); }
        }
      }
    }
    if ('smsConsent' in b) {
      const v = bool(b.smsConsent, { field: 'smsConsent', label: 'texts' });
      if (v !== undefined) p.consents = { ...(o.consents ?? {}), smsConsent: v, smsConsentAt: v ? nowIso(svc) : o.consents?.smsConsentAt };
    }
    const changed = Object.keys(p);
    if (!changed.length) fail('Nothing to change. Send name, phone, email or smsConsent.');
    const next = svc.store.update('owners', ownerId, p);
    svc.engine.audit({ ownerId, actor: 'owner', action: 'owner.profile_updated', detail: `Profile updated: ${changed.map((k) => (k === 'consents' ? 'text alerts' : k)).join(', ')}.` });
    json(res, 200, meView(svc, next, req.auth?.via ?? 'bearer'));
  });

  r('POST', '/api/me/password', async (req, res, svc, ownerId) => {
    const b = body(req.body);
    const member = getMember(svc, req.auth?.memberId);
    if (member) {
      if (LOGIN_LIMIT.email.blocked(member.email.toLowerCase())) fail('Too many tries. Please wait a few minutes.', 'currentPassword', 429);
      if (!(await verifyPassword(String(b.currentPassword ?? ''), member.passwordHash))) { LOGIN_LIMIT.email.take(member.email.toLowerCase()); fail("Your current password isn't right.", 'currentPassword'); }
      const problem = passwordProblem(b.newPassword, member.email);
      if (problem) fail(problem, 'newPassword');
      saveMember(svc, { ...member, passwordHash: await hashPassword(String(b.newPassword)), passwordSetAt: nowIso(svc) });
      revokeAllSessions(svc, ownerId, req.auth?.sessionId, { memberId: member.id });
      return json(res, 200, { ok: true });
    }
    const o = svc.store.get('owners', ownerId) ?? notFound();
    if (o.passwordHash) {
      if (LOGIN_LIMIT.email.blocked(o.email.toLowerCase())) fail('Too many tries. Please wait a few minutes.', 'currentPassword', 429);
      if (!(await verifyPassword(String(b.currentPassword ?? ''), o.passwordHash))) { LOGIN_LIMIT.email.take(o.email.toLowerCase()); fail("Your current password isn't right.", 'currentPassword'); }
    }
    const problem = passwordProblem(b.newPassword, o.email);
    if (problem) fail(problem, 'newPassword');
    svc.store.update('owners', ownerId, { passwordHash: await hashPassword(String(b.newPassword)), passwordSetAt: nowIso(svc) });
    const others = revokeAllSessions(svc, ownerId, req.auth?.sessionId, { memberId: null });
    revokeLoginLinks(svc, ownerId, null);
    svc.engine.audit({ ownerId, actor: 'owner', action: 'owner.password_changed', detail: `Password changed${others ? `; ${others} other device${others === 1 ? '' : 's'} signed out` : ''}.` });
    json(res, 200, { ok: true });
  });

  /* ---------------- two-step sign-in (the signed-in person's own) ---------------- */
  const person = (svc: Services, ownerId: string, req: Req): { rec: Owner | Member; save: (p: Partial<Member & Owner>) => void } => {
    const m = getMember(svc, req.auth?.memberId);
    if (m) return { rec: m, save: (p) => saveMember(svc, { ...m, ...p } as Member) };
    const o = svc.store.get('owners', ownerId) ?? notFound();
    return { rec: o, save: (p) => svc.store.update('owners', ownerId, p as Partial<Owner>) };
  };

  r('GET', '/api/me/two-step', (req, res, svc, ownerId) => {
    const { rec } = person(svc, ownerId, req);
    json(res, 200, { enabled: !!rec.totpSecret, enabledAt: rec.totpEnabledAt ?? null, settingUp: !!rec.totpPending });
  });

  /** Start: a new secret the owner adds to their authenticator app (by key or otpauth link). Not on until they confirm a code. */
  r('POST', '/api/me/two-step/setup', (req, res, svc, ownerId) => {
    const { rec, save } = person(svc, ownerId, req);
    if (rec.totpSecret) conflict('Two-step sign-in is already on. Turn it off first to set up a new phone.');
    const secret = newTotpSecret();
    save({ totpPending: secret });
    json(res, 200, { secret: secret.replace(/(.{4})/g, '$1 ').trim(), uri: otpauthUri({ issuer: BRAND.name, account: rec.email, secret }) });
  });

  r('POST', '/api/me/two-step/enable', (req, res, svc, ownerId) => {
    const b = body(req.body);
    const { rec, save } = person(svc, ownerId, req);
    if (!rec.totpPending) fail('Start setup first.', 'code');
    const step = verifyTotp(rec.totpPending, b.code, svc.clock.now().getTime());
    if (step === undefined) fail("That code didn't match. Make sure your phone's time is set automatically, then try the newest code.", 'code');
    save({ totpSecret: rec.totpPending, totpPending: undefined, totpEnabledAt: nowIso(svc), totpLastStep: step });
    svc.engine.audit({ ownerId, actor: 'owner', action: 'auth.two_step_on', detail: `Two-step sign-in turned on for ${rec.name}.` });
    json(res, 200, { enabled: true });
  });

  r('POST', '/api/me/two-step/disable', async (req, res, svc, ownerId) => {
    const b = body(req.body);
    const { rec, save } = person(svc, ownerId, req);
    if (!(await verifyPassword(String(b.password ?? ''), rec.passwordHash))) fail('Enter your password to turn off two-step sign-in.', 'password');
    save({ totpSecret: undefined, totpPending: undefined, totpEnabledAt: undefined, totpLastStep: undefined });
    svc.engine.audit({ ownerId, actor: 'owner', action: 'auth.two_step_off', detail: `Two-step sign-in turned off for ${rec.name}.` });
    json(res, 200, { enabled: false });
  });

  /* ---------------- devices ("where you're signed in") ---------------- */
  r('GET', '/api/me/sessions', (req, res, svc, ownerId) => {
    json(res, 200, { sessions: sessionsOf(svc, ownerId, req.auth?.memberId ?? null).map((s) => sessionView(s, req.auth?.sessionId)) });
  });
  r('DELETE', '/api/me/sessions/:id', (req, res, svc, ownerId) => {
    const s = sessionsOf(svc, ownerId, req.auth?.memberId ?? null).find((x) => x.id.slice(0, 16) === req.params.id) ?? notFound();
    svc.store.kvDelete('sessions', s.id);
    json(res, 200, { ok: true, current: s.id === req.auth?.sessionId });
  });
  r('POST', '/api/me/sessions/others', (req, res, svc, ownerId) => {
    json(res, 200, { signedOut: revokeAllSessions(svc, ownerId, req.auth?.sessionId, { memberId: req.auth?.memberId ?? null }) });
  });

  /* ---------------- team (owner only; roleProblem in auth.ts keeps members out of changes) ---------------- */
  const ROLES = Object.keys(ROLE_NAMES) as Role[];
  r('GET', '/api/team', (_req, res, svc, ownerId) => json(res, 200, { members: membersOf(svc, ownerId).map(memberView), roles: ROLES.map((id) => ({ id, name: ROLE_NAMES[id] })) }));

  r('POST', '/api/team', (req, res, svc, ownerId) => {
    const b = body(req.body);
    const owner = svc.store.get('owners', ownerId) ?? notFound();
    const name = text(b.name, { field: 'name', label: 'their name', max: 80, required: true })!;
    const mail = email(b.email, { field: 'email', label: 'their email', required: true })!;
    const role = oneOf(b.role, ROLES, { field: 'role', label: 'access', required: true })!;
    if (sameEmail(owner.email, mail) || svc.store.find('owners', (o) => sameEmail(o.email, mail)) || memberByEmail(svc, mail)) conflict('That email already has a KeyHelm sign-in.', 'email');
    if (membersOf(svc, ownerId).length >= 10) conflict('A team can have up to 10 people.');
    const m = saveMember(svc, { id: `mem_${randomBytes(8).toString('hex')}`, ownerId, name, email: mail, role, status: 'invited', createdAt: nowIso(svc) });
    const link = issueLoginLink(svc, ownerId, { purpose: 'invite', via: 'owner', memberId: m.id });
    const emailed = emailConfigured();
    if (emailed) void sendMemberEmail(svc, m, link.url, 'invite').catch((e) => console.error('[auth] invite email failed:', (e as Error).message));
    svc.engine.audit({ ownerId, actor: 'owner', action: 'team.invited', detail: `Invited ${name} (${ROLE_NAMES[role]}).` });
    // The owner can also pass the link on themselves (needed until email is set up).
    json(res, 201, { member: memberView(m), inviteUrl: link.url, expiresAt: link.expiresAt, emailed });
  });

  r('PATCH', '/api/team/:id', (req, res, svc, ownerId) => {
    const b = body(req.body);
    const m = getMember(svc, req.params.id);
    if (!m || m.ownerId !== ownerId) notFound();
    const role = oneOf(b.role, ROLES, { field: 'role', label: 'access', required: true })!;
    const next = saveMember(svc, { ...m!, role });
    svc.engine.audit({ ownerId, actor: 'owner', action: 'team.role', detail: `${m!.name} now has ${ROLE_NAMES[role]} access.` });
    json(res, 200, { member: memberView(next) });
  });

  r('POST', '/api/team/:id/invite', (req, res, svc, ownerId) => {
    const m = getMember(svc, req.params.id);
    if (!m || m.ownerId !== ownerId) notFound();
    const link = issueLoginLink(svc, ownerId, { purpose: m!.passwordHash ? 'reset' : 'invite', via: 'owner', memberId: m!.id });
    if (emailConfigured()) void sendMemberEmail(svc, m!, link.url, m!.passwordHash ? 'reset' : 'invite').catch((e) => console.error('[auth] invite email failed:', (e as Error).message));
    json(res, 200, { inviteUrl: link.url, expiresAt: link.expiresAt, emailed: emailConfigured() });
  });

  r('DELETE', '/api/team/:id', (req, res, svc, ownerId) => {
    const m = getMember(svc, req.params.id);
    if (!m || m.ownerId !== ownerId) notFound();
    svc.store.kvDelete('members', m!.id);
    revokeAllSessions(svc, ownerId, undefined, { memberId: m!.id });
    revokeLoginLinks(svc, ownerId, m!.id);
    svc.engine.audit({ ownerId, actor: 'owner', action: 'team.removed', detail: `Removed ${m!.name} from your team. They were signed out.` });
    json(res, 200, { ok: true });
  });

  /* ---------------- rules ---------------- */
  r('GET', '/api/rules', (_req, res, svc, ownerId) => json(res, 200, rulesView(svc, ownerId)));
  for (const m of ['PUT', 'PATCH']) {
    r(m, '/api/rules', (req, res, svc, ownerId) => {
      const p = rulesPatch(body(req.body));
      if (!Object.keys(p).length) fail('Nothing to save. Send at least one rule.');
      const cur = ensureRules(svc, ownerId);
      svc.store.update('rules', cur.id, p);
      svc.store.kvSet('rulesSaved', ownerId, nowIso(svc));
      svc.store.kvDelete('rulesDefaulted', ownerId);
      svc.engine.audit({ ownerId, actor: 'owner', action: 'rules.updated', detail: `Rules updated: ${Object.keys(p).join(', ')}.` });
      syncSetupTasks(svc, ownerId);
      json(res, 200, rulesView(svc, ownerId));
    });
  }

  /* ---------------- homes ---------------- */
  r('GET', '/api/properties', (_req, res, svc, ownerId) => json(res, 200, svc.store.list('properties', (p) => p.ownerId === ownerId).map((p) => propertyView(svc, p))));

  const propertyInput = (b: Record<string, unknown>, creating: boolean): Partial<Property> => {
    const p: Partial<Property> = {};
    const want = (k: string) => creating || k in b;
    if (want('address')) p.address = text(b.address, { field: 'address', label: 'the street address', max: 120, required: true });
    if (want('city')) p.city = text(b.city, { field: 'city', label: 'the city', max: 60, required: true });
    if (want('state')) {
      p.state = (text(b.state, { field: 'state', label: 'the state', max: 2 }) || 'CO').toUpperCase();
      if (p.state !== 'CO') fail(`${BRAND.name} works with Colorado homes for now.`, 'state');
    }
    if (want('zip')) {
      p.zip = text(b.zip, { field: 'zip', label: 'the ZIP code', max: 10, required: true });
      if (!/^8[01]\d{3}(-\d{4})?$/.test(p.zip!)) fail('Please enter a Colorado ZIP code, like 80112.', 'zip');
    }
    if (want('beds')) p.beds = rooms(b.beds, { field: 'beds', label: 'bedrooms', required: true });
    if (want('baths')) p.baths = rooms(b.baths, { field: 'baths', label: 'bathrooms', required: true });
    if (want('rent')) p.rent = dollars(b.rent, { field: 'rent', label: 'the monthly rent', min: 1, max: 100_000, required: true });
    if ('deposit' in b) p.deposit = dollars(b.deposit, { field: 'deposit', label: 'the deposit', max: 100_000, required: true });
    if ('status' in b || creating) {
      if (b.status === 'listed') fail('To list a home, use Publish listing so the ad is checked first.', 'status');
      p.status = oneOf(b.status, ['occupied', 'vacant', 'turnover'] as const, { field: 'status', label: 'the status' }) ?? (creating ? 'occupied' : undefined);
      if (p.status === undefined) delete p.status;
    }
    if ('lock' in b) {
      const l = b.lock;
      if (l === null || l === undefined) p.lock = { kind: 'none' };
      else if (!isObj(l)) fail('lock should look like {"kind":"smart","deviceId":"..."}.', 'lock');
      else {
        const kind = oneOf(l.kind, ['smart', 'lockbox', 'none'] as const, { field: 'lock', label: 'the lock type', required: true })!;
        const deviceId = text(l.deviceId, { field: 'lock', label: 'the lock device id', max: 80 }) || undefined;
        const lockboxCode = text(l.lockboxCode, { field: 'lock', label: 'the lockbox code', max: 20 }) || undefined;
        if (kind === 'smart' && !deviceId) fail('Add the smart lock device id.', 'lock');
        if (kind === 'lockbox' && !lockboxCode) fail('Add the lockbox code.', 'lock');
        p.lock = { kind, ...(deviceId ? { deviceId } : {}), ...(lockboxCode ? { lockboxCode } : {}) };
      }
    }
    if ('facts' in b) p.facts = facts(b.facts, { field: 'facts', label: 'home details' }) ?? {};
    return p;
  };
  const sameHome = (a: Pick<Property, 'address' | 'zip'>, b: Pick<Property, 'address' | 'zip'>) => a.address.trim().toLowerCase().replace(/\s+/g, ' ') === b.address.trim().toLowerCase().replace(/\s+/g, ' ') && a.zip.slice(0, 5) === b.zip.slice(0, 5);

  r('POST', '/api/properties', (req, res, svc, ownerId) => {
    const p = propertyInput(body(req.body), true) as Omit<Property, 'id' | 'ownerId'>;
    if (svc.store.find('properties', (x) => x.ownerId === ownerId && sameHome(x, p))) conflict('You already have this home.', 'address');
    const made = svc.store.insert('properties', { ...p, ownerId, deposit: p.deposit ?? p.rent, lock: p.lock ?? { kind: 'none' }, facts: p.facts ?? {} });
    ensureRules(svc, ownerId);
    svc.engine.audit({ ownerId, actor: 'owner', action: 'property.added', detail: `Home added: ${made.address}, ${made.city}.` });
    syncSetupTasks(svc, ownerId);
    json(res, 201, propertyView(svc, made));
  });

  r('PATCH', '/api/properties/:id', async (req, res, svc, ownerId) => {
    const cur = ownedBy(svc.store.get('properties', req.params.id), ownerId);
    const p = propertyInput(body(req.body), false);
    if (!Object.keys(p).length) fail('Nothing to change.');
    const merged = { ...cur, ...p };
    if ((p.address || p.zip) && svc.store.find('properties', (x) => x.ownerId === ownerId && x.id !== cur.id && sameHome(x, merged))) conflict('You already have this home.', 'address');
    const next = svc.store.update('properties', cur.id, p);
    if (cur.status === 'listed' && p.status && p.status !== cur.status) await svc.adapters.listings.unpublish({ propertyId: cur.id });
    svc.engine.audit({ ownerId, actor: 'owner', action: 'property.updated', detail: `Home updated: ${next.address} (${Object.keys(p).join(', ')}).` });
    json(res, 200, propertyView(svc, next));
  });

  r('DELETE', '/api/properties/:id', async (req, res, svc, ownerId) => {
    const p = ownedBy(svc.store.get('properties', req.params.id), ownerId);
    if (svc.store.find('leases', (l) => l.propertyId === p.id && LIVE_LEASE.includes(l.status))) conflict('This home has an active lease, so it can\'t be removed. Mark the tenants as former tenants first.');
    if (svc.store.find('tenants', (t) => t.propertyId === p.id && t.status !== 'former')) conflict('This home still has tenants. Mark them as former tenants first.');
    if (svc.store.find('applications', (a) => a.propertyId === p.id && ['submitted', 'screening', 'ready_for_owner'].includes(a.status))) conflict('This home has applications in progress. Decide on them first.');
    if (svc.store.find('showings', (x) => x.propertyId === p.id && ['requested', 'confirmed'].includes(x.status))) conflict('This home has showings booked. Cancel them first.');
    if (svc.store.find('workOrders', (w) => w.propertyId === p.id && !CLOSED_WO.includes(w.status))) conflict('This home has an open repair. Remove it after the repair is finished.');
    if (p.status === 'listed') await svc.adapters.listings.unpublish({ propertyId: p.id });
    svc.store.remove('properties', p.id);
    svc.engine.audit({ ownerId, actor: 'owner', action: 'property.removed', detail: `Home removed: ${p.address}.` });
    json(res, 200, { ok: true, id: p.id });
  });

  /* ---------------- tenants ---------------- */
  r('GET', '/api/tenants', (req, res, svc, ownerId) => {
    const s = status(req, ['active', 'former', 'future'] as const);
    json(res, 200, svc.store.list('tenants', (t) => t.ownerId === ownerId && (!s || t.status === s)).map((t) => tenantView(svc, t)));
  });

  const contactChecks = (svc: Services, ownerId: string, t: Pick<Tenant, 'phone' | 'email'>, exceptId?: string) => {
    if (!t.phone && !t.email) fail('Add a mobile number or an email so we can reach them.', 'phone');
    const owner = svc.store.get('owners', ownerId)!;
    if (t.phone && owner.phone && addressKey(owner.phone) === t.phone) fail("That's your own number. Add the tenant's number.", 'phone');
    const dupe = svc.store.find('tenants', (x) => x.ownerId === ownerId && x.id !== exceptId && x.status !== 'former' && ((!!t.phone && !!x.phone && addressKey(x.phone) === t.phone) || (!!t.email && !!x.email && sameEmail(x.email, t.email))));
    if (dupe) conflict(`${dupe.name} already has that phone or email.`, t.phone && dupe.phone && addressKey(dupe.phone) === t.phone ? 'phone' : 'email');
  };

  r('POST', '/api/tenants', async (req, res, svc, ownerId) => {
    const b = body(req.body);
    const propertyId = text(b.propertyId, { field: 'propertyId', label: 'the home', max: 64, required: true })!;
    const prop = ownedBy(svc.store.get('properties', propertyId), ownerId);
    const t = {
      name: text(b.name, { field: 'name', label: "the tenant's name", max: 80, required: true })!,
      phone: phone(b.phone, { field: 'phone', label: "the tenant's mobile number" }) || undefined,
      email: email(b.email, { field: 'email', label: "the tenant's email" }) || undefined,
    };
    contactChecks(svc, ownerId, t);
    const preferredChannel = oneOf(b.preferredChannel, ['sms', 'email'] as const, { field: 'preferredChannel', label: 'how to reach them' }) ?? (t.phone ? 'sms' : 'email');
    if (preferredChannel === 'email' && !t.email) fail('Add an email to reach them by email.', 'email');
    if (preferredChannel === 'sms' && !t.phone) fail('Add a mobile number to reach them by text.', 'phone');
    const language = text(b.language, { field: 'language', label: 'their language', max: 30 }) || undefined;
    const autopay = bool(b.autopay, { field: 'autopay', label: 'autopay' }) ?? false;
    const tStatus = oneOf(b.status, ['active', 'future'] as const, { field: 'status', label: 'the status' }) ?? 'active';
    const invite = bool(b.invite, { field: 'invite', label: 'invite' }) ?? true;

    // Their current lease, so rent reminders and renewals work. Joins the home's active lease if there is one.
    const existing = svc.store.find('leases', (l) => l.propertyId === prop.id && l.status === 'active');
    let newLease: Omit<Lease, 'id'> | undefined;
    if (!existing && b.lease !== undefined && b.lease !== null) {
      if (!isObj(b.lease)) fail('lease should have startDate, endDate, rent and deposit.', 'lease');
      const l = b.lease as Record<string, unknown>;
      const startDate = ymd(l.startDate, { field: 'lease.startDate', label: 'the lease start date', required: true })!;
      const endDate = ymd(l.endDate, { field: 'lease.endDate', label: 'the lease end date', required: true })!;
      if (endDate <= startDate) fail('The lease has to end after it starts.', 'lease.endDate');
      if (endDate < nowIso(svc).slice(0, 10)) fail('That lease has already ended. Add the current lease dates.', 'lease.endDate');
      const rent = dollars(l.rent, { field: 'lease.rent', label: 'the lease rent', min: 1, max: 100_000, required: true })!;
      const deposit = dollars(l.deposit, { field: 'lease.deposit', label: 'the deposit', max: 100_000 }) ?? 0;
      newLease = { ownerId, propertyId: prop.id, tenantIds: [], startDate, endDate, rent, deposit, depositHeld: deposit, status: 'active' };
    }

    const made = svc.store.insert('tenants', { ownerId, propertyId: prop.id, ...t, preferredChannel, language, autopay, status: tStatus });
    if (existing && tStatus === 'active') svc.store.update('leases', existing.id, { tenantIds: [...existing.tenantIds, made.id] });
    if (newLease) {
      svc.store.insert('leases', { ...newLease, tenantIds: [made.id] });
      if (prop.status !== 'occupied' && tStatus === 'active') svc.store.update('properties', prop.id, { status: 'occupied' });
    }
    ensureRules(svc, ownerId);
    svc.engine.audit({ ownerId, actor: 'owner', action: 'tenant.added', detail: `Tenant added: ${made.name} at ${prop.address}${invite ? '' : ' (no welcome text)'}.` });
    if (invite) svc.engine.emit('tenant.added', { tenantId: made.id });
    await svc.engine.drain();
    syncSetupTasks(svc, ownerId);
    json(res, 201, tenantView(svc, svc.store.get('tenants', made.id)!));
  });

  r('PATCH', '/api/tenants/:id', (req, res, svc, ownerId) => {
    const cur = ownedBy(svc.store.get('tenants', req.params.id), ownerId);
    const b = body(req.body);
    if ('propertyId' in b || 'status' in b) fail("A tenant's home and status can't be changed here. To end a tenancy, mark them as a former tenant.", 'propertyId' in b ? 'propertyId' : 'status');
    const p: Partial<Tenant> = {};
    if ('name' in b) p.name = text(b.name, { field: 'name', label: "the tenant's name", max: 80, required: true });
    if ('phone' in b) p.phone = phone(b.phone, { field: 'phone', label: "the tenant's mobile number" }) || undefined;
    if ('email' in b) p.email = email(b.email, { field: 'email', label: "the tenant's email" }) || undefined;
    if ('preferredChannel' in b) p.preferredChannel = oneOf(b.preferredChannel, ['sms', 'email'] as const, { field: 'preferredChannel', label: 'how to reach them', required: true });
    if ('language' in b) p.language = text(b.language, { field: 'language', label: 'their language', max: 30 }) || undefined;
    if ('autopay' in b) p.autopay = bool(b.autopay, { field: 'autopay', label: 'autopay' }) ?? false;
    if ('forwardingAddress' in b) p.forwardingAddress = text(b.forwardingAddress, { field: 'forwardingAddress', label: 'the forwarding address', max: 200 }) || undefined;
    if (!Object.keys(p).length) fail('Nothing to change.');
    const merged = { ...cur, ...p };
    if ('phone' in p || 'email' in p) contactChecks(svc, ownerId, merged, cur.id);
    if (merged.preferredChannel === 'email' && !merged.email) fail('Add an email to reach them by email.', 'email');
    if (merged.preferredChannel === 'sms' && !merged.phone) merged.preferredChannel = 'email';
    const next = svc.store.update('tenants', cur.id, { ...p, preferredChannel: merged.preferredChannel });
    svc.engine.audit({ ownerId, actor: 'owner', action: 'tenant.updated', detail: `Tenant updated: ${next.name} (${Object.keys(p).join(', ')}).` });
    json(res, 200, tenantView(svc, next));
  });

  r('POST', '/api/tenants/:id/former', (req, res, svc, ownerId) => {
    const t = ownedBy(svc.store.get('tenants', req.params.id), ownerId);
    const b = body(req.body);
    const forwardingAddress = text(b.forwardingAddress, { field: 'forwardingAddress', label: 'the forwarding address', max: 200 }) || undefined;
    if (t.status === 'former') return json(res, 200, tenantView(svc, forwardingAddress ? svc.store.update('tenants', t.id, { forwardingAddress }) : t));
    const next = svc.store.update('tenants', t.id, { status: 'former', ...(forwardingAddress ? { forwardingAddress } : {}) });
    // Everyone on the lease has moved out → the lease is over and rent reminders stop.
    const lease = svc.store.find('leases', (l) => l.status === 'active' && l.tenantIds.includes(t.id));
    let ended = false;
    if (lease && lease.tenantIds.every((id) => svc.store.get('tenants', id)?.status === 'former')) {
      svc.store.update('leases', lease.id, { status: 'ended' });
      const prop = svc.store.get('properties', lease.propertyId);
      if (prop?.status === 'occupied') svc.store.update('properties', prop.id, { status: 'turnover' });
      ended = true;
    }
    svc.engine.audit({ ownerId, actor: 'owner', action: 'tenant.former', detail: `${t.name} marked as a former tenant${ended ? '; their lease is marked ended' : ''}.` });
    json(res, 200, tenantView(svc, next));
  });

  /* ---------------- vendors ---------------- */
  r('GET', '/api/vendors', (_req, res, svc, ownerId) => json(res, 200, svc.store.list('vendors', (v) => v.ownerId === ownerId)));

  const vendorInput = (svc: Services, ownerId: string, b: Record<string, unknown>, cur?: Vendor): Partial<Vendor> => {
    const p: Partial<Vendor> = {};
    const want = (k: string) => !cur || k in b;
    if (want('name')) p.name = text(b.name, { field: 'name', label: "the vendor's name", max: 80, required: true });
    if ('trades' in b || !cur) p.trades = trades(b.trades, { field: 'trades', label: 'trades' }) ?? ['general'];
    if ('phone' in b) p.phone = phone(b.phone, { field: 'phone', label: "the vendor's phone" }) || undefined;
    if ('email' in b) p.email = email(b.email, { field: 'email', label: "the vendor's email" }) || undefined;
    if ('emergency' in b || !cur) p.emergency = bool(b.emergency, { field: 'emergency', label: 'emergency jobs' }) ?? false;
    if ('preferred' in b || !cur) p.preferred = bool(b.preferred, { field: 'preferred', label: 'preferred' }) ?? true;
    const merged = { ...(cur ?? {}), ...p };
    if (!merged.phone && !merged.email) fail('Add a phone or an email so we can reach them.', 'phone');
    if (p.phone && svc.store.find('vendors', (v) => v.ownerId === ownerId && v.id !== cur?.id && !!v.phone && addressKey(v.phone) === p.phone)) conflict('Another vendor already has that phone.', 'phone');
    return p;
  };

  r('POST', '/api/vendors', (req, res, svc, ownerId) => {
    const p = vendorInput(svc, ownerId, body(req.body)) as Omit<Vendor, 'id' | 'ownerId'>;
    const made = svc.store.insert('vendors', { ...p, ownerId });
    svc.engine.audit({ ownerId, actor: 'owner', action: 'vendor.added', detail: `Vendor added: ${made.name} (${made.trades.join(', ')}).` });
    syncSetupTasks(svc, ownerId);
    json(res, 201, made);
  });

  r('PATCH', '/api/vendors/:id', (req, res, svc, ownerId) => {
    const cur = ownedBy(svc.store.get('vendors', req.params.id), ownerId);
    const p = vendorInput(svc, ownerId, body(req.body), cur);
    if (!Object.keys(p).length) fail('Nothing to change.');
    const next = svc.store.update('vendors', cur.id, p);
    svc.engine.audit({ ownerId, actor: 'owner', action: 'vendor.updated', detail: `Vendor updated: ${next.name} (${Object.keys(p).join(', ')}).` });
    json(res, 200, next);
  });

  r('DELETE', '/api/vendors/:id', (req, res, svc, ownerId) => {
    const v = ownedBy(svc.store.get('vendors', req.params.id), ownerId);
    if (svc.store.find('workOrders', (w) => w.vendorId === v.id && !CLOSED_WO.includes(w.status) && w.status !== 'completed')) conflict(`${v.name} has an open repair. Remove them after it's finished.`);
    svc.store.remove('vendors', v.id);
    svc.engine.audit({ ownerId, actor: 'owner', action: 'vendor.removed', detail: `Vendor removed: ${v.name}.` });
    json(res, 200, { ok: true, id: v.id });
  });

  /* ---------------- lease templates (plain text; PDF/Word convert to text first) ---------------- */
  r('GET', '/api/lease-templates', (_req, res, svc, ownerId) => json(res, 200, svc.store.list('leaseTemplates', (t) => t.ownerId === ownerId).sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt))));

  r('POST', '/api/lease-templates', async (req, res, svc, ownerId) => {
    const b = body(req.body);
    const name = text(b.name, { field: 'name', label: 'the lease name', max: 80 }) || 'My lease';
    const raw = text(b.text, { field: 'text', label: 'the lease text', max: 200_000, required: true, multiline: true })!;
    if (raw.length < 100) fail('That looks too short for a lease. Paste the whole lease text.', 'text');
    const prepared = prepareTemplate(raw);
    const t = svc.store.insert('leaseTemplates', { ownerId, name, body: prepared.body, fields: prepared.fields, uploadedAt: nowIso(svc) });
    svc.engine.emit('template.uploaded', { ownerId, templateId: t.id });
    await svc.engine.drain();
    svc.engine.audit({ ownerId, actor: 'owner', action: 'lease.template_uploaded', detail: `Lease uploaded: ${name} (${prepared.fields.length} fill-in fields).` });
    syncSetupTasks(svc, ownerId);
    json(res, 201, t);
  });

  /* ---------------- decisions ---------------- */
  r('GET', '/api/approvals', (req, res, svc, ownerId) => {
    const s = status(req, ['pending', 'decided', 'expired'] as const);
    json(res, 200, svc.store.list('approvals', (a) => a.ownerId === ownerId && (!s || a.status === s)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((a) => approvalView(svc, a)));
  });

  r('POST', '/api/approvals/:id', async (req, res, svc, ownerId) => {
    const a = ownedBy(svc.store.get('approvals', req.params.id), ownerId);
    if (a.status !== 'pending') conflict(a.status === 'decided' ? 'This decision was already made.' : 'This decision expired.');
    const d = checkDecision(svc, a, body(req.body));
    svc.engine.decide(a.id, d.decision, d.note, d.data);
    await svc.engine.drain();
    json(res, 200, approvalView(svc, svc.store.get('approvals', a.id)!));
  });

  /* ---------------- to-dos ---------------- */
  r('GET', '/api/tasks', (req, res, svc, ownerId) => {
    const s = status(req, ['open', 'done'] as const);
    const list = svc.store.list('tasks', (t) => t.ownerId === ownerId && (!s || t.status === s))
      .sort((a, b) => (a.status === b.status ? (a.dueAt ?? '9999').localeCompare(b.dueAt ?? '9999') : a.status === 'open' ? -1 : 1));
    json(res, 200, list.map((t) => ({ ...t, setupStep: t.detail === 'Setup step' ? stepOfTask(t.title) ?? null : null })));
  });

  r('POST', '/api/tasks/:id/done', (req, res, svc, ownerId) => {
    const t = ownedBy(svc.store.get('tasks', req.params.id), ownerId);
    const next = t.status === 'done' ? t : svc.store.update('tasks', t.id, { status: 'done' });
    if (t.status !== 'done') svc.engine.audit({ ownerId, actor: 'owner', action: 'task.done', detail: `Done: ${t.title}` });
    json(res, 200, { ...next, setupStep: next.detail === 'Setup step' ? stepOfTask(next.title) ?? null : null });
  });

  /* ---------------- rent records (KeyHelm never collects rent: the owner marks it received) ---------------- */
  r('GET', '/api/charges', (req, res, svc, ownerId) => {
    const s = status(req, ['open', 'paid', 'void'] as const);
    json(res, 200, svc.store.list('charges', (c) => c.ownerId === ownerId && (!s || c.status === s)).sort((a, b) => b.dueDate.localeCompare(a.dueDate)).map((c) => chargeView(svc, c)));
  });

  r('POST', '/api/charges/:id/received', async (req, res, svc, ownerId) => {
    const c = ownedBy(svc.store.get('charges', req.params.id), ownerId);
    if (c.status !== 'open') conflict(`This is already marked ${c.status}.`);
    const balance = c.amount - c.paid;
    const amount = dollars(body(req.body).amount, { field: 'amount', label: 'the amount that arrived', min: 0.01, max: 100_000 }) ?? balance;
    if (amount > balance) fail(`That's more than the ${money(balance)} still owed.`, 'amount');
    // Keyed by what was already recorded: a double tap is counted once, a later payment is new.
    svc.engine.emit('payment.received', { chargeId: c.id, amount, method: 'owner_recorded', providerRef: `owner_${c.id}_${c.paid}_${amount}` });
    await svc.engine.drain();
    json(res, 200, chargeView(svc, svc.store.get('charges', c.id)!));
  });

  /* ---------------- repairs ---------------- */
  r('GET', '/api/work-orders', (req, res, svc, ownerId) => {
    const s = status(req, ['open', 'closed'] as const);
    const list = svc.store.list('workOrders', (w) => w.ownerId === ownerId && (!s || (s === 'open') === !CLOSED_WO.includes(w.status)));
    json(res, 200, list.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((w) => workOrderView(svc, w)));
  });

  r('POST', '/api/work-orders', async (req, res, svc, ownerId) => {
    const b = body(req.body);
    const prop = ownedBy(svc.store.get('properties', text(b.propertyId, { field: 'propertyId', label: 'the home', max: 64, required: true })!), ownerId);
    const tenantId = text(b.tenantId, { field: 'tenantId', label: 'the tenant', max: 64 }) || undefined;
    if (tenantId) { const t = ownedBy(svc.store.get('tenants', tenantId), ownerId); if (t.propertyId !== prop.id) fail("That tenant doesn't live at this home.", 'tenantId'); }
    const summary = text(b.summary, { field: 'summary', label: 'what needs fixing', max: 500, required: true, multiline: true })!;
    if (summary.length < 3) fail('Say a little more about what needs fixing.', 'summary');
    const trade = (trades(b.trade === undefined ? undefined : [b.trade], { field: 'trade', label: 'the trade' }) ?? ['general'])[0];
    const urgency = oneOf(b.urgency, ['emergency', 'urgent', 'routine'] as const, { field: 'urgency', label: 'how urgent it is' }) ?? 'routine';
    const photos = links(b.photos, { field: 'photos', label: 'photos', max: 10 }) ?? [];
    ensureRules(svc, ownerId);
    const since = nowIso(svc);
    svc.engine.emit('maintenance.requested', { ownerId, propertyId: prop.id, tenantId, summary, trade, urgency, photos });
    await svc.engine.drain();
    const wo = svc.store.list('workOrders', (w) => w.ownerId === ownerId && w.propertyId === prop.id && w.createdAt >= since).pop();
    json(res, 202, { ok: true, workOrder: wo ? workOrderView(svc, wo) : null });
  });

  /* ---------------- messages ---------------- */
  r('GET', '/api/messages/threads', (req, res, svc, ownerId) => json(res, 200, threads(svc.store, ownerId, { includeOwner: req.query.get('all') === '1' })));

  r('GET', '/api/messages/threads/:key', (req, res, svc, ownerId) => {
    const key = addressKey(req.params.key);
    const contact = contactFor(svc.store, ownerId, key);
    const messages = threadMessages(svc.store, ownerId, key);
    if (!messages.length && (contact.role === 'unknown' || contact.role === 'owner')) notFound();
    json(res, 200, { key, contact, textsOff: !key.includes('@') && optedOut(svc.store, key, 'sms'), messages });
  });

  r('POST', '/api/messages/send', async (req, res, svc, ownerId) => {
    const b = body(req.body);
    const toKey = addressKey(text(b.to, { field: 'to', label: 'who to send to', max: 254, required: true })!);
    const contact = contactFor(svc.store, ownerId, toKey);
    const known = contact.role !== 'unknown' || !!svc.store.find('messages', (m) => m.ownerId === ownerId && m.threadKey === toKey);
    if (!known || contact.role === 'owner') fail("We couldn't find that contact on your account.", 'to', 404);
    const want = oneOf(b.channel, ['sms', 'email'] as const, { field: 'channel', label: 'the channel' }) ?? (toKey.includes('@') ? 'email' : 'sms');
    const to = want === 'email' ? (toKey.includes('@') ? toKey : contact.email) : (!toKey.includes('@') ? toKey : contact.phone);
    if (!to) fail(want === 'email' ? 'There is no email on file for them.' : 'There is no mobile number on file for them.', 'channel');
    const msg = text(b.body, { field: 'body', label: 'a message', max: 1000, required: true, multiline: true })!;
    if (want === 'sms' && optedOut(svc.store, to!, 'sms')) conflict(`This number replied STOP, so texts to it are off.${contact.email ? ' Send an email instead.' : ''} They can text START to turn texts back on.`, 'to');
    const wait = SEND_LIMIT.owner.take(ownerId);
    if (wait) fail(`You've sent a lot of messages in the last hour. Please wait ${mins(wait)}.`, undefined, 429);
    const owner = svc.store.get('owners', ownerId)!;
    const first = firstName(owner.name);
    // Texts say who wrote them, so people can tell the owner from the automated assistant.
    const out = want === 'sms' && !msg.toLowerCase().startsWith(first.toLowerCase()) ? `${first}: ${msg}` : msg;
    let providerId = '';
    try {
      providerId = (await svc.adapters.messaging.send({ channel: want, to: to!, body: out, subject: want === 'email' ? `Message from ${first}${contact.propertyAddress ? ` about ${contact.propertyAddress}` : ''}` : undefined })).providerId;
    } catch (e) {
      console.error('[owner-send] failed:', (e as Error).message);
      fail("The message didn't go out. Please try again in a minute.", undefined, 502);
    }
    const saved = svc.store.insert('messages', { ownerId, threadKey: addressKey(to!), direction: 'out', channel: want, to: to!, body: out, media: [], at: nowIso(svc), meta: { providerId, sentBy: 'owner' } });
    svc.engine.audit({ ownerId, actor: 'owner', action: 'message.owner_sent', detail: `You ${want === 'sms' ? 'texted' : 'emailed'} ${contact.name}.` });
    json(res, 201, { message: { id: saved.id, direction: 'out', channel: want, body: out, media: [], at: saved.at, from: null, to: saved.to, sentBy: 'owner' }, key: saved.threadKey });
  });

  /* ---------------- activity ---------------- */
  r('GET', '/api/activity', (req, res, svc, ownerId) => {
    const limit = int(req.query.get('limit') ?? undefined, { field: 'limit', label: 'limit', min: 1, max: 200 }) ?? 50;
    const before = req.query.get('before') ?? '';
    const list = svc.store.list('audit', (a) => a.ownerId === ownerId && (!before || a.at < before)).sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
    json(res, 200, list.map((a) => ({ id: a.id, at: a.at, actor: a.actor, action: a.action, detail: a.detail, workflow: a.workflow ?? null })));
  });
}
