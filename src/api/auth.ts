// Owner sign-in, with Node built-ins only.
//
//  - Passwords: salted scrypt (N=16384, r=8, p=1, 64-byte key), compared in constant time.
//    Stored on the owner as "scrypt$N$r$p$salt$hash" (base64url). Never sent to a client.
//  - Sessions: a random 32-byte token in the "kh_session" cookie (HttpOnly, SameSite=Lax,
//    Path=/, Secure when PUBLIC_URL is https). Only a SHA-256 of the token is stored (kv
//    "sessions"), so a copy of the data file can't be used to sign in. 30 days, sliding:
//    using the app extends it (at most once a day).
//  - One-time links (kv "loginLinks"): set a password after checkout, by admin, or after
//    "forgot password". Stored hashed, single use, 7 days (reset links: 1 hour). Issuing a
//    new link cancels the owner's older unused ones.
//  - CSRF: requests signed in with the cookie that change something (anything but GET/HEAD)
//    must send "X-KeyHelm: 1", and Origin/Referer (when present) must be this site.
//    Bearer-token API calls (kv "tokens", OWNER_API_TOKEN) work as before.
//  - Login limits per IP and per email (RL_LOGIN_IP_PER_HOUR, RL_LOGIN_EMAIL_PER_HOUR).
//  - Two-step sign-in (optional, per person): after the password, a 6-digit code from an
//    authenticator app (totp.ts). The password step hands out a 10-minute ticket (kv "mfa",
//    hashed, 5 tries) that the code step trades for a session.
//  - Team members (kv "members"): people the owner invites to their account, each with their own
//    email, password and two-step sign-in. "approver" can do the day-to-day work and answer
//    decisions but not billing, the team or the rules; "viewer" sees everything and changes nothing.

import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Services } from '../services.ts';
import type { Owner } from '../domain/types.ts';
import { verifyTotp } from './totp.ts';
import { RateLimiter } from './guard.ts';

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

export const SESSION_COOKIE = 'kh_session';
export const SESSION_TTL_MS = 30 * DAY;
/** A session is extended (and its cookie re-sent) at most this often. */
export const SESSION_REFRESH_MS = DAY;
export const LINK_TTL_MS = 7 * DAY;
export const RESET_TTL_MS = HOUR;
export const MIN_PASSWORD = 10;
export const MAX_PASSWORD = 200;

/* ---------------- passwords ---------------- */

const SCRYPT = { N: 16_384, r: 8, p: 1, keylen: 64 };

function scryptAsync(password: string, salt: Buffer, keylen: number, o: { N: number; r: number; p: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password.normalize('NFKC'), salt, keylen, { ...o, maxmem: 64 * 1024 * 1024 }, (e, key) => (e ? reject(e) : resolve(key))));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, SCRYPT.keylen, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

// Used when there is no account (or no password yet), so a wrong email takes as long as a wrong password.
let dummyHash: Promise<string> | undefined;

/** True when the password matches. Always does the full scrypt work, even with no stored hash. */
export async function verifyPassword(password: string, stored: string | undefined): Promise<boolean> {
  const real = !!stored && stored.startsWith('scrypt$');
  const h = real ? stored! : await (dummyHash ??= hashPassword(randomBytes(12).toString('hex')));
  const [, n, r, p, salt, key] = h.split('$');
  const want = Buffer.from(key ?? '', 'base64url');
  if (!want.length) return false;
  try {
    const got = await scryptAsync(String(password), Buffer.from(salt ?? '', 'base64url'), want.length, { N: Number(n), r: Number(r), p: Number(p) });
    return timingSafeEqual(got, want) && real;
  } catch {
    return false; // a damaged hash never signs anyone in
  }
}

