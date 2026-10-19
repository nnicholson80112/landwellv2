// One-time fresh starts. Bump DATA_VERSION to make the next deploy set the old
// data file aside (kept as a .bak next to it) and start clean (the demo reseeds
// when SEED_DEMO is on). Used when old test data or in-flight test workflows
// shouldn't carry over, without anyone opening the server's disk.

import { existsSync, readFileSync, renameSync } from 'node:fs';

export const DATA_VERSION = 2; // 2 = KeyHelm launch: start fresh, drop pre-launch test data

/** If the file was written by an older data version, move it aside. Returns the backup path, if any. */
export function freshStartIfOld(file: string, now = new Date()): string | null {
  if (!existsSync(file)) return null;
  let version = 1;
  try {
    const snap = JSON.parse(readFileSync(file, 'utf8'));
    version = Number(snap?.kv?.meta?.dataVersion ?? 1);
  } catch {
    version = 0; // unreadable: set it aside too
  }
  if (version >= DATA_VERSION) return null;
  const backup = `${file}.v${version}-${now.toISOString().slice(0, 19).replace(/[:T]/g, '-')}.bak`;
  renameSync(file, backup);
  return backup;
}
