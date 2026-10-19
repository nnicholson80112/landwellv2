// A small PostgreSQL client on Node built-ins only (no npm packages).
//
// Speaks the PostgreSQL v3 wire protocol over node:net / node:tls:
//   - startup, ParameterStatus, BackendKeyData, ReadyForQuery
//   - password auth: cleartext, MD5 and SCRAM-SHA-256 (node:crypto)
//   - TLS via SSLRequest (sslmode prefer | require | verify-ca | verify-full)
//   - extended query protocol with parameters (Parse/Bind/Describe/Execute/Sync), text results
//   - simple query protocol (several statements at once, for DDL)
//   - ErrorResponse -> PgError with the SQLSTATE code; NoticeResponse ignored
//   - one connection, a serialized queue, automatic reconnect with backoff, clean shutdown
//
// It is deliberately small: no COPY, no LISTEN/NOTIFY, no binary formats, no pool.
// Used by PgStore (src/store/pg-store.ts).

import { connect as netConnect, isIP, type Socket } from 'node:net';
import { connect as tlsConnect, type ConnectionOptions } from 'node:tls';
import { createHash, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';

export type SslMode = 'disable' | 'prefer' | 'require' | 'verify-ca' | 'verify-full';

export type PgConfig = {
  /** Host name, IP address, or a directory holding a Unix socket (starts with '/'). */
  host: string;
  port: number;
  user: string;
  password?: string;
  database: string;
  sslmode: SslMode;
  /** Check the server certificate. Off for prefer/require (like libpq), on for verify-ca/verify-full. */
  rejectUnauthorized: boolean;
  /** PEM CA certificate(s) to trust (from sslrootcert). Node's default CAs otherwise. */
  ca?: string;
  applicationName: string;
  /** Time allowed for one connection attempt (TCP + TLS + login). */
  connectTimeoutMs: number;
};

export type PgClientOptions = {
  /** A stuck query drops the connection after this long. Default 60s. */
  queryTimeoutMs?: number;
  /** Connection attempts per request before giving up, and the backoff between them. */
  reconnect?: { attempts?: number; baseMs?: number; maxMs?: number };
  /** Called with short status lines (reconnects). */
  log?: (msg: string) => void;
};

export type PgField = { name: string; typeOid: number };
export type QueryResult<R = Record<string, any>> = { command: string; rowCount: number; fields: PgField[]; rows: R[] };

/** What a transaction callback gets: the same connection for every statement. */
export interface PgSession {
  query<R = Record<string, any>>(text: string, params?: unknown[]): Promise<QueryResult<R>>;
  simple(sql: string): Promise<QueryResult[]>;
}

/** An error reported by the server (ErrorResponse). `code` is the SQLSTATE, e.g. 23505. */
export class PgError extends Error {
  code: string;
  severity: string;
  detail?: string;
  hint?: string;
  position?: string;
  where?: string;
  schema?: string;
  table?: string;
  column?: string;
  constraint?: string;
  constructor(f: Record<string, string>) {
    super(f.M ?? 'PostgreSQL error');
    this.name = 'PgError';
    this.code = f.C ?? '';
    this.severity = f.V ?? f.S ?? 'ERROR';
    this.detail = f.D;
    this.hint = f.H;
    this.position = f.P;
    this.where = f.W;
    this.schema = f.s;
    this.table = f.t;
    this.column = f.c;
    this.constraint = f.n;
  }
}

/** Errors that retrying won't fix (bad password, missing database, unsupported auth). */
export function isPermanentConnectError(e: unknown): boolean {
  const code = (e as { code?: string })?.code ?? '';
  return code === '28P01' || code === '28000' || code === '3D000' || code === 'PG_AUTH' || code === 'PG_CONFIG';
}

const connError = (message: string, code: string) => Object.assign(new Error(message), { code });

/* ============================== URL parsing ============================== */

const SSL_MODES: SslMode[] = ['disable', 'prefer', 'require', 'verify-ca', 'verify-full'];

function parseBool(v: string | undefined | null): boolean | undefined {
  if (v == null || v === '') return undefined;
  if (/^(1|true|yes|on)$/i.test(v)) return true;
  if (/^(0|false|no|off)$/i.test(v)) return false;
  return undefined;
}

/**
 * Parse postgres:// or postgresql:// URLs (user and password URL-decoded).
 * Query parameters: sslmode, sslrootcert, sslrejectunauthorized, host (a socket directory),
 * port, user, password, dbname, application_name, connect_timeout (seconds).
 * Environment fallbacks: PGSSLMODE, PGSSLROOTCERT, DATABASE_SSL_REJECT_UNAUTHORIZED, PGUSER, PGPASSWORD.
 */
export function parsePgUrl(url: string, env: Record<string, string | undefined> = process.env): PgConfig {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw connError('DATABASE_URL is not a valid URL (expected postgres://user:password@host:5432/database)', 'PG_CONFIG');
  }
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') {
    throw connError(`DATABASE_URL must start with postgres:// or postgresql:// (got ${u.protocol}//)`, 'PG_CONFIG');
  }
  const q = u.searchParams;
  const dec = (s: string) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  let host = q.get('host') || dec(u.hostname);
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  host ||= 'localhost';
  const port = Number(q.get('port') || u.port || 5432);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw connError(`DATABASE_URL has a bad port: ${q.get('port') || u.port}`, 'PG_CONFIG');
  const user = q.get('user') || dec(u.username) || env.PGUSER || 'postgres';
  const password = q.get('password') ?? (u.password ? dec(u.password) : env.PGPASSWORD || undefined);
  const database = q.get('dbname') || dec(u.pathname.replace(/^\//, '')) || user;
  const mode = (q.get('sslmode') || env.PGSSLMODE || 'prefer').toLowerCase();
  // 'allow' tries plain first in libpq; treating it as 'prefer' is the safer reading.
  const sslmode = (mode === 'allow' ? 'prefer' : mode) as SslMode;
  if (!SSL_MODES.includes(sslmode)) throw connError(`Unknown sslmode "${mode}" (use disable, prefer, require, verify-ca or verify-full)`, 'PG_CONFIG');
  const reject = parseBool(q.get('sslrejectunauthorized')) ?? parseBool(env.DATABASE_SSL_REJECT_UNAUTHORIZED);
  const rootCert = q.get('sslrootcert') || env.PGSSLROOTCERT;
  let ca: string | undefined;
  if (rootCert && rootCert !== 'system') {
    try {
      ca = readFileSync(rootCert, 'utf8');
    } catch (e) {
      throw connError(`Could not read sslrootcert ${rootCert}: ${(e as Error).message}`, 'PG_CONFIG');
    }
  }
  const timeoutS = Number(q.get('connect_timeout') || env.PGCONNECT_TIMEOUT || 10);
  return {
    host,
    port,
    user,
    password,
    database,
    sslmode,
    rejectUnauthorized: reject ?? (sslmode === 'verify-ca' || sslmode === 'verify-full'),
    ca,
    applicationName: q.get('application_name') || 'keyhelm',
    connectTimeoutMs: Number.isFinite(timeoutS) && timeoutS > 0 ? timeoutS * 1000 : 10_000,
  };
}

/** The URL with the password hidden, for logs. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    for (const k of ['password']) if (u.searchParams.has(k)) u.searchParams.set(k, '***');
    return u.toString();
  } catch {
    return '(unparseable DATABASE_URL)';
  }
}

/* ============================== Auth helpers ============================== */

/** MD5 password message: 'md5' + md5(md5(password + user) + salt). */
export function md5Password(user: string, password: string, salt: Buffer): string {
  const inner = createHash('md5').update(password + user, 'utf8').digest('hex');
  return 'md5' + createHash('md5').update(Buffer.concat([Buffer.from(inner, 'utf8'), salt])).digest('hex');
}

/** Close enough to SASLprep for real-world passwords: ASCII passes through, the rest is NFKC-normalized. */
function saslPrep(password: string): string {
  return /^[\x20-\x7e]*$/.test(password) ? password : password.normalize('NFKC');
}

export function scramClientFirst(nonce = randomBytes(18).toString('base64'), user = '*') {
  const clientFirstBare = `n=${user.replace(/=/g, '=3D').replace(/,/g, '=2C')},r=${nonce}`;
  return { nonce, clientFirstBare, clientFirst: `n,,${clientFirstBare}` };
}

/** SCRAM-SHA-256 (RFC 5802 / RFC 7677) client-final message and the server signature to expect. */
export function scramClientFinal(password: string, nonce: string, clientFirstBare: string, serverFirst: string) {
  const attrs = new Map<string, string>();
  for (const part of serverFirst.split(',')) {
    const i = part.indexOf('=');
    if (i > 0) attrs.set(part.slice(0, i), part.slice(i + 1));
  }
  const serverNonce = attrs.get('r') ?? '';
  const salt = attrs.get('s');
  const iterations = Number(attrs.get('i'));
  if (!serverNonce.startsWith(nonce) || serverNonce.length <= nonce.length) throw connError('SCRAM: server nonce does not extend the client nonce', 'PG_AUTH');
  if (!salt || !Number.isInteger(iterations) || iterations < 1) throw connError('SCRAM: bad server-first message', 'PG_AUTH');
  const saltedPassword = pbkdf2Sync(saslPrep(password), Buffer.from(salt, 'base64'), iterations, 32, 'sha256');
  const hmac = (key: Buffer, data: string) => createHmac('sha256', key).update(data, 'utf8').digest();
  const clientKey = hmac(saltedPassword, 'Client Key');
  const storedKey = createHash('sha256').update(clientKey).digest();
  const withoutProof = `c=biws,r=${serverNonce}`;
  const authMessage = `${clientFirstBare},${serverFirst},${withoutProof}`;
  const clientSignature = hmac(storedKey, authMessage);
  const proof = Buffer.alloc(clientKey.length);
  for (let i = 0; i < proof.length; i++) proof[i] = clientKey[i] ^ clientSignature[i];
  const serverSignature = hmac(hmac(saltedPassword, 'Server Key'), authMessage).toString('base64');
  return { clientFinal: `${withoutProof},p=${proof.toString('base64')}`, serverSignature };
}

/* ============================== Values ============================== */

/**
 * JSON for Postgres jsonb. Postgres rejects \u0000 and unpaired surrogates in jsonb, which
 * JSON.stringify can produce from odd input (a pasted NUL, a cut emoji). Drop NULs and turn
 * lone surrogates into U+FFFD so one strange text can never block saving.
 */
export function toPgJson(value: unknown): string {
  const s = JSON.stringify(value) ?? 'null';
  if (!s.includes('\\u')) return s;
  return s
    .replace(/(?<!\\)((?:\\\\)*)\\u0000/g, '$1')
    .replace(/(?<!\\)((?:\\\\)*)\\ud[89a-f][0-9a-f]{2}/gi, '$1\\ufffd');
}

function encodeParam(v: unknown): Buffer | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return Buffer.from(v, 'utf8');
  if (typeof v === 'number' || typeof v === 'bigint') return Buffer.from(String(v), 'utf8');
  if (typeof v === 'boolean') return Buffer.from(v ? 't' : 'f', 'utf8');
  if (v instanceof Date) return Buffer.from(v.toISOString(), 'utf8');
  if (v instanceof Uint8Array) return Buffer.from('\\x' + Buffer.from(v).toString('hex'), 'utf8');
  return Buffer.from(toPgJson(v), 'utf8'); // objects and arrays go as JSON (use $n::jsonb)
}