/** Plain-words problem with a new password, or undefined when it's fine. */
export function passwordProblem(password: unknown, email?: string): string | undefined {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters. A short sentence is easy to remember.`;
  if (password.length > MAX_PASSWORD) return `Use ${MAX_PASSWORD} characters or fewer.`;
  if (!password.trim()) return 'Use some letters or numbers, not just spaces.';
  if (email && password.trim().toLowerCase() === email.trim().toLowerCase()) return "Your password can't be your email address.";
  if (/^(.)\1+$/.test(password)) return "That's too easy to guess. Try a short sentence.";
  return undefined;
}

/** The owner record without sign-in secrets: use this whenever an owner goes into a response. */
export function withoutSecrets(o: Owner): Omit<Owner, 'passwordHash'>;
export function withoutSecrets(o: Owner | undefined): Omit<Owner, 'passwordHash'> | undefined;
export function withoutSecrets(o: Owner | undefined): Omit<Owner, 'passwordHash'> | undefined {
  if (!o) return undefined;
  const { passwordHash: _h, totpSecret: _t, totpPending: _p, totpLastStep: _l, ...rest } = o;
  return rest;
}

/* ---------------- team members ---------------- */

export type Role = 'approver' | 'viewer';
export const ROLE_NAMES: Record<Role, string> = { approver: 'Can approve', viewer: 'View only' };

export interface Member {
  id: string; ownerId: string; name: string; email: string; role: Role;
  status: 'invited' | 'active'; createdAt: string;
  passwordHash?: string; passwordSetAt?: string; lastLoginAt?: string;
  totpSecret?: string; totpEnabledAt?: string; totpLastStep?: number; totpPending?: string;
}

export const membersOf = (svc: Services, ownerId: string) => svc.store.kvList<Member>('members').filter((m) => m.ownerId === ownerId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
export const getMember = (svc: Services, id: string | undefined) => (id ? svc.store.kvGet<Member>('members', id) : undefined);
export const memberByEmail = (svc: Services, email: string) => svc.store.kvList<Member>('members').find((m) => m.email.toLowerCase() === email.trim().toLowerCase());
export function saveMember(svc: Services, m: Member): Member { svc.store.kvSet('members', m.id, m); svc.store.flush(); return m; }
export function memberView(m: Member) {
  return { id: m.id, name: m.name, email: m.email, role: m.role, roleName: ROLE_NAMES[m.role], status: m.status, createdAt: m.createdAt, lastLoginAt: m.lastLoginAt ?? null, twoStep: !!m.totpSecret };
}

/** The person signing in: the owner, or one of their team members. Both have the same sign-in fields. */
export type Person = { kind: 'owner'; ownerId: string; rec: Owner } | { kind: 'member'; ownerId: string; rec: Member };

/**
 * What a team member's role can't do, as a plain sentence, or undefined when it's allowed.
 * Everyone can manage their own password, two-step sign-in and devices.
 */
export function roleProblem(role: Role | undefined, method: string, path: string): string | undefined {
  if (!role) return undefined; // the owner
  if (/^\/api\/me\/(password|two-step|sessions)/.test(path)) return undefined;
  if (method === 'GET' || method === 'HEAD') return undefined;
  if (role === 'viewer') return "You have view-only access, so you can't make changes. Ask the account owner.";
  if (/^\/api\/(billing|team|rules)\b/.test(path) || (method === 'PATCH' && path === '/api/me')) return 'Only the account owner can change billing, the team, the rules or the account details.';
  return undefined;
}

/* ---------------- tokens ---------------- */

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const newToken = () => randomBytes(32).toString('base64url');
const nowMs = (svc: Services) => svc.clock.now().getTime();
const iso = (ms: number) => new Date(ms).toISOString();

export interface SessionRec { id: string; ownerId: string; memberId?: string; createdAt: string; expiresAt: string; lastSeenAt: string; ip?: string; ua?: string }
export interface LinkRec { id: string; ownerId: string; memberId?: string; purpose: 'setup' | 'reset' | 'invite'; via: 'checkout' | 'admin' | 'forgot' | 'owner'; createdAt: string; expiresAt: string }

/* ---------------- cookies ---------------- */

export function readCookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return undefined; }
    }
  }
  return undefined;
}

const secure = (svc: Services) => /^https:/i.test(svc.cfg.publicUrl);

export function sessionCookie(svc: Services, token: string, maxAgeMs = SESSION_TTL_MS): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeMs / 1000)}${secure(svc) ? '; Secure' : ''}`;
}
export function clearedCookie(svc: Services): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure(svc) ? '; Secure' : ''}`;
}

/* ---------------- sessions ---------------- */

/** Start a session. Returns the raw token (goes only into the cookie) and the Set-Cookie value. */
export function createSession(svc: Services, ownerId: string, meta: { ip?: string; ua?: string; memberId?: string } = {}): { token: string; cookie: string; session: SessionRec } {
  const token = newToken();
  const t = nowMs(svc);
  pruneExpired(svc, 'sessions');
  const session: SessionRec = { id: sha(token), ownerId, memberId: meta.memberId, createdAt: iso(t), expiresAt: iso(t + SESSION_TTL_MS), lastSeenAt: iso(t), ip: meta.ip, ua: meta.ua?.slice(0, 200) };
  svc.store.kvSet('sessions', session.id, session);
  svc.store.flush();
  return { token, cookie: sessionCookie(svc, token), session };
}

/** The signed-in session for this request, if the cookie holds a live one. */
export function currentSession(req: IncomingMessage, svc: Services): { session: SessionRec; token: string; refreshCookie?: string } | 'invalid' | undefined {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return undefined;
  const s = svc.store.kvGet<SessionRec>('sessions', sha(token));
  const t = nowMs(svc);
  const memberGone = !!s?.memberId && getMember(svc, s.memberId)?.ownerId !== s.ownerId;
  if (!s || Date.parse(s.expiresAt) <= t || !svc.store.get('owners', s.ownerId) || memberGone) {
    if (s) svc.store.kvDelete('sessions', s.id);
    return 'invalid';
  }
  if (t - Date.parse(s.lastSeenAt) >= SESSION_REFRESH_MS) {
    const next = { ...s, lastSeenAt: iso(t), expiresAt: iso(t + SESSION_TTL_MS) };
    svc.store.kvSet('sessions', s.id, next);
    svc.store.flush();
    return { session: next, token, refreshCookie: sessionCookie(svc, token) };
  }
  return { session: s, token };
}

export function revokeSession(svc: Services, token: string): void {
  svc.store.kvDelete('sessions', sha(token));
  svc.store.flush();
}

/**
 * Sign out everywhere (password changed, or "sign out of all devices"). Without `person`, every
 * session on the account (owner and team); with it, only that person's ({ memberId: null } = the owner).
 */
export function revokeAllSessions(svc: Services, ownerId: string, exceptId?: string, person?: { memberId: string | null }): number {
  let n = 0;
  for (const s of svc.store.kvList<SessionRec>('sessions')) {
    const theirs = !person || (s.memberId ?? null) === person.memberId;
    if (s.ownerId === ownerId && s.id !== exceptId && theirs) { svc.store.kvDelete('sessions', s.id); n++; }
  }
  svc.store.flush();
  return n;
}

/** The sessions of one person on the account, newest first (the "where you're signed in" list). */
export function sessionsOf(svc: Services, ownerId: string, memberId: string | null): SessionRec[] {
  const t = nowMs(svc);
  return svc.store.kvList<SessionRec>('sessions')
    .filter((s) => s.ownerId === ownerId && (s.memberId ?? null) === memberId && Date.parse(s.expiresAt) > t)
    .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
}

function pruneExpired(svc: Services, ns: 'sessions' | 'loginLinks' | 'mfa') {
  const t = nowMs(svc);
  for (const r of svc.store.kvList<{ id: string; expiresAt: string }>(ns)) if (Date.parse(r.expiresAt) <= t) svc.store.kvDelete(ns, r.id);
}

/* ---------------- one-time links ---------------- */

export function issueLoginLink(svc: Services, ownerId: string, o: { purpose: LinkRec['purpose']; via: LinkRec['via']; ttlMs?: number; memberId?: string }): { token: string; path: string; url: string; expiresAt: string } {
  pruneExpired(svc, 'loginLinks');
  revokeLoginLinks(svc, ownerId, o.memberId ?? null);
  const token = newToken();
  const t = nowMs(svc);
  const rec: LinkRec = { id: sha(token), ownerId, memberId: o.memberId, purpose: o.purpose, via: o.via, createdAt: iso(t), expiresAt: iso(t + (o.ttlMs ?? LINK_TTL_MS)) };
  svc.store.kvSet('loginLinks', rec.id, rec);
  svc.store.flush();
  const path = `/login/link/${token}`;
  return { token, path, url: svc.cfg.publicUrl.replace(/\/$/, '') + path, expiresAt: rec.expiresAt };
}

/** A live link (not used, not expired), without using it up. */
export function peekLoginLink(svc: Services, token: string): LinkRec | undefined {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return undefined;
  const rec = svc.store.kvGet<LinkRec>('loginLinks', sha(token));
  if (!rec || Date.parse(rec.expiresAt) <= nowMs(svc) || !svc.store.get('owners', rec.ownerId)) return undefined;
  if (rec.memberId && getMember(svc, rec.memberId)?.ownerId !== rec.ownerId) return undefined; // removed from the team
  return rec;
}

/** Use a link up. Returns it if it was live. */
export function consumeLoginLink(svc: Services, token: string): LinkRec | undefined {
  const rec = peekLoginLink(svc, token);
  if (rec) { svc.store.kvDelete('loginLinks', rec.id); svc.store.flush(); }
  return rec;
}

/** Cancel unused links: the owner's own (memberId null), one member's, or (undefined) every link on the account. */
export function revokeLoginLinks(svc: Services, ownerId: string, memberId?: string | null): void {
  for (const r of svc.store.kvList<LinkRec>('loginLinks')) {
    if (r.ownerId === ownerId && (memberId === undefined || (r.memberId ?? null) === memberId)) svc.store.kvDelete('loginLinks', r.id);
  }
}

/* ---------------- two-step sign-in ---------------- */

export const MFA_TTL_MS = 10 * MIN;
export const MFA_TRIES = 5;
export interface MfaTicket { id: string; ownerId: string; memberId?: string; next: string; tries: number; expiresAt: string }

/** After the password: a short-lived ticket the code step trades for a session. */
export function issueMfaTicket(svc: Services, who: { ownerId: string; memberId?: string }, next: string): string {
  pruneExpired(svc, 'mfa');
  const token = newToken();
  svc.store.kvSet('mfa', sha(token), { id: sha(token), ownerId: who.ownerId, memberId: who.memberId, next, tries: 0, expiresAt: iso(nowMs(svc) + MFA_TTL_MS) } satisfies MfaTicket);
  svc.store.flush();
  return token;
}

export const peekMfaTicket = (svc: Services, token: unknown): MfaTicket | undefined => {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,100}$/.test(token)) return undefined;
  const t = svc.store.kvGet<MfaTicket>('mfa', sha(token));
  return t && Date.parse(t.expiresAt) > nowMs(svc) ? t : undefined;
};

/**
 * Check a code against a ticket. 'ok' uses the ticket up and records the code's step on the person;
 * 'wrong' counts a try (the fifth wrong try ends the ticket); 'expired' means start over.
 */
export function redeemMfaTicket(svc: Services, token: unknown, code: unknown): { result: 'ok'; ticket: MfaTicket } | { result: 'wrong' | 'expired' } {
  const t = peekMfaTicket(svc, token);
  if (!t) return { result: 'expired' };
  const person = t.memberId ? getMember(svc, t.memberId) : svc.store.get('owners', t.ownerId);
  const step = person && verifyTotp(person.totpSecret, code, nowMs(svc), person.totpLastStep);
  if (step === undefined || !person) {
    const tries = t.tries + 1;
    if (tries >= MFA_TRIES) svc.store.kvDelete('mfa', t.id); else svc.store.kvSet('mfa', t.id, { ...t, tries });
    svc.store.flush();
    return { result: tries >= MFA_TRIES ? 'expired' : 'wrong' };
  }
  if (t.memberId) saveMember(svc, { ...(person as Member), totpLastStep: step });
  else svc.store.update('owners', t.ownerId, { totpLastStep: step });
  svc.store.kvDelete('mfa', t.id);
  svc.store.flush();
  return { result: 'ok', ticket: t };
}

/* ---------------- CSRF ---------------- */

/** True unless Origin (or, without it, Referer) names another website. */
export function sameOrigin(req: IncomingMessage, svc: Services): boolean {
  const ok = new Set<string>();
  try { ok.add(new URL(svc.cfg.publicUrl).host.toLowerCase()); } catch { /* bad PUBLIC_URL: rely on Host */ }
  if (req.headers.host) ok.add(String(req.headers.host).toLowerCase());
  const from = req.headers.origin ?? req.headers.referer;
  if (!from) return true;
  try { return ok.has(new URL(String(from)).host.toLowerCase()); } catch { return false; }
}

/** Why a cookie-signed-in request that changes something is refused, or undefined when it's fine. */
export function csrfProblem(req: IncomingMessage, svc: Services): string | undefined {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  if (String(req.headers['x-keyhelm'] ?? '') !== '1') return 'Missing the X-KeyHelm header. Refresh the page and try again.';
  if (!sameOrigin(req, svc)) return 'This request came from another website, so it was blocked.';
  return undefined;
}

export type AuthResult =
  | { ownerId: string; via: 'bearer' | 'session'; sessionId?: string; setCookie?: string; memberId?: string; role?: Role }
  | { status: 401 | 403; error: string; /** counts toward the failed sign-in limit */ guess: boolean; setCookie?: string };

/** Cookie sign-in for the owner API (server.ts ownerOf falls back to this when there's no bearer token). */
export function sessionAuth(req: IncomingMessage, svc: Services): AuthResult {
  const cur = currentSession(req, svc);
  if (!cur) return { status: 401, error: 'Please sign in.', guess: false };
  if (cur === 'invalid') return { status: 401, error: 'Your session ended. Please sign in again.', guess: true, setCookie: clearedCookie(svc) };
  const problem = csrfProblem(req, svc);
  if (problem) return { status: 403, error: problem, guess: false };
  const member = getMember(svc, cur.session.memberId);
  return { ownerId: cur.session.ownerId, via: 'session', sessionId: cur.session.id, setCookie: cur.refreshCookie, memberId: member?.id, role: member?.role };
}

/* ---------------- login limits ---------------- */

const envN = (v: string | undefined, d: number) => (v && Number(v) > 0 ? Number(v) : d);
const makeLimits = () => ({
  /** Sign-in, reset and link attempts from one IP address. */
  ip: new RateLimiter({ capacity: envN(process.env.RL_LOGIN_IP_PER_HOUR, 30), perMs: HOUR }),
  /** Sign-in and reset attempts for one email address. */
  email: new RateLimiter({ capacity: envN(process.env.RL_LOGIN_EMAIL_PER_HOUR, 10), perMs: HOUR }),
});
export const LOGIN_LIMIT = makeLimits();
/** Tests: start the counters over. */
export function resetLoginLimits(): void { Object.assign(LOGIN_LIMIT, makeLimits()); }

/** Where to go after signing in: only a path on this site (no open redirects). */
export function safeNext(next: unknown, fallback = '/app'): string {
  const s = typeof next === 'string' ? next.trim() : '';
  return /^\/(?![/\\])[\w\-./?=&%#]*$/.test(s) && !s.startsWith('/login') ? s : fallback;
}

/** Email goes out only when Postmark is set up (POSTMARK_TOKEN + EMAIL_FROM, same as src/services.ts). */
export const emailConfigured = () => !!(process.env.POSTMARK_TOKEN && process.env.EMAIL_FROM);
