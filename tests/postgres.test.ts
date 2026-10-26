// Postgres storage: the wire-protocol client (src/store/pg.ts), PgStore (src/store/pg-store.ts)
// and the boot wiring (src/store/open-store.ts).
//
// Where the database comes from:
//   - PostgreSQL binaries on this machine (initdb, pg_ctl): a throwaway cluster is started in a
//     temp dir on a random port with a Unix socket in that dir. As root, it runs as the
//     'postgres' system user. This also covers MD5, cleartext, TLS, restarts and outages.
//   - PG_TEST_URL (CI sets it to a postgres:16 service): the portable tests also run there.
//   - Neither: the database tests are skipped with the reason; the pure tests still run.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { chmodSync, chownSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync, appendFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, connect as netConnect, type Socket } from 'node:net';
import { randomBytes } from 'node:crypto';
import { PgClient, PgError, md5Password, parsePgUrl, redactUrl, scramClientFinal, scramClientFirst, toPgJson } from '../src/store/pg.ts';
import { PgStore, type PgStoreOptions } from '../src/store/pg-store.ts';
import { openStore } from '../src/store/open-store.ts';
import { MemoryStore, type Store } from '../src/store/store.ts';
import { DATA_VERSION } from '../src/store/data-version.ts';
import { SystemClock } from '../src/engine/clock.ts';
import { createServices } from '../src/services.ts';
import { install } from '../src/workflows/index.ts';
import { seed } from '../src/sim/seed.ts';
import type { TableName } from '../src/domain/types.ts';
import type { AIInput, AIResult, CommunicationAI } from '../src/ai/types.ts';