/** Text-format results: a few common types become JS values; everything else stays a string. */
const PARSERS: Record<number, (s: string) => unknown> = {
  16: (s) => s === 't', // bool
  21: Number, // int2
  23: Number, // int4
  26: Number, // oid
  700: Number, // float4
  701: Number, // float8
  114: (s) => JSON.parse(s), // json
  3802: (s) => JSON.parse(s), // jsonb
};

/* ============================== Framing ============================== */

const cstr = (s: string) => Buffer.from(s + '\0', 'utf8');
const i16 = (n: number) => {
  const b = Buffer.alloc(2);
  b.writeInt16BE(n);
  return b;
};
const i32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n);
  return b;
};
function frame(type: string, parts: Buffer[]): Buffer {
  const body = parts.length === 1 ? parts[0] : Buffer.concat(parts);
  const head = Buffer.alloc(5);
  head.write(type, 0, 'latin1');
  head.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([head, body]);
}
const SSL_REQUEST = Buffer.concat([i32(8), i32(80877103)]);
const SYNC = frame('S', [Buffer.alloc(0)]);
const TERMINATE = frame('X', [Buffer.alloc(0)]);

function startupMessage(params: Record<string, string>): Buffer {
  const parts: Buffer[] = [i32(196608)]; // protocol 3.0
  for (const [k, v] of Object.entries(params)) parts.push(cstr(k), cstr(v));
  parts.push(Buffer.from([0]));
  const body = Buffer.concat(parts);
  return Buffer.concat([i32(body.length + 4), body]);
}

