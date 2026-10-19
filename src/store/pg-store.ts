// Durable storage on Postgres, with the same synchronous Store interface as MemoryStore.
//
// How it works:
//   - open() creates the tables if missing and loads everything into memory.
//     Reads never touch the database; the app keeps working at memory speed.
//   - Every change marks its record (or engine entry) as unsaved. flush(), which the
//     engine calls after each piece of work, starts ONE transaction that deletes and
//     upserts all unsaved items in batches. A timer also flushes every couple of seconds.
//   - Changes made while a save is in flight wait for the next save; nothing is lost.
//   - If a save fails, its items go back on the unsaved list and the save is retried with
//     backoff, logging loudly each time. flushNow() saves immediately and waits.
//   - A copy of the app that starts later takes over: older copies stop saving (no split brain).
//
// Tables (created automatically; also in db/schema.sql):
//   kh_records(tbl, id, data jsonb, updated_at, seq)  one row per record (owners, leases, ...)
//   kh_kv(ns, key, value jsonb, updated_at, seq)      engine state (workflow runs, codes, tokens)
//   kh_meta(key, value, updated_at)                   which copy of the app is the writer
// `seq` keeps the original insertion order, so lists come back in the same order after a restart.

import { MemoryStore, type Snapshot, type StoreHealth } from './store.ts';
import { PgClient, PgError, isPermanentConnectError, toPgJson, type PgClientOptions, type PgSession } from './pg.ts';

export type PgStoreOptions = {
  /** Put the tables in this schema (created if missing). Default: the connection's search_path (public). */
  schema?: string;
  /** Safety flush interval. Default 2000 ms. */
  flushIntervalMs?: number;
  /** Backoff between failed saves. Default 500 ms doubling to 30 s. */
  retry?: { baseMs?: number; maxMs?: number };
  /** Items per statement and bytes per statement. Defaults 500 and 4 MB. */
  batchRows?: number;
  batchBytes?: number;
  /** How long open() keeps trying to reach the database. Default 60 s. */
  bootTimeoutMs?: number;
  log?: (msg: string) => void;
  /** Loud problems (failed saves). Default console.error. */
  warn?: (msg: string) => void;
  /** Called once if a newer copy of the app takes over the database. */
  onSuperseded?: () => void;
  client?: PgClientOptions;
};

/** Unsaved state of one key: written, removed, or removed and added back (gets a new position). */
const SET = 0;
const REMOVED = 1;
const READDED = 2;
type Pending = Map<string, Map<string, number>>; // group (table or namespace) -> key -> state

function mark(m: Map<string, number>, key: string, st: number): void {
  const prev = m.get(key);
  if (prev === undefined) m.set(key, st);
  else if (st === SET) {
    if (prev === REMOVED) {
      m.delete(key); // added back after a removal: it moves to the end, like the in-memory Map
      m.set(key, READDED);
    }
  } else if (st === REMOVED) m.set(key, REMOVED);
  else {
    m.delete(key);
    m.set(key, READDED);
  }
}

/** Put the keys of a failed save back in front of the newer changes. */
function mergePending(older: Pending, newer: Pending): Pending {
  const out: Pending = new Map();
  for (const src of [older, newer]) {
    for (const [group, keys] of src) {
      let m = out.get(group);
      if (!m) out.set(group, (m = new Map()));
      for (const [key, st] of keys) mark(m, key, st);
    }
  }
  return out;
}

const countPending = (p: Pending) => {
  let n = 0;
  for (const m of p.values()) n += m.size;
  return n;
};

type Batch = { rows: Pending; kv: Pending; delRows: string[]; upRows: string[]; delKv: string[]; upKv: string[]; size: number };

