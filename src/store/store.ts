import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Tables, TableName } from '../domain/types.ts';

/**
 * Storage interface used by everything else. Two implementations keep the whole
 * working set in memory: MemoryStore (snapshots to a JSON file on flush) and
 * PgStore (src/store/pg-store.ts, journals changes to Postgres when DATABASE_URL is set).
 */
export interface Store {
  insert<K extends TableName>(table: K, rec: Omit<Tables[K], 'id'> & { id?: string }): Tables[K];
  get<K extends TableName>(table: K, id: string): Tables[K] | undefined;
  update<K extends TableName>(table: K, id: string, patch: Partial<Tables[K]>): Tables[K];
  list<K extends TableName>(table: K, where?: (r: Tables[K]) => boolean): Tables[K][];
  find<K extends TableName>(table: K, where: (r: Tables[K]) => boolean): Tables[K] | undefined;
  remove<K extends TableName>(table: K, id: string): void;
  /** Engine-internal key/value records (workflow runs, cursors). */
  kvGet<T>(ns: string, key: string): T | undefined;
  kvSet<T>(ns: string, key: string, value: T): void;
  kvList<T>(ns: string): T[];
  kvDelete(ns: string, key: string): void;
  flush(): void;
  /** Where data is kept and whether everything is saved (shown on /health). */
  health?(): StoreHealth;
}

export type StoreHealth = {
  kind: 'memory' | 'file' | 'postgres';
  /** Changes not yet saved to Postgres. */
  unsaved?: number;
  /** True while saving to Postgres keeps failing (changes are kept in memory and retried). */
  failing?: boolean;
  lastSavedAt?: string;
};

export const newId = (prefix = ''): string => (prefix ? prefix + '_' : '') + randomUUID().replace(/-/g, '').slice(0, 16);

const PREFIX: Record<TableName, string> = {
  owners: 'own', rules: 'rul', properties: 'prp', tenants: 'ten', leases: 'lse', leaseTemplates: 'tpl',
  vendors: 'ven', workOrders: 'wo', charges: 'chg', payments: 'pay', expenses: 'exp', prospects: 'pro',
  applications: 'app', showings: 'shw', messages: 'msg', approvals: 'apv', audit: 'aud', tasks: 'tsk', offers: 'off',
};

/** The JSON file format (DATA_FILE). */
export type Snapshot = { tables: Record<string, Record<string, unknown>>; kv: Record<string, Record<string, unknown>> };

export class MemoryStore implements Store {
  protected tables: Record<string, Map<string, any>> = {};
  protected kv: Record<string, Map<string, any>> = {};
  private file?: string;
  private dirty = false;

  constructor(opts: { file?: string } = {}) {
    this.file = opts.file;
    if (this.file && existsSync(this.file)) {
      const snap = JSON.parse(readFileSync(this.file, 'utf8')) as Snapshot;
      for (const [t, rows] of Object.entries(snap.tables)) this.tables[t] = new Map(Object.entries(rows));
      for (const [n, rows] of Object.entries(snap.kv)) this.kv[n] = new Map(Object.entries(rows));
    }
  }

  /** Called after every change; PgStore overrides it to know what to write. */
  protected changed(_kind: 'row' | 'kv', _group: string, _key: string, _removed: boolean): void {}

  private t(name: string): Map<string, any> {
    return (this.tables[name] ??= new Map());
  }
  private n(ns: string): Map<string, any> {
    return (this.kv[ns] ??= new Map());
  }

  insert<K extends TableName>(table: K, rec: Omit<Tables[K], 'id'> & { id?: string }): Tables[K] {
    const id = rec.id ?? newId(PREFIX[table]);
    const row = structuredClone({ ...rec, id }) as Tables[K];
    this.t(table).set(id, row);
    this.dirty = true;
    this.changed('row', table, id, false);
    return structuredClone(row);
  }
  get<K extends TableName>(table: K, id: string): Tables[K] | undefined {
    const r = this.t(table).get(id);
    return r ? structuredClone(r) : undefined;
  }
  update<K extends TableName>(table: K, id: string, patch: Partial<Tables[K]>): Tables[K] {
    const cur = this.t(table).get(id);
    if (!cur) throw new Error(`${table}/${id} not found`);
    const next = { ...cur, ...structuredClone(patch), id };
    this.t(table).set(id, next);
    this.dirty = true;
    this.changed('row', table, id, false);
    return structuredClone(next);
  }
  list<K extends TableName>(table: K, where?: (r: Tables[K]) => boolean): Tables[K][] {
    const out: Tables[K][] = [];
    for (const r of this.t(table).values()) if (!where || where(r)) out.push(structuredClone(r));
    return out;
  }
  find<K extends TableName>(table: K, where: (r: Tables[K]) => boolean): Tables[K] | undefined {
    for (const r of this.t(table).values()) if (where(r)) return structuredClone(r);
    return undefined;
  }
  remove<K extends TableName>(table: K, id: string): void {
    if (this.t(table).delete(id)) this.changed('row', table, id, true);
    this.dirty = true;
  }
  kvGet<T>(ns: string, key: string): T | undefined {
    const v = this.n(ns).get(key);
    return v === undefined ? undefined : structuredClone(v);
  }
  kvSet<T>(ns: string, key: string, value: T): void {
    this.n(ns).set(key, structuredClone(value));
    this.dirty = true;
    this.changed('kv', ns, key, false);
  }
  kvList<T>(ns: string): T[] {
    return [...this.n(ns).values()].map((v) => structuredClone(v));
  }
  kvDelete(ns: string, key: string): void {
    if (this.n(ns).delete(key)) this.changed('kv', ns, key, true);
    this.dirty = true;
  }
  flush(): void {
    if (!this.file || !this.dirty) return;
    const snap: Snapshot = { tables: {}, kv: {} };
    for (const [t, m] of Object.entries(this.tables)) snap.tables[t] = Object.fromEntries(m);
    for (const [n, m] of Object.entries(this.kv)) snap.kv[n] = Object.fromEntries(m);
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    writeFileSync(tmp, JSON.stringify(snap));
    renameSync(tmp, this.file); // atomic replace
    this.dirty = false;
  }
  health(): StoreHealth {
    return { kind: this.file ? 'file' : 'memory' };
  }
}