function extendedQuery(text: string, params: unknown[]): Buffer {
  const bind: Buffer[] = [cstr(''), cstr(''), i16(0), i16(params.length)];
  for (const p of params) {
    const v = encodeParam(p);
    if (v === null) bind.push(i32(-1));
    else bind.push(i32(v.length), v);
  }
  bind.push(i16(0)); // all results in text format
  return Buffer.concat([
    frame('P', [cstr(''), cstr(text), i16(0)]), // unnamed statement, server infers parameter types
    frame('B', bind),
    frame('D', [Buffer.from('P'), cstr('')]),
    frame('E', [cstr(''), i32(0)]),
    SYNC,
  ]);
}

function readCStrings(body: Buffer, start: number): { values: string[]; end: number } {
  const values: string[] = [];
  let off = start;
  while (off < body.length && body[off] !== 0) {
    const z = body.indexOf(0, off);
    if (z < 0) break;
    values.push(body.toString('utf8', off, z));
    off = z + 1;
  }
  return { values, end: off + 1 };
}

function errorFields(body: Buffer): Record<string, string> {
  const f: Record<string, string> = {};
  let off = 0;
  while (off < body.length && body[off] !== 0) {
    const code = String.fromCharCode(body[off]);
    const z = body.indexOf(0, off + 1);
    if (z < 0) break;
    f[code] = body.toString('utf8', off + 1, z);
    off = z + 1;
  }
  return f;
}

