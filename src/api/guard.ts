// Protection and speed for the HTTP server, with Node built-ins only.
//
//  - RateLimiter: token buckets per key (IP address, owner, phone number). Stops floods
//    of requests and runaway AI usage. In memory, so each server instance counts on its
//    own; when the app runs on more than one instance, move the counters to Redis
//    (see docs/SCALING.md).
//  - StaticCache: pages and files are read from disk once, pre-compressed (Brotli and
//    gzip) and served from memory with ETag and Cache-Control, so a CDN and browsers
//    can cache them and the server does almost no work per page view.
//  - securityHeaders: safe defaults for every response.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { brotliCompressSync, gzipSync, constants as zc } from 'node:zlib';

/* ---------------- rate limiting ---------------- */

export interface Limit { capacity: number; perMs: number }

/** Token bucket: `capacity` requests, refilled evenly over `perMs`. */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();
  private limit: Limit;
  private now: () => number;
  constructor(limit: Limit, now: () => number = Date.now) {
    this.limit = limit;
    this.now = now;
    // Forget idle keys so memory stays flat under heavy, varied traffic.
    const sweep = setInterval(() => this.sweep(), 60_000);
    sweep.unref?.();
  }
  /** Returns 0 if allowed, or the number of seconds to wait. */
  take(key: string, cost = 1): number {
    const t = this.now();
    const { capacity, perMs } = this.limit;
    const rate = capacity / perMs;
    const b = this.buckets.get(key) ?? { tokens: capacity, at: t };
    b.tokens = Math.min(capacity, b.tokens + (t - b.at) * rate);
    b.at = t;
    if (b.tokens >= cost) {
      b.tokens -= cost;
      this.buckets.set(key, b);
      return 0;
    }
    this.buckets.set(key, b);
    return Math.max(1, Math.ceil((cost - b.tokens) / rate / 1000));
  }
  /** True if the key has no requests left right now (doesn't use one up). */
  blocked(key: string): boolean {
    const b = this.buckets.get(key);
    if (!b) return false;
    const { capacity, perMs } = this.limit;
    return Math.min(capacity, b.tokens + (this.now() - b.at) * (capacity / perMs)) < 1;
  }
  private sweep() {
    const t = this.now();
    for (const [k, b] of this.buckets) if (t - b.at > this.limit.perMs) this.buckets.delete(k);
  }
  get size() { return this.buckets.size; }
}

const n = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

/** Every limit in one place. Each can be changed in Railway Variables without a code change. */
export function limitsFromEnv(env: Record<string, string | undefined> = process.env) {
  return {
    /** Any request from one IP address. */
    ip: { capacity: n(env.RL_IP_PER_MIN, 300), perMs: MIN },
    /** Signup and checkout starts from one IP address (each creates Stripe objects). */
    signup: { capacity: n(env.RL_SIGNUP_PER_HOUR, 10), perMs: HOUR },
    /** Public forms (rental applications, lease signing) from one IP address. */
    publicForm: { capacity: n(env.RL_FORM_PER_HOUR, 20), perMs: HOUR },
    /** Signed-in owner API calls per owner. */
    owner: { capacity: n(env.RL_OWNER_PER_MIN, 600), perMs: MIN },
    /** Inbound texts, emails and call turns from one phone number or address (each can cost an AI reply). */
    sender: { capacity: n(env.RL_SENDER_PER_HOUR, 30), perMs: HOUR },
    senderDay: { capacity: n(env.RL_SENDER_PER_DAY, 150), perMs: DAY },
    /** Wrong passwords/tokens from one IP address. */
    authFail: { capacity: n(env.RL_AUTH_FAIL_PER_HOUR, 20), perMs: HOUR },
  };
}

/**
 * The visitor's IP address. Prefer X-Real-IP (set by the hosting proxy), else the right-most
 * X-Forwarded-For entry (the one the proxy added, which a visitor can't fake).
 * Verify on Railway after deploy (docs/SCALING.md): if every visitor showed the same
 * address, they would all share one limit.
 */
export function clientIp(req: IncomingMessage): string {
  const real = String(req.headers['x-real-ip'] ?? '').trim();
  if (real) return real;
  const xff = String(req.headers['x-forwarded-for'] ?? '');
  const last = xff.split(',').map((s) => s.trim()).filter(Boolean).pop();
  return last || req.socket.remoteAddress || 'unknown';
}

export function tooMany(res: ServerResponse, retryAfterSec: number, what = 'Too many requests') {
  if (res.headersSent) return;
  res.writeHead(429, { 'content-type': 'application/json', 'retry-after': String(retryAfterSec) });
  res.end(JSON.stringify({ error: `${what}. Please try again in ${retryAfterSec} second${retryAfterSec === 1 ? '' : 's'}.` }));
}

/** Compare secrets in constant time, so response timing can't reveal how much of a guess was right. */
export function safeEqual(a: string, b: string): boolean {
  const x = createHash('sha256').update(a).digest();
  const y = createHash('sha256').update(b).digest();
  return timingSafeEqual(x, y) && a.length === b.length;
}

/* ---------------- security headers ---------------- */

export function securityHeaders(res: ServerResponse) {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'strict-origin-when-cross-origin');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=()');
  res.setHeader('strict-transport-security', 'max-age=31536000');
}

/* ---------------- static cache ---------------- */

interface Entry { type: string; raw: Buffer; br: Buffer; gz: Buffer; etag: string; maxAge: number }

export class StaticCache {
  private entries = new Map<string, Entry>();

  put(path: string, body: string | Buffer, type: string, maxAge: number) {
    const raw = typeof body === 'string' ? Buffer.from(body) : body;
    const compressible = /text|json|svg|javascript/.test(type);
    this.entries.set(path, {
      type, raw, maxAge,
      br: compressible ? brotliCompressSync(raw, { params: { [zc.BROTLI_PARAM_QUALITY]: 11 } }) : raw,
      gz: compressible ? gzipSync(raw, { level: 9 }) : raw,
      etag: '"' + createHash('sha1').update(raw).digest('base64url').slice(0, 22) + '"',
    });
  }

  has(path: string) { return this.entries.has(path); }

  /** Serve from memory. Returns false if the path isn't cached. */
  serve(req: IncomingMessage, res: ServerResponse, path: string): boolean {
    const e = this.entries.get(path);
    if (!e) return false;
    const headers: Record<string, string> = {
      'content-type': e.type,
      etag: e.etag,
      'cache-control': e.maxAge >= 31_536_000 ? `public, max-age=${e.maxAge}, immutable` : `public, max-age=${e.maxAge}, must-revalidate`,
      vary: 'accept-encoding',
    };
    if (req.headers['if-none-match'] === e.etag) { res.writeHead(304, headers); res.end(); return true; }
    const ae = String(req.headers['accept-encoding'] ?? '');
    let body = e.raw;
    if (e.br !== e.raw && /\bbr\b/.test(ae)) { body = e.br; headers['content-encoding'] = 'br'; }
    else if (e.gz !== e.raw && /\bgzip\b/.test(ae)) { body = e.gz; headers['content-encoding'] = 'gzip'; }
    headers['content-length'] = String(body.length);
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  }
}
