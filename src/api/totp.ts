// Two-step sign-in with an authenticator app (Google Authenticator, 1Password, Authy...), Node built-ins only.
//
//   RFC 6238 time-based codes: HMAC-SHA1, 30-second steps, 6 digits. A code from the step before or
//   after also works (phone clocks drift). Each code works once: the step it matched is remembered,
//   and a code from that step or earlier is refused.
//   Secrets are 20 random bytes, shown to the owner in base32 (what authenticator apps type in).

import { createHmac, randomBytes } from 'node:crypto';

export const STEP_SECONDS = 30;
const DIGITS = 6;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error('not base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export const newTotpSecret = () => base32Encode(randomBytes(20));

/** The code for one 30-second step. */
export function totpAt(secret: string, step: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const off = h[h.length - 1] & 15;
  const n = ((h[off] & 127) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(n % 10 ** DIGITS).padStart(DIGITS, '0');
}

export const stepOf = (ms: number) => Math.floor(ms / 1000 / STEP_SECONDS);

/**
 * The step a code matches (now, or one step either side), or undefined. `lastStep` is the step
 * of the last code accepted: that code and older ones are refused, so a code can't be used twice.
 */
export function verifyTotp(secret: string | undefined, code: unknown, nowMs: number, lastStep = -1): number | undefined {
  const c = String(code ?? '').replace(/\s/g, '');
  if (!secret || !/^\d{6}$/.test(c)) return undefined;
  const now = stepOf(nowMs);
  for (const s of [now, now - 1, now + 1]) {
    if (s > lastStep && totpAt(secret, s) === c) return s;
  }
  return undefined;
}

/** The otpauth:// address an authenticator app reads (from a QR code or a pasted link). */
export function otpauthUri(o: { issuer: string; account: string; secret: string }): string {
  const label = encodeURIComponent(`${o.issuer}:${o.account}`);
  return `otpauth://totp/${label}?secret=${o.secret}&issuer=${encodeURIComponent(o.issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}