/* ============================== Connection ============================== */

const M = {
  Auth: 0x52, // R
  ParamStatus: 0x53, // S
  BackendKey: 0x4b, // K
  Ready: 0x5a, // Z
  Error: 0x45, // E
  Notice: 0x4e, // N
  RowDesc: 0x54, // T
  DataRow: 0x44, // D
  Complete: 0x43, // C
  Empty: 0x49, // I
  CopyIn: 0x47, // G
  CopyOut: 0x48, // H
  CopyBoth: 0x57, // W
};

type Handler = { onMessage(type: number, body: Buffer): void; onClose(err: Error): void };

function dial(cfg: PgConfig): Socket {
  const sock = cfg.host.startsWith('/')
    ? netConnect({ path: `${cfg.host.replace(/\/$/, '')}/.s.PGSQL.${cfg.port}` })
    : netConnect({ host: cfg.host, port: cfg.port });
  sock.on('error', () => {}); // errors are handled through 'close' and the listeners below; never crash on them
  return sock;
}

/** Ask for TLS; resolves with the TLS socket, or the plain socket when the server says no and that's allowed. */
function negotiateTls(sock: Socket, cfg: PgConfig): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const onError = (e: Error) => reject(e);
    const onClose = () => reject(connError('connection closed during SSL negotiation', 'ECONNRESET'));
    sock.once('error', onError);
    sock.once('close', onClose);
    sock.once('data', (b: Buffer) => {
      sock.off('error', onError);
      sock.off('close', onClose);
      // Anything after the one-byte answer would be unencrypted data injected before TLS (CVE-2021-23222).
      if (b.length !== 1) return reject(connError('unexpected data after the SSL answer', 'PG_PROTOCOL'));
      const answer = String.fromCharCode(b[0]);
      if (answer === 'N') {
        sock.pause(); // the Connection resumes it
        if (cfg.sslmode === 'prefer') return resolve(sock);
        return reject(connError(`the server does not support SSL, but sslmode=${cfg.sslmode}`, 'PG_SSL'));
      }
      if (answer !== 'S') return reject(connError(`unexpected SSL answer "${answer}"`, 'PG_PROTOCOL'));
      const opts: ConnectionOptions = { socket: sock, host: cfg.host, rejectUnauthorized: cfg.rejectUnauthorized };
      if (!isIP(cfg.host)) opts.servername = cfg.host;
      if (cfg.ca) opts.ca = cfg.ca;
      if (cfg.sslmode === 'verify-ca') opts.checkServerIdentity = () => undefined;
      const t = tlsConnect(opts);
      t.on('error', () => {}); // after the handshake the Connection's own listener takes over
      t.once('secureConnect', () => {
        t.off('error', reject);
        resolve(t);
      });
      t.once('error', reject);
    });
    sock.write(SSL_REQUEST);
  });
}

