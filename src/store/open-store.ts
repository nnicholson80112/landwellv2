// Picks the storage at boot.
//   DATABASE_URL set  -> Postgres (PgStore). On the first run with an empty database, an
//                        existing DATA_FILE is imported once and renamed to
//                        <file>.imported-<date>.bak.
//   otherwise         -> the JSON file (MemoryStore + DATA_FILE), with the data-version
//                        fresh start from data-version.ts.

import { existsSync, readFileSync, renameSync } from 'node:fs';
import { MemoryStore, type Snapshot, type Store } from './store.ts';
import { PgStore, type PgStoreOptions } from './pg-store.ts';
import { DATA_VERSION, freshStartIfOld } from './data-version.ts';
import { redactUrl } from './pg.ts';

export type OpenedStore = {
  store: Store;
  kind: 'postgres' | 'file';
  /** Save everything now (Postgres writes are asynchronous; the file store writes its snapshot). */
  flushNow(): Promise<void>;
  close(): Promise<void>;
};

const stamp = (d: Date) => d.toISOString().slice(0, 19).replace(/[:T]/g, '-');

export async function openStore(o: {
  dataFile: string;
  env?: Record<string, string | undefined>;
  log?: (msg: string) => void;
  /** Extra PgStore options (schema, onSuperseded, timings). */
  pg?: PgStoreOptions;
  now?: Date;
}): Promise<OpenedStore> {
  const env = o.env ?? process.env;
  const log = o.log ?? console.log;
  const now = o.now ?? new Date();
  const url = env.DATABASE_URL?.trim();

  if (!url) {
    const aside = freshStartIfOld(o.dataFile, now);
    if (aside) log(`Fresh start (data version ${DATA_VERSION}): old data moved to ${aside}`);
    const store = new MemoryStore({ file: o.dataFile });
    return { store, kind: 'file', flushNow: async () => store.flush(), close: async () => store.flush() };
  }

  log(`Storage: Postgres at ${redactUrl(url)}`);
  const store = await PgStore.open(url, { log, ...o.pg });
  const opened: OpenedStore = { store, kind: 'postgres', flushNow: () => store.flushNow(), close: () => store.close() };

  if (!store.isEmpty()) {
    const v = store.kvGet<number>('meta', 'dataVersion');
    if (v !== undefined && v < DATA_VERSION) log(`Postgres data is from data version ${v}; kept as is (fresh starts only apply to the JSON file).`);
    if (existsSync(o.dataFile)) log(`Postgres already has data, so ${o.dataFile} was not imported (it can be deleted).`);
    return opened;
  }
  if (!existsSync(o.dataFile)) return opened;

  // First run on an empty database with an old data file: bring the data over once.
  const aside = freshStartIfOld(o.dataFile, now);
  if (aside) {
    log(`Fresh start (data version ${DATA_VERSION}): the old data file was moved to ${aside} and not imported`);
    return opened;
  }
  const snap = JSON.parse(readFileSync(o.dataFile, 'utf8')) as Snapshot;
  const n = store.importSnapshot(snap);
  try {
    await store.flushNow();
  } catch (e) {
    await store.close().catch(() => {});
    throw new Error(`Importing ${o.dataFile} into Postgres failed, nothing was changed (the file is untouched): ${(e as Error).message}`);
  }
  const backup = `${o.dataFile}.imported-${stamp(now)}.bak`;
  try {
    renameSync(o.dataFile, backup);
    log(`Imported ${n.records} records and ${n.entries} engine entries from ${o.dataFile} into Postgres; the file is now ${backup}`);
  } catch (e) {
    log(`Imported ${n.records} records and ${n.entries} engine entries into Postgres, but could not rename ${o.dataFile} (${(e as Error).message}); it is ignored from now on`);
  }
  return opened;
}
