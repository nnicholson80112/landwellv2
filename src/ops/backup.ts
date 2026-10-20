// DAILY BACKUPS of the JSON data file (DATA_FILE).
//
//   Once a day: <data dir>/backups/keyhelm-YYYY-MM-DD.json (the date in TZ_DEFAULT), keeping the
//   newest 14. Copied to a temp file, checked that it reads back as JSON, then renamed into
//   place (atomic), so a backup is never half-written and a broken data file never replaces a
//   good backup. Skipped when DATABASE_URL is set (Postgres keeps the data then).
//   Never throws: every problem comes back as { status: 'failed', error }.
//
// Note: the backups sit on the same Railway volume as the data. They protect against a bad
// deploy or a damaged file, not against losing the volume (see docs/notes/ops.md).

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Env } from './state.ts';

export const BACKUP_KEEP = 14;
const NAME = /^keyhelm-(\d{4}-\d{2}-\d{2})\.json$/;

export type BackupResult =
  | { status: 'saved'; file: string; bytes: number; removed: string[] }
  | { status: 'skipped'; reason: string; file?: string }
  | { status: 'failed'; error: string };

export interface BackupFile { file: string; date: string; bytes: number; at: string }

export const backupDir = (dataFile: string) => join(dirname(dataFile), 'backups');

/** Back up the data file for `date` (YYYY-MM-DD) unless that day is already saved. */
export function backupDataFile(o: { dataFile: string; date: string; env?: Env; keep?: number; force?: boolean }): BackupResult {
  try {
    const env = o.env ?? process.env;
    if (env.DATABASE_URL?.trim()) return { status: 'skipped', reason: 'Postgres is in use (DATABASE_URL)' };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(o.date)) return { status: 'failed', error: `bad date ${o.date}` };
    if (!existsSync(o.dataFile)) return { status: 'skipped', reason: 'no data file yet' };
    const dir = backupDir(o.dataFile);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `keyhelm-${o.date}.json`);
    if (existsSync(file) && !o.force) return { status: 'skipped', reason: 'already saved today', file };
    const tmp = join(dir, `.keyhelm-${o.date}.json.tmp`);
    copyFileSync(o.dataFile, tmp);
    try {
      const snap = JSON.parse(readFileSync(tmp, 'utf8'));
      if (!snap || typeof snap !== 'object' || !snap.tables) throw new Error('missing tables');
    } catch (e) {
      try { unlinkSync(tmp); } catch { /* already gone */ }
      return { status: 'failed', error: `the data file doesn't read back as KeyHelm data (${(e as Error).message}); older backups were kept` };
    }
    renameSync(tmp, file); // atomic replace
    const removed = pruneBackups(dir, o.keep ?? BACKUP_KEEP);
    return { status: 'saved', file, bytes: statSync(file).size, removed };
  } catch (e) {
    return { status: 'failed', error: (e as Error).message };
  }
}

/** Keep the newest `keep` backups (by the date in the name); delete the rest. */
function pruneBackups(dir: string, keep: number): string[] {
  const old = readdirSync(dir).filter((f) => NAME.test(f)).sort().reverse().slice(Math.max(1, keep));
  for (const f of old) unlinkSync(join(dir, f));
  return old;
}

/** Backups on disk, newest first. Empty when there are none (or the folder can't be read). */
export function listBackups(dataFile: string): BackupFile[] {
  try {
    const dir = backupDir(dataFile);
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((f) => NAME.test(f)).sort().reverse().map((f) => {
      const st = statSync(join(dir, f));
      return { file: join(dir, f), date: f.match(NAME)![1], bytes: st.size, at: st.mtime.toISOString() };
    });
  } catch {
    return [];
  }
}