class Connection {
  readonly params = new Map<string, string>();
  pid = 0;
  closed = false;
  /** Server-sent fatal error that arrived while idle (e.g. admin shutdown), kept for the next caller. */
  lastFatal?: Error;
  private sock: Socket;
  private chunks: Buffer[] = [];
  private have = 0;
  private need = 5;
  private handler: Handler | null = null;

  constructor(sock: Socket) {
    this.sock = sock;
    sock.setNoDelay(true);
    sock.setKeepAlive(true, 30_000);
    sock.on('data', (b: Buffer) => this.onData(b));
    sock.on('error', (e) => this.close(e));
    sock.on('close', () => this.close(connError('connection to the database closed', 'ECONNRESET')));
    sock.resume();
  }

  private close(err: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.sock.destroy();
    const h = this.handler;
    this.handler = null;
    h?.onClose(this.lastFatal ?? err);
  }

  destroy(err: Error): void {
    this.close(err);
  }

  private onData(b: Buffer): void {
    this.chunks.push(b);
    this.have += b.length;
    if (this.have < this.need) return;
    const buf = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.have);
    let off = 0;
    while (buf.length - off >= 5) {
      const len = buf.readInt32BE(off + 1);
      if (len < 4) return this.close(connError('bad message from the server', 'PG_PROTOCOL'));
      if (buf.length - off < 1 + len) break;
      const type = buf[off];
      const body = buf.subarray(off + 5, off + 1 + len);
      off += 1 + len;
      this.dispatch(type, body);
      if (this.closed) return;
    }
    const rest = off < buf.length ? buf.subarray(off) : null;
    this.chunks = rest ? [rest] : [];
    this.have = rest ? rest.length : 0;
    this.need = rest && rest.length >= 5 ? 1 + rest.readInt32BE(1) : 5;
  }

  private dispatch(type: number, body: Buffer): void {
    if (type === M.Notice) return; // warnings and notices: ignored
    if (type === M.ParamStatus) {
      const { values } = readCStrings(body, 0);
      if (values.length >= 2) this.params.set(values[0], values[1]);
      return;
    }
    if (type === 0x41) return; // NotificationResponse (LISTEN/NOTIFY): not used
    if (!this.handler) {
      // A message while idle: usually a FATAL before the server closes the connection.
      if (type === M.Error) this.lastFatal = new PgError(errorFields(body));
      return;
    }
    try {
      this.handler.onMessage(type, body);
    } catch (e) {
      this.close(e as Error); // never let a bad message crash the process
    }
  }

  /** Run one request (already-framed messages) and collect results until ReadyForQuery. */
  request(messages: Buffer, timeoutMs: number): Promise<QueryResult[]> {
    if (this.closed) return Promise.reject(this.lastFatal ?? connError('connection to the database closed', 'ECONNRESET'));
    if (this.handler) return Promise.reject(connError('one request at a time on a connection (await each query in a transaction)', 'PG_BUSY'));
    return new Promise((resolve, reject) => {
      const results: QueryResult[] = [];
      let fields: PgField[] = [];
      let rows: Record<string, unknown>[] = [];
      let error: Error | undefined;
      const timer = setTimeout(() => this.close(connError(`query timed out after ${Math.round(timeoutMs / 1000)}s`, 'PG_TIMEOUT')), timeoutMs);
      const done = (err?: Error) => {
        clearTimeout(timer);
        this.handler = null;
        if (err) reject(err);
        else resolve(results);
      };
      this.handler = {
        onClose: (err) => done(error ?? err),
        onMessage: (type, body) => {
          switch (type) {
            case M.RowDesc: {
              const n = body.readInt16BE(0);
              fields = [];
              let off = 2;
              for (let i = 0; i < n; i++) {
                const z = body.indexOf(0, off);
                const name = body.toString('utf8', off, z);
                off = z + 1;
                const typeOid = body.readInt32BE(off + 6);
                off += 18;
                fields.push({ name, typeOid });
              }
              rows = [];
              return;
            }
            case M.DataRow: {
              const n = body.readInt16BE(0);
              const row: Record<string, unknown> = {};
              let off = 2;
              for (let i = 0; i < n; i++) {
                const len = body.readInt32BE(off);
                off += 4;
                const f = fields[i] ?? { name: `col${i}`, typeOid: 25 };
                if (len < 0) {
                  row[f.name] = null;
                  continue;
                }
                const s = body.toString('utf8', off, off + len);
                off += len;
                const parse = PARSERS[f.typeOid];
                row[f.name] = parse ? parse(s) : s;
              }
              rows.push(row);
              return;
            }
            case M.Complete: {
              const command = readCStrings(body, 0).values[0] ?? '';
              const last = Number(command.split(' ').pop());
              results.push({ command, rowCount: Number.isFinite(last) ? last : 0, fields, rows });
              fields = [];
              rows = [];
              return;
            }
            case M.Empty:
              results.push({ command: '', rowCount: 0, fields: [], rows: [] });
              return;
            case M.Error:
              error ??= new PgError(errorFields(body));
              return;
            case M.CopyIn:
            case M.CopyBoth:
              error ??= connError('COPY is not supported by this client', 'PG_UNSUPPORTED');
              this.sock.write(frame('f', [cstr('COPY is not supported by this client')])); // CopyFail
              return;
            case M.CopyOut:
              error ??= connError('COPY is not supported by this client', 'PG_UNSUPPORTED');
              return;
            case M.Ready:
              return done(error);
            default:
              return; // ParseComplete, BindComplete, NoData, ParameterDescription, CopyData/Done...
          }
        },
      };
      this.sock.write(messages);
    });
  }

  /** Log in. Resolves at the first ReadyForQuery. */
  startup(cfg: PgConfig): Promise<void> {
    return new Promise((resolve, reject) => {
      let scram: { nonce: string; clientFirstBare: string; serverSignature?: string } | null = null;
      const fail = (e: Error) => {
        this.handler = null;
        reject(e);
        this.close(e);
      };
      const needPassword = () => {
        if (cfg.password === undefined) throw connError('the database asked for a password, but DATABASE_URL has none', 'PG_AUTH');
        return cfg.password;
      };
      this.handler = {
        onClose: (err) => reject(err),
        onMessage: (type, body) => {
          try {
            if (type === M.Auth) {
              const code = body.readInt32BE(0);
              if (code === 0) return; // AuthenticationOk
              if (code === 3) return void this.sock.write(frame('p', [cstr(needPassword())]));
              if (code === 5) return void this.sock.write(frame('p', [cstr(md5Password(cfg.user, needPassword(), body.subarray(4, 8)))]));
              if (code === 10) {
                const mechanisms = readCStrings(body, 4).values;
                if (!mechanisms.includes('SCRAM-SHA-256')) throw connError(`unsupported SASL mechanisms: ${mechanisms.join(', ')}`, 'PG_AUTH');
                needPassword();
                const first = scramClientFirst();
                scram = { nonce: first.nonce, clientFirstBare: first.clientFirstBare };
                const resp = Buffer.from(first.clientFirst, 'utf8');
                return void this.sock.write(frame('p', [cstr('SCRAM-SHA-256'), i32(resp.length), resp]));
              }
              if (code === 11) {
                if (!scram) throw connError('SCRAM: unexpected SASLContinue', 'PG_AUTH');
                const out = scramClientFinal(needPassword(), scram.nonce, scram.clientFirstBare, body.toString('utf8', 4));
                scram.serverSignature = out.serverSignature;
                return void this.sock.write(frame('p', [Buffer.from(out.clientFinal, 'utf8')]));
              }
              if (code === 12) {
                const final = body.toString('utf8', 4);
                if (final.startsWith('e=')) throw connError(`SCRAM: server error ${final.slice(2)}`, 'PG_AUTH');
                const got = Buffer.from(final.replace(/^v=/, '').split(',')[0], 'base64');
                const want = Buffer.from(scram?.serverSignature ?? '', 'base64');
                if (!scram?.serverSignature || got.length !== want.length || !timingSafeEqual(got, want)) throw connError('SCRAM: the server signature did not match (wrong server?)', 'PG_AUTH');
                return;
              }
              throw connError(`unsupported authentication method (code ${code}); use password, md5 or scram-sha-256`, 'PG_AUTH');
            }
            if (type === M.BackendKey) {
              this.pid = body.readInt32BE(0);
              return;
            }
            if (type === M.Error) return fail(new PgError(errorFields(body)));
            if (type === M.Ready) {
              this.handler = null;
              return resolve();
            }
          } catch (e) {
            fail(e as Error);
          }
        },
      };
      this.sock.write(
        startupMessage({ user: cfg.user, database: cfg.database, application_name: cfg.applicationName, client_encoding: 'UTF8', DateStyle: 'ISO' }),
      );
    });
  }

  /** Say goodbye and close the socket (waits up to 2s). */
  async terminate(): Promise<void> {
    if (this.closed) return;
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 2_000);
      this.sock.once('close', () => {
        clearTimeout(t);
        resolve();
      });
      this.sock.end(TERMINATE);
    });
    this.close(connError('connection closed by client', 'PG_CLOSED'));
  }
}