const run = promisify(execFile);
const quiet = () => {};
const T = { timeout: 120_000 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean | Promise<boolean>, ms = 15_000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

/* ======================= throwaway local cluster ======================= */

type Cluster = {
  dir: string;
  port: number;
  ssl: boolean;
  url(user: 'kh_scram' | 'kh_md5' | 'kh_clear', extra?: string): string;
  adminUrl: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  destroy(): void;
};

const PW = { kh_scram: 'sc@ram:pa/ss #1', kh_md5: 'md5-secret', kh_clear: 'clear-secret' };

/** PG_BIN picks the binaries folder (PG_BIN=none: no local cluster); otherwise the usual places are searched. */
function findBinDir(): string | null {
  const dirs: string[] = [];
  if (process.env.PG_BIN) dirs.push(process.env.PG_BIN);
  else {
    // Debian/Ubuntu packages, the macOS EDB installer and Postgres.app: newest version first.
    for (const [root, sub] of [['/usr/lib/postgresql', 'bin'], ['/Library/PostgreSQL', 'bin'], ['/Applications/Postgres.app/Contents/Versions', 'bin']]) {
      if (existsSync(root)) for (const v of readdirSync(root).filter((x) => /^\d+$/.test(x)).sort((a, b) => Number(b) - Number(a))) dirs.push(`${root}/${v}/${sub}`);
    }
  }
  if (!process.env.PG_BIN) dirs.push('/usr/local/pgsql/bin', '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin');
  return dirs.find((d) => existsSync(join(d, 'initdb')) && existsSync(join(d, 'pg_ctl'))) ?? null;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

async function startCluster(bin: string): Promise<Cluster> {
  const root = process.getuid?.() === 0;
  let uid = -1;
  let gid = -1;
  if (root) {
    const id = spawnSync('id', ['-u', 'postgres'], { encoding: 'utf8' });
    const g = spawnSync('id', ['-g', 'postgres'], { encoding: 'utf8' });
    if (id.status !== 0) throw new Error("running as root and there is no 'postgres' user to run initdb as");
    uid = Number(id.stdout.trim());
    gid = Number(g.stdout.trim());
  }
  const asPg = (cmd: string, args: string[]): [string, string[]] => (root ? ['runuser', ['-u', 'postgres', '--', cmd, ...args]] : [cmd, args]);
  const runPg = async (cmd: string, args: string[]) => {
    const [c, a] = asPg(cmd, args);
    try {
      await run(c, a, { timeout: 60_000 });
    } catch (e) {
      const err = e as { stderr?: string; message: string };
      throw new Error(`${cmd} failed: ${(err.stderr || err.message).trim().slice(0, 500)}`);
    }
  };
  // A temp dir the cluster's user owns (and can reach).
  let dir = '';
  for (const base of [tmpdir(), '/tmp', '/var/tmp']) {
    try {
      const d = mkdtempSync(join(base, 'kh-pg-'));
      if (root) {
        chownSync(d, uid, gid);
        const [c, a] = asPg('test', ['-w', d]);
        if (spawnSync(c, a).status !== 0) {
          rmSync(d, { recursive: true, force: true });
          continue;
        }
      }
      dir = d;
      break;
    } catch {
      /* try the next base */
    }
  }
  if (!dir) throw new Error('no temp dir the postgres user can write to');
  const own = (p: string) => root && chownSync(p, uid, gid);
  const data = join(dir, 'data');
  const pwfile = join(dir, 'pw');
  writeFileSync(pwfile, 'admin-not-used\n');
  own(pwfile);
  await runPg(join(bin, 'initdb'), ['-D', data, '-U', 'kh_admin', `--pwfile=${pwfile}`, '--auth-local=trust', '--auth-host=scram-sha-256', '-E', 'UTF8', '--no-locale', '--no-sync']);
  writeFileSync(
    join(data, 'pg_hba.conf'),
    [
      'local all all trust',
      'host all kh_md5 127.0.0.1/32 md5',
      'host all kh_md5 ::1/128 md5',
      'host all kh_clear 127.0.0.1/32 password',
      'host all kh_clear ::1/128 password',
      'host all all 127.0.0.1/32 scram-sha-256',
      'host all all ::1/128 scram-sha-256',
      '',
    ].join('\n'),
  );
  own(join(data, 'pg_hba.conf'));
  // TLS with a self-signed certificate for "localhost" when openssl is around.
  let ssl = false;
  const crt = join(dir, 'server.crt');
  const key = join(dir, 'server.key');
  const gen = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', crt, '-days', '2', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { encoding: 'utf8' });
  if (gen.status === 0 && existsSync(crt) && existsSync(key)) {
    chmodSync(key, 0o600);
    own(key);
    own(crt);
    ssl = true;
  }
  appendFileSync(
    join(data, 'postgresql.conf'),
    [
      '',
      "listen_addresses = '127.0.0.1'",
      `unix_socket_directories = '${dir}'`,
      'fsync = off',
      'synchronous_commit = off',
      'full_page_writes = off',
      'shared_buffers = 32MB',
      'max_connections = 40',
      ssl ? `ssl = on\nssl_cert_file = '${crt}'\nssl_key_file = '${key}'` : 'ssl = off',
      '',
    ].join('\n'),
  );
  const log = join(dir, 'server.log');
  writeFileSync(log, '');
  own(log);
  let port = 0;
  const ctl = (args: string[]) => runPg(join(bin, 'pg_ctl'), ['-D', data, '-l', log, ...args]);
  const start = () => ctl(['-w', '-t', '60', '-o', `-p ${port}`, 'start']);
  for (let attempt = 1; ; attempt++) {
    port = await freePort();
    try {
      await start();
      break;
    } catch (e) {
      if (attempt >= 3) throw e;
    }
  }
  const destroy = () => {
    if (!existsSync(dir)) return;
    const [c, a] = asPg(join(bin, 'pg_ctl'), ['-D', data, '-m', 'immediate', '-w', 'stop']);
    spawnSync(c, a, { stdio: 'ignore' });
    rmSync(dir, { recursive: true, force: true });
  };
  // Never leave a server running behind: normal exit, Ctrl-C, or the runner stopping us.
  process.once('exit', destroy);
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => (destroy(), process.exit(130)));
  const adminUrl = `postgres://kh_admin@localhost:${port}/postgres?host=${encodeURIComponent(dir)}`;
  const admin = new PgClient(adminUrl, { queryTimeoutMs: 30_000 });
  try {
    await admin.simple(`create role kh_scram login password '${PW.kh_scram}';
      create role kh_clear login password '${PW.kh_clear}';
      set password_encryption = 'md5';
      create role kh_md5 login password '${PW.kh_md5}';
      reset password_encryption;`);
    await admin.simple('create database kh_test owner kh_scram');
  } catch (e) {
    destroy();
    throw e;
  } finally {
    await admin.end();
  }
  return {
    dir,
    get port() {
      return port;
    },
    ssl,
    adminUrl,
    url: (user, extra = 'sslmode=disable') => `postgres://${user}:${encodeURIComponent(PW[user])}@127.0.0.1:${port}/kh_test?${extra}`,
    start,
    stop: () => ctl(['-w', '-m', 'fast', 'stop']),
    restart: () => ctl(['-w', '-t', '60', '-m', 'fast', '-o', `-p ${port}`, 'restart']),
    destroy,
  };
}

const binDir = findBinDir();
let cluster: Cluster | null = null;
let noCluster = process.env.PG_BIN === 'none' ? 'PG_BIN=none: no local cluster' : 'PostgreSQL binaries (initdb, pg_ctl) not found; set PG_BIN or PG_TEST_URL';
if (binDir) {
  try {
    cluster = await startCluster(binDir);
  } catch (e) {
    noCluster = `could not start a throwaway PostgreSQL cluster: ${(e as Error).message}`;
  }
}
after(() => cluster?.destroy());

const targets: { name: string; url: string }[] = [];
if (cluster) targets.push({ name: 'local cluster', url: cluster.url('kh_scram') });
if (process.env.PG_TEST_URL) targets.push({ name: 'PG_TEST_URL', url: process.env.PG_TEST_URL });
const localOnly = cluster ? false : noCluster;

/* ======================= helpers ======================= */

const TABLES: TableName[] = ['owners', 'rules', 'properties', 'tenants', 'leases', 'leaseTemplates', 'vendors', 'workOrders', 'charges', 'payments', 'expenses', 'prospects', 'applications', 'showings', 'messages', 'approvals', 'audit', 'tasks', 'offers'];
const norm = <T>(x: T): T => JSON.parse(JSON.stringify(x));
function dump(store: Store) {
  const out: Record<string, unknown> = {};
  for (const t of TABLES) out[t] = store.list(t);
  for (const ns of ['runs', 'meta', 'tokens']) out[`kv:${ns}`] = store.kvList(ns);
  return norm(out);
}

let schemaN = 0;
async function withSchema(url: string, fn: (schema: string) => Promise<void>): Promise<void> {
  const schema = `kh_t${process.pid}_${++schemaN}_${randomBytes(3).toString('hex')}`;
  try {
    await fn(schema);
  } finally {
    const c = new PgClient(url);
    await c.simple(`drop schema if exists "${schema}" cascade`).catch(() => {});
    await c.end();
  }
}
const open = (url: string, schema: string, more: PgStoreOptions = {}) => PgStore.open(url, { schema, log: quiet, warn: quiet, ...more });
const owner = (id: string, name = id) => ({ id, name, email: `${id}@example.com`, phone: '+17205550100', plan: 'autopilot', timezone: 'America/Denver', createdAt: '2026-10-01T00:00:00Z' }) as any;

/** Stands in for Claude: keeps troubleshooting, so the tenant's menu choice decides (as in repair-chat.test.ts). */
class Troubleshooter implements CommunicationAI {
  name = 'stub';
  async respond(_input: AIInput): Promise<AIResult> {
    return { intent: 'maintenance_request', confidence: 0.9, reply: 'Sorry about that! Is the water coming from the faucet base or under the sink?', entities: { trade: 'plumbing', urgency: 'routine', summary: 'Kitchen sink leaking', repairAction: 'troubleshoot' }, handoff: false, provider: this.name };
  }
}

/** Forwards server bytes to the client a few bytes at a time, to exercise message reassembly. */
async function choppyProxy(host: string, port: number): Promise<{ port: number; close(): Promise<void> }> {
  const sockets = new Set<Socket>();
  const srv = createServer((client) => {
    const up = netConnect(port, host);
    sockets.add(client).add(up);
    client.setNoDelay(true);
    let queue = Promise.resolve();
    up.on('data', (d: Buffer) => {
      up.pause();
      queue = queue.then(async () => {
        for (let i = 0; i < d.length; ) {
          const n = 1 + ((i * 7) % 13);
          client.write(d.subarray(i, i + n));
          i += n;
          if (i % 64 < n) await new Promise((r) => setImmediate(r));
        }
        up.resume();
      });
    });
    client.on('data', (d) => up.write(d));
    const end = () => {
      client.destroy();
      up.destroy();
    };
    client.on('close', end).on('error', end);
    up.on('close', end).on('error', end);
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  return {
    port: (srv.address() as { port: number }).port,
    close: () => new Promise<void>((r) => {
      for (const s of sockets) s.destroy();
      srv.close(() => r());
    }),
  };
}

/* ======================= pure tests (no database) ======================= */

test('parsePgUrl: decodes user/password, host, port, database and SSL settings', () => {
  const c = parsePgUrl('postgres://us%40er:p%40ss%2Fw%20rd@db.example.com:6543/my%20db?sslmode=require&application_name=kh', {});
  assert.equal(c.user, 'us@er');
  assert.equal(c.password, 'p@ss/w rd');
  assert.equal(c.host, 'db.example.com');
  assert.equal(c.port, 6543);
  assert.equal(c.database, 'my db');
  assert.equal(c.sslmode, 'require');
  assert.equal(c.rejectUnauthorized, false, 'require encrypts but does not verify, like libpq');
  assert.equal(c.applicationName, 'kh');

  const d = parsePgUrl('postgresql://[::1]:5433/db', {});
  assert.equal(d.host, '::1');
  assert.equal(d.port, 5433);
  assert.equal(d.user, 'postgres');
  assert.equal(d.password, undefined);
  assert.equal(d.sslmode, 'prefer');

  assert.equal(parsePgUrl('postgres://u@h', {}).database, 'u');
  assert.equal(parsePgUrl('postgres://u@h/db', { PGSSLMODE: 'verify-full' }).rejectUnauthorized, true);
  assert.equal(parsePgUrl('postgres://u@h/db?sslmode=require&sslrejectunauthorized=true', {}).rejectUnauthorized, true);
  assert.equal(parsePgUrl('postgres://u@h/db?sslmode=require', { DATABASE_SSL_REJECT_UNAUTHORIZED: 'true' }).rejectUnauthorized, true);
  assert.equal(parsePgUrl('postgres://u@h/db?sslmode=verify-full&sslrejectunauthorized=false', {}).rejectUnauthorized, false);
  assert.equal(parsePgUrl('postgres://u@h/db?sslmode=disable', { PGSSLMODE: 'require' }).sslmode, 'disable', 'URL wins over PGSSLMODE');
  assert.equal(parsePgUrl('postgres:///db?host=/var/run/postgresql', {}).host, '/var/run/postgresql');
  assert.equal(parsePgUrl('postgres://u@h:5432/db?connect_timeout=3', {}).connectTimeoutMs, 3000);

  assert.throws(() => parsePgUrl('mysql://u@h/db', {}), /postgres:\/\//);
  assert.throws(() => parsePgUrl('not a url', {}), /not a valid URL/);
  assert.throws(() => parsePgUrl('postgres://u@h/db?sslmode=bogus', {}), /Unknown sslmode/);
  assert.throws(() => parsePgUrl('postgres://u@h/db?sslrootcert=/nope/ca.pem', {}), /sslrootcert/);
  const red = redactUrl('postgres://u:very-secret@h:5432/db?sslmode=require');
  assert.ok(!red.includes('very-secret') && red.includes('u:***@h'), red);
});

test('SCRAM-SHA-256 matches the RFC 7677 example', () => {
  const first = scramClientFirst('rOprNGfwEbeRWgbNEkqO', 'user');
  assert.equal(first.clientFirst, 'n,,n=user,r=rOprNGfwEbeRWgbNEkqO');
  const out = scramClientFinal('pencil', first.nonce, first.clientFirstBare, 'r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096');
  assert.equal(out.clientFinal, 'c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,p=dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=');
  assert.equal(out.serverSignature, '6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=');
  assert.throws(() => scramClientFinal('pencil', 'abc', 'n=*,r=abc', 'r=xyz,s=AAAA,i=4096'), /nonce/);
  assert.equal(md5Password('postgres', 'postgres', Buffer.from([1, 2, 3, 4])).length, 35);
  assert.match(md5Password('postgres', 'postgres', Buffer.from([1, 2, 3, 4])), /^md5[0-9a-f]{32}$/);
});

test('toPgJson drops NULs and repairs lone surrogates that jsonb would refuse', () => {
  assert.equal(toPgJson({ a: 'x\u0000y' }), '{"a":"xy"}');
  assert.equal(toPgJson({ a: '\\u0000' }), JSON.stringify({ a: '\\u0000' }), 'an escaped backslash followed by u0000 is text, not a NUL');
  assert.equal(toPgJson({ a: '\\\u0000' }), '{"a":"\\\\"}');
  assert.equal(toPgJson('\ud800'), '"\\ufffd"');
  assert.equal(toPgJson('ok 😀'), JSON.stringify('ok 😀'), 'real emoji untouched');
  assert.equal(toPgJson(undefined), 'null');
});

/* ======================= client and store, on every available database ======================= */

if (!targets.length) test('Postgres tests', { skip: noCluster }, () => {});

for (const t of targets) {
  test(`[${t.name}] client: SCRAM login, parameters, types, multi-statement DDL`, T, async () => {
    const c = new PgClient(t.url);
    try {
      const r = await c.query('select $1::int + $2::int as sum, $3::text as t, $4::jsonb as j, $5::bool as b, null::text as n, $6::text as nul', [40, 2, 'héllo, "world"', { a: [1, 'x'] }, true, null]);
      assert.deepEqual(r.rows, [{ sum: 42, t: 'héllo, "world"', j: { a: [1, 'x'] }, b: true, n: null, nul: null }]);
      assert.equal(r.command, 'SELECT 1');
      assert.ok(c.serverParams.get('server_version'), 'ParameterStatus recorded');
      const many = await c.simple('create temp table kh_tmp (id int primary key, v text); insert into kh_tmp values (1, $$a$$), (2, $$b$$); select v from kh_tmp order by id');
      assert.equal(many.length, 3);
      assert.equal(many[1].rowCount, 2);
      assert.deepEqual(many[2].rows.map((x) => x.v), ['a', 'b']);
      const big = await c.query<{ n: number; s: string }>("select n, repeat('x', 1000) as s from generate_series(1, 2000) n");
      assert.equal(big.rows.length, 2000);
      assert.equal(big.rows[1999].s.length, 1000);
    } finally {
      await c.end();
    }
  });

  test(`[${t.name}] client: server errors carry the SQLSTATE and the connection stays usable`, T, async () => {
    const c = new PgClient(t.url);
    try {
      await assert.rejects(c.query('select 1/0'), (e: unknown) => e instanceof PgError && e.code === '22012');
      await assert.rejects(c.query('selec 1'), (e: unknown) => e instanceof PgError && e.code === '42601');
      await c.simple('create temp table kh_u (id int primary key)');
      await c.query('insert into kh_u values ($1)', [1]);
      await assert.rejects(c.query('insert into kh_u values ($1)', [1]), (e: unknown) => e instanceof PgError && e.code === '23505' && e.constraint === 'kh_u_pkey');
      assert.equal((await c.query('select 7 as v')).rows[0].v, 7);
      // Transactions roll back when the callback throws.
      await assert.rejects(c.transaction(async (tx) => {
        await tx.query('insert into kh_u values (2)');
        throw new Error('nope');
      }), /nope/);
      assert.equal((await c.query('select count(*)::int as n from kh_u')).rows[0].n, 1);
      // ...and a failed statement inside a transaction fails the whole transaction.
      await assert.rejects(c.transaction(async (tx) => {
        await tx.query('insert into kh_u values (3)');
        await tx.query('insert into kh_u values (1)');
      }), (e: unknown) => (e as PgError).code === '23505');
      assert.equal((await c.query('select count(*)::int as n from kh_u')).rows[0].n, 1);
    } finally {
      await c.end();
    }
  });

  test(`[${t.name}] client: reconnects after its server session is killed`, T, async () => {
    const c = new PgClient(t.url);
    const killer = new PgClient(t.url);
    try {
      await c.query('select 1');
      const pid = c.backendPid;
      assert.ok(pid > 0);
      // A query in flight fails with the server's reason...
      const slow = c.query('select pg_sleep(10)');
      await sleep(100);
      await killer.query('select pg_terminate_backend($1)', [pid]);
      await assert.rejects(slow, (e: unknown) => (e as PgError).code === '57P01');
      // ...and the next one reconnects on its own.
      assert.equal((await c.query('select 2 as v')).rows[0].v, 2);
      assert.notEqual(c.backendPid, pid);
      // Killed while idle: same.
      const pid2 = c.backendPid;
      await killer.query('select pg_terminate_backend($1)', [pid2]);
      await waitFor(() => c.backendPid === 0, 5_000, 'idle connection to notice it was closed');
      assert.equal((await c.query('select 3 as v')).rows[0].v, 3);
    } finally {
      await c.end();
      await killer.end();
    }
  });

  const cfg = parsePgUrl(t.url);
  test(`[${t.name}] client: messages split into tiny pieces are put back together`, { ...T, skip: cfg.host.startsWith('/') && 'Unix socket URL' }, async () => {
    const proxy = await choppyProxy(cfg.host, cfg.port);
    const u = new URL(t.url);
    u.hostname = '127.0.0.1';
    u.port = String(proxy.port);
    if (cfg.sslmode === 'verify-full') u.searchParams.set('sslmode', 'verify-ca'); // the host name changes
    const c = new PgClient(u.toString());
    try {
      const r = await c.query<{ n: number; s: string; j: unknown }>("select n, repeat('é', n * 10) as s, $1::jsonb as j from generate_series(1, 120) n", [{ deep: { list: [1, 2, 3] } }]);
      assert.equal(r.rows.length, 120);
      assert.equal(r.rows[119].s, 'é'.repeat(1200));
      assert.deepEqual(r.rows[0].j, { deep: { list: [1, 2, 3] } });
    } finally {
      await c.end();
      await proxy.close();
    }
  });

  test(`[${t.name}] PgStore: insert, update, remove and kv survive a reopen, in order`, T, async () => {
    await withSchema(t.url, async (schema) => {
      const s1 = await open(t.url, schema);
      assert.ok(s1.isEmpty());
      for (const id of ['own_a', 'own_b', 'own_c']) s1.insert('owners', owner(id));
      s1.kvSet('tokens', 'tok-1', 'own_a');
      s1.kvSet('runs', 'r1', { id: 'r1', status: 'waiting', steps: { a: 1 } });
      s1.kvSet('runs', 'r2', { id: 'r2', status: 'completed' });
      await s1.flushNow();
      assert.equal(s1.unsaved(), 0);
      // Updates, a removal, a removal + add back (moves to the end), kv changes.
      s1.update('owners', 'own_a', { name: 'Alice' } as any);
      s1.remove('owners', 'own_b');
      s1.insert('owners', owner('own_b', 'Bea again'));
      s1.insert('owners', owner('own_d'));
      s1.remove('owners', 'own_d');
      s1.kvDelete('runs', 'r2');
      s1.kvSet('runs', 'r1', { id: 'r1', status: 'completed', steps: { a: 1, b: 2 } });
      s1.flush(); // what the engine calls after each piece of work
      await s1.flushNow();
      const expected = dump(s1);
      assert.deepEqual(s1.list('owners').map((o) => o.id), ['own_a', 'own_c', 'own_b']);
      await s1.close();

      const s2 = await open(t.url, schema);
      assert.deepEqual(dump(s2), expected);
      assert.deepEqual(s2.list('owners').map((o) => o.name), ['Alice', 'own_c', 'Bea again']);
      assert.equal(s2.get('owners', 'own_d'), undefined);
      assert.deepEqual(s2.kvList('runs'), [{ id: 'r1', status: 'completed', steps: { a: 1, b: 2 } }]);
      assert.equal(s2.kvGet('tokens', 'tok-1'), 'own_a');
      // Removed, something else added, then added back and updated: order follows memory.
      s2.remove('owners', 'own_a');
      s2.insert('owners', owner('own_e'));
      s2.insert('owners', owner('own_a', 'Alice 2'));
      s2.update('owners', 'own_a', { name: 'Alice 3' } as any);
      s2.insert('owners', owner('own_f'));
      const order = s2.list('owners').map((o) => o.id);
      await s2.close();
      const s3 = await open(t.url, schema);
      assert.deepEqual(s3.list('owners').map((o) => o.id), order);
      assert.equal(s3.get('owners', 'own_a')?.name, 'Alice 3');
      // Odd text that jsonb would refuse is cleaned instead of blocking saves.
      s3.insert('messages', { id: 'msg_odd', threadKey: 't', direction: 'in', channel: 'sms', body: 'nul\u0000 and half an emoji \ud83d', media: [], at: '2026-10-01T00:00:00Z' } as any);
      // Object keys come back in the order they were written (a home's facts show in the owner's order).
      s3.insert('properties', { id: 'prp_order', facts: { Zebra: '1', Apple: '2', Mid: '3' } } as any);
      await s3.flushNow();
      await s3.close();
      const s4 = await open(t.url, schema);
      assert.equal(s4.get('messages', 'msg_odd')?.body, 'nul and half an emoji �');
      assert.deepEqual(Object.keys((s4.get('properties', 'prp_order') as any).facts), ['Zebra', 'Apple', 'Mid']);
      await s4.close();
    });
  });

  test(`[${t.name}] PgStore: one flush is one transaction, in batches`, T, async () => {
    await withSchema(t.url, async (schema) => {
      const s = await open(t.url, schema, { batchRows: 100 });
      for (let i = 0; i < 1234; i++) s.insert('audit', { id: `aud_${String(i).padStart(5, '0')}`, at: '2026-10-01T00:00:00Z', actor: 'system', action: 'test', detail: 'x'.repeat(i % 50) } as any);
      for (let i = 0; i < 250; i++) s.kvSet('dedupe', `k${i}`, true);
      await s.flushNow();
      const c = new PgClient(t.url);
      const r = await c.query(`select count(*)::int as n, count(distinct updated_at)::int as tx from "${schema}".kh_records`);
      assert.deepEqual(r.rows[0], { n: 1234, tx: 1 }, 'all rows written by one transaction');
      const k = await c.query(`select count(*)::int as n, count(distinct updated_at)::int as tx from "${schema}".kh_kv`);
      assert.deepEqual(k.rows[0], { n: 250, tx: 1 });
      await c.end();
      await s.close();
      const again = await open(t.url, schema);
      assert.equal(again.list('audit').length, 1234);
      assert.equal(again.list('audit')[1233].id, 'aud_01233');
      await again.close();
    });
  });

  test(`[${t.name}] PgStore: changes made while a save is in flight are not lost, even if that save fails`, T, async () => {
    await withSchema(t.url, async (schema) => {
      const warns: string[] = [];
      const s = await open(t.url, schema, { retry: { baseMs: 50, maxMs: 200 }, warn: (m) => warns.push(m) });
      s.insert('owners', owner('own_c'));
      await s.flushNow();
      // Another session holds the writer row, so the store's next save waits inside its transaction.
      const blocker = new PgClient(t.url);
      const watcher = new PgClient(t.url);
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      let locked!: () => void;
      const isLocked = new Promise<void>((r) => (locked = r));
      const blocking = blocker.transaction(async (tx) => {
        await tx.query(`select value from "${schema}".kh_meta where key = 'writer' for update`);
        locked();
        await held;
      });
      await isLocked;
      const waiting = async () => (await watcher.query(`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like '%kh_meta%'`)).rows[0].n > 0;

      s.insert('owners', owner('own_a'));
      s.flush();
      await waitFor(waiting, 10_000, 'the save to block on the lock');
      assert.equal(s.status().writing, true);
      // Changes during the in-flight save.
      s.update('owners', 'own_a', { name: 'Changed mid-flight' } as any);
      s.insert('owners', owner('own_b'));
      s.remove('owners', 'own_c');
      s.kvSet('runs', 'r9', { id: 'r9', status: 'waiting' });
      assert.ok(s.unsaved() >= 4);

      // First round: the in-flight save dies (its server session is killed) while blocked.
      const storePid = s.client.backendPid;
      await watcher.query('select pg_terminate_backend($1)', [storePid]);
      await waitFor(() => warns.some((w) => w.includes('SAVE FAILED')), 10_000, 'the failure to be logged');
      assert.ok(s.health().failing);
      // The retry blocks on the lock again; let it through.
      await waitFor(waiting, 10_000, 'the retry to block on the lock');
      release();
      await blocking;
      await waitFor(() => s.unsaved() === 0 && !s.status().writing, 10_000, 'everything to be saved');
      assert.equal(s.health().failing, false);
      const expected = dump(s);
      await s.close();
      await blocker.end();
      await watcher.end();

      const s2 = await open(t.url, schema);
      assert.deepEqual(dump(s2), expected);
      assert.equal(s2.get('owners', 'own_a')?.name, 'Changed mid-flight');
      assert.ok(s2.get('owners', 'own_b'));
      assert.equal(s2.get('owners', 'own_c'), undefined);
      assert.deepEqual(s2.kvGet('runs', 'r9'), { id: 'r9', status: 'waiting' });
      await s2.close();
    });
  });

  test(`[${t.name}] PgStore: an item Postgres refuses is reported, the rest still saves`, T, async () => {
    await withSchema(t.url, async (schema) => {
      const warns: string[] = [];
      const s = await open(t.url, schema, { warn: (m) => warns.push(m) });
      s.insert('owners', owner('own_ok'));
      // A primary-key value too big for the index (random, so it can't be compressed): error 54000.
      s.kvSet('dedupe', randomBytes(6000).toString('hex'), true);
      s.kvSet('dedupe', 'fine', true);
      // Something JSON can't hold at all (the JSON file couldn't either).
      s.insert('owners', { ...owner('own_bigint'), weird: 10n });
      await s.flushNow();
      assert.equal(s.status().rejected, 2);
      assert.equal(s.unsaved(), 0);
      assert.ok(warns.some((w) => w.includes('SAVE REFUSED')), warns.join('\n'));
      await s.close();
      const s2 = await open(t.url, schema);
      assert.ok(s2.get('owners', 'own_ok'));
      assert.equal(s2.get('owners', 'own_bigint'), undefined);
      assert.equal(s2.kvGet('dedupe', 'fine'), true);
      await s2.close();
    });
  });

  test(`[${t.name}] PgStore: a newer copy of the app takes over; the older one stops saving`, T, async () => {
    await withSchema(t.url, async (schema) => {
      let superseded = 0;
      const a = await open(t.url, schema, { onSuperseded: () => superseded++ });
      a.insert('owners', owner('own_first'));
      await a.flushNow();
      const b = await open(t.url, schema);
      assert.ok(b.get('owners', 'own_first'), 'the newer copy sees everything saved before it started');
      a.insert('owners', owner('own_late'));
      await assert.rejects(a.flushNow(), /took over/);
      assert.equal(superseded, 1);
      assert.equal(a.health().failing, true);
      b.insert('owners', owner('own_new'));
      await b.close();
      await a.close();
      const c = await open(t.url, schema);
      assert.deepEqual(c.list('owners').map((o) => o.id), ['own_first', 'own_new']);
      await c.close();
    });
  });

  test(`[${t.name}] app on PgStore: a repair conversation continues after a restart`, T, async () => {
    await withSchema(t.url, async (schema) => {
      const boot = async () => {
        const store = await open(t.url, schema);
        const svc = createServices({ store, clock: new SystemClock(), env: {}, ai: new Troubleshooter() });
        install(svc);
        return { store, svc };
      };
      const first = await boot();
      const s = seed(first.store, {});
      const text = async (svc: typeof first.svc, body: string) => {
        svc.engine.emit('message.received', { from: s.tenant.phone, channel: 'sms', body, media: [], ownerId: s.owner.id, providerMessageId: String(Math.random()) });
        await svc.engine.drain();
      };
      await text(first.svc, 'The kitchen sink is leaking');
      assert.equal(first.store.list('workOrders').length, 0, 'still troubleshooting');
      assert.match(first.store.list('messages', (m) => m.to === s.tenant.phone).pop()!.body, /1 Send a pro/);
      const before = dump(first.store);
      await first.store.close(); // what SIGTERM does

      const second = await boot();
      assert.deepEqual(dump(second.store), before, 'everything came back');
      await text(second.svc, '1');
      const wo = second.store.list('workOrders');
      assert.equal(wo.length, 1, 'the waiting conversation resumed from Postgres');
      assert.equal(wo[0].trade, 'plumbing');
      assert.match(second.store.list('messages', (m) => m.to === s.tenant.phone).pop()!.body, /Booking a pro/);
      const after = dump(second.store);
      await second.store.close();
      const third = await open(t.url, schema);
      assert.deepEqual(dump(third), after);
      await third.close();
    });
  });

  test(`[${t.name}] boot: first run on an empty database imports DATA_FILE once`, T, async () => {
    await withSchema(t.url, async (schema) => {
      const dir = mkdtempSync(join(tmpdir(), 'kh-import-'));
      try {
        const file = join(dir, 'keyhelm.json');
        const old = new MemoryStore({ file });
        const s = seed(old, {});
        old.kvSet('meta', 'dataVersion', DATA_VERSION);
        old.kvSet('tokens', 'dev-token', s.owner.id);
        old.kvSet('runs', 'run_1', { id: 'run_1', status: 'waiting' });
        old.flush();
        const logs: string[] = [];
        const log = (m: string) => logs.push(m);
        const now = new Date('2026-10-19T12:34:56Z');
        const opened = await openStore({ dataFile: file, env: { DATABASE_URL: t.url }, log, now, pg: { schema, log: quiet } });
        assert.equal(opened.kind, 'postgres');
        assert.deepEqual(dump(opened.store), dump(old));
        assert.equal(existsSync(file), false);
        assert.ok(existsSync(`${file}.imported-2026-10-19-12-34-56.bak`));
        assert.ok(logs.some((l) => /^Imported \d+ records and 3 engine entries/.test(l)), logs.join('\n'));
        assert.ok(!logs.join('\n').includes(PW.kh_scram), 'the password never reaches the logs');
        await opened.close();

        // Next boot: data comes from Postgres; a data file lying around is left alone.
        copyFileSync(`${file}.imported-2026-10-19-12-34-56.bak`, file);
        logs.length = 0;
        const again = await openStore({ dataFile: file, env: { DATABASE_URL: t.url }, log, pg: { schema, log: quiet } });
        assert.deepEqual(dump(again.store), dump(old));
        assert.ok(existsSync(file));
        assert.ok(logs.some((l) => l.includes('was not imported')), logs.join('\n'));
        await again.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  test(`[${t.name}] boot: an old-version data file is set aside, not imported`, T, async () => {
    await withSchema(t.url, async (schema) => {
      const dir = mkdtempSync(join(tmpdir(), 'kh-import-'));
      try {
        const file = join(dir, 'keyhelm.json');
        const old = new MemoryStore({ file });
        seed(old, {});
        old.kvSet('meta', 'dataVersion', DATA_VERSION - 1);
        old.flush();
        const opened = await openStore({ dataFile: file, env: { DATABASE_URL: t.url }, log: quiet, pg: { schema, log: quiet } });
        assert.equal((opened.store as PgStore).isEmpty(), true);
        assert.equal(existsSync(file), false);
        assert.equal(readdirSync(dir).filter((f) => f.includes(`.v${DATA_VERSION - 1}-`)).length, 1);
        await opened.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
}

test('boot: without DATABASE_URL the JSON file store is used, as before', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kh-file-'));
  try {
    const file = join(dir, 'keyhelm.json');
    const opened = await openStore({ dataFile: file, env: {}, log: quiet });
    assert.equal(opened.kind, 'file');
    assert.deepEqual(opened.store.health?.(), { kind: 'file' });
    opened.store.insert('owners', owner('own_file'));
    await opened.flushNow();
    assert.ok(new MemoryStore({ file }).get('owners', 'own_file'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ======================= local cluster only ======================= */

test('auth: MD5 and cleartext logins work; a wrong password fails fast without retries', { ...T, skip: localOnly }, async () => {
  for (const user of ['kh_md5', 'kh_clear'] as const) {
    const c = new PgClient(cluster!.url(user));
    assert.equal((await c.query('select current_user as u')).rows[0].u, user);
    await c.end();
  }
  const bad = new PgClient(cluster!.url('kh_scram').replace(encodeURIComponent(PW.kh_scram), 'wrong'), { reconnect: { attempts: 5, baseMs: 1_000 } });
  const t0 = Date.now();
  await assert.rejects(bad.query('select 1'), (e: unknown) => (e as PgError).code === '28P01');
  assert.ok(Date.now() - t0 < 900, 'no retry loop on a bad password');
  await bad.end();
  const noPw = new PgClient(`postgres://kh_scram@127.0.0.1:${cluster!.port}/kh_test?sslmode=disable`);
  await assert.rejects(noPw.query('select 1'), /has none/);
  await noPw.end();
});

test('Unix socket connections work (trust auth)', { ...T, skip: localOnly }, async () => {
  const c = new PgClient(cluster!.adminUrl);
  assert.equal((await c.query('select current_user as u')).rows[0].u, 'kh_admin');
  await c.end();
});

test('TLS: require encrypts; verify-full and verify-ca check the certificate', { ...T, skip: localOnly || (!cluster!.ssl && 'openssl not available') }, async () => {
  const ssl = async (url: string) => {
    const c = new PgClient(url, { reconnect: { attempts: 1 } });
    try {
      return (await c.query('select ssl from pg_stat_ssl where pid = pg_backend_pid()')).rows[0].ssl;
    } finally {
      await c.end();
    }
  };
  const crt = join(cluster!.dir, 'server.crt');
  const base = cluster!.url('kh_scram', '');
  const viaLocalhost = base.replace('127.0.0.1', 'localhost');
  assert.equal(await ssl(base + 'sslmode=require'), true);
  assert.equal(await ssl(base + 'sslmode=prefer'), true, 'prefer uses TLS when the server offers it');
  assert.equal(await ssl(base + 'sslmode=disable'), false);
  assert.equal(await ssl(`${viaLocalhost}sslmode=verify-full&sslrootcert=${encodeURIComponent(crt)}`), true);
  assert.equal(await ssl(`${base}sslmode=verify-ca&sslrootcert=${encodeURIComponent(crt)}`), true, 'verify-ca skips the host name');
  await assert.rejects(ssl(`${base}sslmode=verify-full&sslrootcert=${encodeURIComponent(crt)}`), /localhost|IP|altnames/i, 'host name must match for verify-full');
  await assert.rejects(ssl(base + 'sslmode=verify-full'), /self.signed|certificate/i, 'self-signed is refused without the CA');
  await assert.rejects(ssl(base + 'sslmode=require&sslrejectunauthorized=true'), /self.signed|certificate/i);
});

test('client: survives a server restart and waits for a server that is coming back', { ...T, skip: localOnly }, async () => {
  const c = new PgClient(cluster!.url('kh_scram'), { reconnect: { attempts: 60, baseMs: 100, maxMs: 300 } });
  try {
    assert.equal((await c.query('select 1 as v')).rows[0].v, 1);
    await cluster!.restart();
    assert.equal((await c.query('select 2 as v')).rows[0].v, 2);
    await cluster!.stop();
    const pending = c.query('select 3 as v');
    await sleep(800);
    await cluster!.start();
    assert.equal((await pending).rows[0].v, 3);
  } finally {
    await c.end();
  }
});

test('PgStore: keeps changes through a database outage and saves them when it is back', { ...T, skip: localOnly }, async () => {
  const url = cluster!.url('kh_scram');
  await withSchema(url, async (schema) => {
    const warns: string[] = [];
    const s = await open(url, schema, { retry: { baseMs: 100, maxMs: 400 }, client: { reconnect: { attempts: 2, baseMs: 50, maxMs: 100 } }, warn: (m) => warns.push(m) });
    s.insert('owners', owner('own_before'));
    await s.flushNow();
    await cluster!.stop();
    try {
      s.insert('owners', owner('own_during'));
      s.kvSet('runs', 'r_during', { id: 'r_during', status: 'waiting' });
      s.flush();
      await waitFor(() => warns.filter((w) => w.includes('SAVE FAILED')).length >= 2, 15_000, 'failed saves to be retried and logged');
      assert.match(warns[0], /safe in memory but NOT in the database yet/);
      assert.equal(s.health().failing, true);
      assert.ok((s.health().unsaved ?? 0) >= 2);
      assert.equal(s.get('owners', 'own_during')?.id, 'own_during', 'the app keeps working from memory');
    } finally {
      await cluster!.start();
    }
    await waitFor(() => s.unsaved() === 0 && !s.status().writing, 20_000, 'the retry to save everything');
    assert.equal(s.health().failing, false);
    await s.close();
    const s2 = await open(url, schema);
    assert.deepEqual(s2.list('owners').map((o) => o.id), ['own_before', 'own_during']);
    assert.deepEqual(s2.kvGet('runs', 'r_during'), { id: 'r_during', status: 'waiting' });
    await s2.close();
  });
});