const SUPERSEDED = 'KH_SUPERSEDED';
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Errors about the data itself (bad text, too large): retrying the same batch would fail forever. */
const isDataError = (e: unknown) => e instanceof PgError && /^(22|54)/.test(e.code);
const q = (ident: string) => '"' + ident.replace(/"/g, '""') + '"';

export class PgStore extends MemoryStore {
  readonly client: PgClient;
  private opts: PgStoreOptions;
  private pRows: Pending = new Map();
  private pKv: Pending = new Map();
  private writing: Promise<void> | null = null;
  private inFlight = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private interval: ReturnType<typeof setInterval> | undefined;
  private failures = 0;
  private lastError?: string;
  private lastSavedAt?: string;
  private rejected = 0;
  private generation = '';
  private superseded = false;
  private closed = false;
  private log: (msg: string) => void;
  private warn: (msg: string) => void;
  private sql: { ddl: string; claim: string; loadRows: string; loadKv: string; writer: string; upRows: string; delRows: string; upKv: string; delKv: string };

  private constructor(client: PgClient, opts: PgStoreOptions) {
    super();
    this.client = client;
    this.opts = opts;
    this.log = opts.log ?? console.log;
    this.warn = opts.warn ?? console.error;
    const p = opts.schema ? q(opts.schema) + '.' : '';
    const R = `${p}kh_records`;
    const K = `${p}kh_kv`;
    const META = `${p}kh_meta`;
    const items = 'jsonb_array_elements($1::jsonb) with ordinality as x(v, n)';
    this.sql = {
      ddl: `${opts.schema ? `create schema if not exists ${q(opts.schema)};` : ''}
create table if not exists ${R} (tbl text not null, id text not null, data jsonb not null, updated_at timestamptz not null default now(), seq bigserial, primary key (tbl, id));
create index if not exists kh_records_seq on ${R} (seq);
create table if not exists ${K} (ns text not null, key text not null, value jsonb not null, updated_at timestamptz not null default now(), seq bigserial, primary key (ns, key));
create index if not exists kh_kv_seq on ${K} (seq);
create table if not exists ${META} (key text primary key, value text not null, updated_at timestamptz not null default now());`,
      claim: `insert into ${META} (key, value) values ('writer', '1') on conflict (key) do update set value = (${META}.value::bigint + 1)::text, updated_at = now() returning value`,
      writer: `select value from ${META} where key = 'writer' for update`,
      loadRows: `select tbl, id, data from ${R} order by seq`,
      loadKv: `select ns, key, value from ${K} order by seq`,
      upRows: `insert into ${R} (tbl, id, data, updated_at) select x.v->>0, x.v->>1, x.v->2, now() from ${items} order by x.n on conflict (tbl, id) do update set data = excluded.data, updated_at = excluded.updated_at`,
      delRows: `delete from ${R} r using jsonb_array_elements($1::jsonb) as x(v) where r.tbl = x.v->>0 and r.id = x.v->>1`,
      upKv: `insert into ${K} (ns, key, value, updated_at) select x.v->>0, x.v->>1, x.v->2, now() from ${items} order by x.n on conflict (ns, key) do update set value = excluded.value, updated_at = excluded.updated_at`,
      delKv: `delete from ${K} k using jsonb_array_elements($1::jsonb) as x(v) where k.ns = x.v->>0 and k.key = x.v->>1`,
    };
  }

  /** Connect (retrying while the database starts), create tables if missing, load everything. */
  static async open(url: string, opts: PgStoreOptions = {}): Promise<PgStore> {
    const store = new PgStore(new PgClient(url, { log: opts.log ?? console.log, ...opts.client }), opts);
    try {
      await store.boot();
    } catch (e) {
      await store.client.end().catch(() => {});
      throw e;
    }
    return store;
  }

  private async boot(): Promise<void> {
    const deadline = Date.now() + (this.opts.bootTimeoutMs ?? 60_000);
    for (let attempt = 1; ; attempt++) {
      try {
        await this.client.simple(this.sql.ddl);
        break;
      } catch (e) {
        const denied = e instanceof PgError && e.code === '42501';
        if (isPermanentConnectError(e) || denied || Date.now() >= deadline) throw e;
        this.log(`[postgres] waiting for the database (${errMsg(e)})`);
        await sleep(Math.min(5_000, 500 * attempt));
      }
    }
    // Claim the writer slot and load in one transaction: an older copy still running can't
    // save anything after this point, and everything it saved before is in what we load.
    let records = 0;
    let entries = 0;
    await this.client.transaction(async (tx) => {
      const claim = await tx.query<{ value: string }>(this.sql.claim);
      this.generation = String(claim.rows[0]?.value);
      const rows = await tx.query<{ tbl: string; id: string; data: unknown }>(this.sql.loadRows);
      for (const r of rows.rows) (this.tables[r.tbl] ??= new Map()).set(r.id, r.data);
      const kv = await tx.query<{ ns: string; key: string; value: unknown }>(this.sql.loadKv);
      for (const r of kv.rows) (this.kv[r.ns] ??= new Map()).set(r.key, r.value);
      records = rows.rows.length;
      entries = kv.rows.length;
    });
    const every = this.opts.flushIntervalMs ?? 2_000;
    this.interval = setInterval(() => this.flush(), every);
    this.interval.unref();
    const c = this.client.config;
    this.log(`[postgres] storage ready on ${c.host}:${c.port}/${c.database}${this.opts.schema ? ` (schema ${this.opts.schema})` : ''}: loaded ${records} records and ${entries} engine entries`);
  }

  /* ---------------------------------------------------------------- changes */

  protected changed(kind: 'row' | 'kv', group: string, key: string, removed: boolean): void {
    const p = kind === 'row' ? this.pRows : this.pKv;
    let m = p.get(group);
    if (!m) p.set(group, (m = new Map()));
    mark(m, key, removed ? REMOVED : SET);
  }

  /** True when nothing has been loaded or written yet. */
  isEmpty(): boolean {
    for (const m of Object.values(this.tables)) if (m.size) return false;
    for (const m of Object.values(this.kv)) if (m.size) return false;
    return true;
  }

  /** Load a JSON snapshot (the DATA_FILE format) into memory and mark it all unsaved. */
  importSnapshot(snap: Snapshot): { records: number; entries: number } {
    let records = 0;
    let entries = 0;
    for (const [t, rows] of Object.entries(snap.tables ?? {})) {
      for (const [id, row] of Object.entries(rows ?? {})) {
        (this.tables[t] ??= new Map()).set(id, row);
        this.changed('row', t, id, false);
        records++;
      }
    }
    for (const [ns, vals] of Object.entries(snap.kv ?? {})) {
      for (const [key, value] of Object.entries(vals ?? {})) {
        (this.kv[ns] ??= new Map()).set(key, value);
        this.changed('kv', ns, key, false);
        entries++;
      }
    }
    return { records, entries };
  }

  /** Changes not yet saved, including a save in flight. */
  unsaved(): number {
    return this.pending() + this.inFlight;
  }
  private pending(): number {
    return countPending(this.pRows) + countPending(this.pKv);
  }

  health(): StoreHealth {
    return { kind: 'postgres', unsaved: this.unsaved(), failing: this.failures > 0 || this.superseded, lastSavedAt: this.lastSavedAt };
  }

  /** Details for tests and logs. */
  status() {
    return { unsaved: this.unsaved(), writing: !!this.writing, failures: this.failures, lastError: this.lastError, lastSavedAt: this.lastSavedAt, rejected: this.rejected, superseded: this.superseded };
  }

  /* ---------------------------------------------------------------- saving */

  /** Start a save if anything is unsaved (sync; the engine calls it after each piece of work). */
  flush(): void {
    if (this.closed || this.superseded || this.writing || this.retryTimer || !this.pending()) return;
    this.startWrite().catch(() => {}); // failures are logged and retried in commitBatch
  }

  /** Save everything now and wait. Throws if the save fails (changes stay queued and retried). */
  async flushNow(): Promise<void> {
    for (let i = 0; i < 50; i++) {
      if (this.superseded) throw Object.assign(new Error('a newer copy of the app took over the database; this copy no longer saves'), { code: SUPERSEDED });
      if (this.writing) {
        await this.writing.catch(() => {});
        continue;
      }
      if (!this.pending()) return;
      this.clearRetry();
      await this.startWrite();
    }
    throw new Error('flushNow: changes kept arriving; try again');
  }

  /** Save, stop timers and close the connection. */
  async close(): Promise<void> {
    if (this.closed) return;
    try {
      if (!this.superseded) await this.flushNow();
    } finally {
      this.closed = true;
      clearInterval(this.interval);
      this.clearRetry();
      await this.client.end().catch(() => {});
    }
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  private startWrite(): Promise<void> {
    if (this.writing) return this.writing;
    const batch = this.takeBatch();
    this.inFlight = batch.size;
    this.writing = this.commitBatch(batch).finally(() => {
      this.writing = null;
      this.inFlight = 0;
      // Changes that arrived during the save go out right away (unless we're backing off).
      if (!this.retryTimer) this.flush();
    });
    return this.writing;
  }

  /** Take the unsaved keys and serialize their current values. Later changes start a new list. */
  private takeBatch(): Batch {
    const b: Batch = { rows: this.pRows, kv: this.pKv, delRows: [], upRows: [], delKv: [], upKv: [], size: 0 };
    this.pRows = new Map();
    this.pKv = new Map();
    const collect = (pending: Pending, source: Record<string, Map<string, any>>, del: string[], up: string[]) => {
      for (const [group, keys] of pending) {
        const m = source[group];
        for (const [key, st] of keys) {
          const value = m?.get(key);
          let item: string | undefined;
          if (value !== undefined) {
            try {
              item = toPgJson([group, key, value]);
            } catch (e) {
              // Not JSON (a BigInt, a loop): the JSON file couldn't hold it either. Say so; don't block the rest.
              this.rejected++;
              this.warn(`[postgres] SAVE REFUSED for ${group}/${key}: ${errMsg(e)}; it stays in memory only until it changes again`);
              continue;
            }
          }
          if (st !== SET || value === undefined) del.push(toPgJson([group, key]));
          if (item) up.push(item);
          b.size++;
        }
      }
    };
    collect(b.rows, this.tables, b.delRows, b.upRows);
    collect(b.kv, this.kv, b.delKv, b.upKv);
    return b;
  }

  private chunks(items: string[]): string[] {
    const maxRows = this.opts.batchRows ?? 500;
    const maxBytes = this.opts.batchBytes ?? 4_000_000;
    const out: string[] = [];
    let cur: string[] = [];
    let bytes = 0;
    for (const it of items) {
      if (cur.length && (cur.length >= maxRows || bytes + it.length > maxBytes)) {
        out.push('[' + cur.join(',') + ']');
        cur = [];
        bytes = 0;
      }
      cur.push(it);
      bytes += it.length + 1;
    }
    if (cur.length) out.push('[' + cur.join(',') + ']');
    return out;
  }

  /** One transaction. In careful mode each item gets a savepoint so one bad item can't block the rest. */
  private async commit(b: Batch, careful: boolean): Promise<string[]> {
    const refused: string[] = [];
    await this.client.transaction(async (tx) => {
      const w = await tx.query<{ value: string }>(this.sql.writer);
      if (String(w.rows[0]?.value) !== this.generation) throw Object.assign(new Error('another copy of the app took over the database'), { code: SUPERSEDED });
      const run = async (sql: string, items: string[]) => {
        if (!careful) {
          for (const c of this.chunks(items)) await tx.query(sql, [c]);
          return;
        }
        for (const it of items) {
          await tx.simple('savepoint kh_item');
          try {
            await tx.query(sql, ['[' + it + ']']);
            await tx.simple('release savepoint kh_item');
          } catch (e) {
            if (!(e instanceof PgError)) throw e;
            await tx.simple('rollback to savepoint kh_item');
            refused.push(`${it.slice(0, 80)}${it.length > 80 ? '...' : ''} (${e.code} ${e.message})`);
          }
        }
      };
      await run(this.sql.delRows, b.delRows);
      await run(this.sql.upRows, b.upRows);
      await run(this.sql.delKv, b.delKv);
      await run(this.sql.upKv, b.upKv);
    });
    return refused;
  }

  private async commitBatch(b: Batch): Promise<void> {
    if (!b.size) return;
    try {
      let refused: string[] = [];
      try {
        await this.commit(b, false);
      } catch (e) {
        if (!isDataError(e)) throw e;
        // Postgres refused something in the data itself. Save item by item and report the bad ones.
        refused = await this.commit(b, true);
      }
      if (this.failures) this.log(`[postgres] saving works again after ${this.failures} failed attempt(s)`);
      this.failures = 0;
      this.lastError = undefined;
      this.lastSavedAt = new Date().toISOString();
      if (refused.length) {
        this.rejected += refused.length;
        this.warn(`[postgres] SAVE REFUSED for ${refused.length} item(s); they stay in memory only until they change again:\n  ${refused.join('\n  ')}`);
      }
    } catch (e) {
      this.pRows = mergePending(b.rows, this.pRows);
      this.pKv = mergePending(b.kv, this.pKv);
      if ((e as { code?: string }).code === SUPERSEDED) {
        this.supersede();
        throw e;
      }
      this.failures++;
      this.lastError = errMsg(e);
      const base = this.opts.retry?.baseMs ?? 500;
      const delay = Math.min(this.opts.retry?.maxMs ?? 30_000, base * 2 ** (this.failures - 1));
      this.warn(
        `[postgres] SAVE FAILED (attempt ${this.failures}): ${this.lastError}. ${this.pending()} change(s) are safe in memory but NOT in the database yet; retrying in ${(delay / 1000).toFixed(1)}s.`,
      );
      if (!this.closed) {
        this.clearRetry();
        this.retryTimer = setTimeout(() => {
          this.retryTimer = undefined;
          this.flush();
        }, delay);
      }
      throw e;
    }
  }

  private supersede(): void {
    if (this.superseded) return;
    this.superseded = true;
    clearInterval(this.interval);
    this.clearRetry();
    this.warn(`[postgres] A newer copy of the app has taken over the database. This copy stops saving (${this.pending()} change(s) not saved) and should shut down.`);
    this.opts.onSuperseded?.();
  }
}