async function openConnection(cfg: PgConfig): Promise<Connection> {
  const sock = dial(cfg);
  let ready = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<Connection>((resolve, reject) => {
      timer = setTimeout(() => {
        reject(connError(`could not connect to ${cfg.host}:${cfg.port} within ${Math.round(cfg.connectTimeoutMs / 1000)}s`, 'ETIMEDOUT'));
        sock.destroy();
      }, cfg.connectTimeoutMs);
      sock.once('error', reject);
      sock.once('connect', async () => {
        try {
          sock.off('error', reject);
          const useTls = cfg.sslmode !== 'disable' && !cfg.host.startsWith('/');
          let s: Socket = sock;
          if (useTls) {
            try {
              s = await negotiateTls(sock, cfg);
            } catch (e) {
              // libpq's 'prefer' falls back to a plain connection when TLS fails.
              if (cfg.sslmode !== 'prefer' || (e as { code?: string }).code === 'ETIMEDOUT') throw e;
              sock.destroy();
              clearTimeout(timer);
              return resolve(await openConnection({ ...cfg, sslmode: 'disable' }));
            }
          }
          const conn = new Connection(s);
          await conn.startup(cfg);
          ready = true;
          resolve(conn);
        } catch (e) {
          reject(e);
        }
      });
    });
  } finally {
    clearTimeout(timer);
    if (!ready) sock.destroy();
  }
}

/* ============================== Client ============================== */

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * One connection with a serialized queue. Requests run one at a time in order. If the
 * connection drops, the request in flight fails (it may or may not have run) and the next
 * request reconnects, retrying with backoff.
 */
export class PgClient {
  readonly config: PgConfig;
  private conn: Connection | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private failures = 0;
  private nextConnectAt = 0;
  private ending = false;
  private everConnected = false;
  private queryTimeoutMs: number;
  private attempts: number;
  private baseMs: number;
  private maxMs: number;
  private log: (msg: string) => void;

  constructor(urlOrConfig: string | PgConfig, opts: PgClientOptions = {}) {
    this.config = typeof urlOrConfig === 'string' ? parsePgUrl(urlOrConfig) : urlOrConfig;
    this.queryTimeoutMs = opts.queryTimeoutMs ?? 60_000;
    this.attempts = opts.reconnect?.attempts ?? 4;
    this.baseMs = opts.reconnect?.baseMs ?? 250;
    this.maxMs = opts.reconnect?.maxMs ?? 10_000;
    this.log = opts.log ?? (() => {});
  }

  /** Server settings reported at login (server_version, TimeZone, ...). */
  get serverParams(): ReadonlyMap<string, string> {
    return this.conn?.params ?? new Map();
  }
  /** Process id of the current server connection (0 when not connected). */
  get backendPid(): number {
    return this.conn && !this.conn.closed ? this.conn.pid : 0;
  }

  /** One statement with $1, $2... parameters (extended protocol). */
  query<R = Record<string, any>>(text: string, params: unknown[] = []): Promise<QueryResult<R>> {
    return this.exclusive((c) => this.runQuery<R>(c, text, params));
  }

  /** One or more statements without parameters (simple protocol), e.g. DDL. */
  simple(sql: string): Promise<QueryResult[]> {
    return this.exclusive((c) => c.request(frame('Q', [cstr(sql)]), this.queryTimeoutMs));
  }

  /** BEGIN ... COMMIT on one connection; ROLLBACK if fn throws. Nothing else runs in between. */
  transaction<T>(fn: (tx: PgSession) => Promise<T>): Promise<T> {
    return this.exclusive(async (c) => {
      const tx: PgSession = {
        query: <R = Record<string, any>>(text: string, params: unknown[] = []) => this.runQuery<R>(c, text, params),
        simple: (sql: string) => c.request(frame('Q', [cstr(sql)]), this.queryTimeoutMs),
      };
      await tx.simple('begin');
      try {
        const out = await fn(tx);
        const [commit] = await tx.simple('commit');
        // COMMIT of a failed transaction answers ROLLBACK instead of raising an error.
        if (commit?.command === 'ROLLBACK') throw connError('transaction was rolled back', 'PG_ROLLBACK');
        return out;
      } catch (e) {
        if (!c.closed) await tx.simple('rollback').catch(() => {});
        throw e;
      }
    });
  }

  /** Finish queued work, then close the connection. */
  async end(): Promise<void> {
    this.ending = true;
    await this.chain.catch(() => {});
    const c = this.conn;
    this.conn = null;
    if (c) await c.terminate();
  }

  /** Drop the current connection (tests, or after a timeout). The next request reconnects. */
  dropConnection(): void {
    this.conn?.destroy(connError('connection dropped', 'PG_DROPPED'));
  }

  private async runQuery<R>(c: Connection, text: string, params: unknown[]): Promise<QueryResult<R>> {
    const results = await c.request(extendedQuery(text, params), this.queryTimeoutMs);
    return (results[0] ?? { command: '', rowCount: 0, fields: [], rows: [] }) as QueryResult<R>;
  }

  private exclusive<T>(fn: (c: Connection) => Promise<T>): Promise<T> {
    const run = this.chain.then(async () => fn(await this.ensure()));
    this.chain = run.catch(() => {});
    return run;
  }

  private async ensure(): Promise<Connection> {
    if (this.ending && !this.conn) throw connError('the database client is closed', 'PG_CLOSED');
    if (this.conn && !this.conn.closed) return this.conn;
    if (this.conn) {
      this.conn = null;
      this.log('[postgres] connection lost; reconnecting');
    }
    for (let attempt = 1; ; attempt++) {
      const wait = this.nextConnectAt - Date.now();
      if (wait > 0) await sleep(wait);
      try {
        const conn = await openConnection(this.config);
        if (this.failures || this.everConnected) this.log(`[postgres] connected (${this.config.host}:${this.config.port}/${this.config.database})`);
        this.conn = conn;
        this.everConnected = true;
        this.failures = 0;
        this.nextConnectAt = 0;
        return conn;
      } catch (e) {
        this.failures++;
        this.nextConnectAt = Date.now() + Math.min(this.maxMs, this.baseMs * 2 ** (this.failures - 1));
        if (isPermanentConnectError(e) || attempt >= this.attempts || this.ending) throw e;
      }
    }
  }
}
