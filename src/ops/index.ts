// Ops wiring: what install() (src/workflows/index.ts) and the server boot block (src/api/server.ts) call.
//
//   installOps(svc)  AI-fallback alerts and new-customer alerts for this server.
//   startOps(svc)    boot: remembers the data file, then every minute (unref'd timer): past-due
//                    owners, held-back alerts, and the daily backup of the JSON file.
//   noteTick(svc)    the engine's 30-second tick ran (shown on /api/admin/status).

import type { Services } from '../services.ts';
import { localParts } from '../engine/clock.ts';
import { alertAdmin, checkPastDue, flushHeldAlerts, newCustomerAlert, watchAI } from './alerts.ts';
import { backupDataFile, backupPhotos, backupSnapshot, type BackupResult } from './backup.ts';
import { pruneLineAsks } from './lines.ts';
import { configureOps, ops, track, type OpsState } from './state.ts';

export { alertAdmin } from './alerts.ts';
export { configureOps, noteTick, ops, opsSettled, track } from './state.ts';

const WATCHED = new WeakSet<object>();

/** Called by install(): connect this server's AI and events to admin alerts. */
export function installOps(svc: Services): void {
  watchAI(svc);
  const engine = svc.engine;
  if (WATCHED.has(engine)) return;
  WATCHED.add(engine);
  // The engine has no event listeners, so ops watches emit for the one event it needs:
  // a subscription started ('owner.signed_up', from the Stripe webhook) = a new paying customer.
  const emit = engine.emit.bind(engine);
  engine.emit = (event: string, payload: Record<string, any> = {}) => {
    const started = emit(event, payload);
    if (event === 'owner.signed_up' && typeof payload.ownerId === 'string') track(svc, newCustomerAlert(svc, payload.ownerId));
    return started;
  };
}

/** The daily backup of the data and the photos (nothing to do without a data file path). */
export async function runDailyBackup(svc: Services, o: { force?: boolean } = {}): Promise<BackupResult | undefined> {
  const st = ops(svc);
  if (!st.dataFile) return undefined;
  try {
    svc.store.flush(); // the copy gets the latest changes
  } catch (e) {
    st.log(`[backup] saving before the backup failed: ${(e as Error).message}`);
  }
  const now = svc.clock.now();
  const date = localParts(now, svc.cfg.tz).date;
  const snapshot = st.storeKind === 'postgres' ? svc.store.snapshot?.bind(svc.store) : undefined;
  let r: BackupResult = snapshot
    ? backupSnapshot({ dataFile: st.dataFile, date, snapshot, force: o.force })
    : backupDataFile({ dataFile: st.dataFile, date, env: st.env, force: o.force });
  if (r.status === 'saved') {
    try {
      const photos = backupPhotos({ dataFile: st.dataFile, env: st.env });
      st.log(`[backup] photos: ${photos.copied} copied, ${photos.total} in all`);
    } catch (e) {
      r = { status: 'failed', error: `photos: ${(e as Error).message}` };
    }
  }
  st.backup.lastResult = r.status === 'skipped' ? `skipped: ${r.reason}` : r.status;
  if (r.status === 'saved') {
    Object.assign(st.backup, { lastAt: now.toISOString(), lastFile: r.file });
    st.log(`[backup] saved ${r.file} (${r.bytes} bytes)${r.removed.length ? `; removed ${r.removed.length} older` : ''}`);
  } else if (r.status === 'failed') {
    Object.assign(st.backup, { lastError: r.error, lastErrorAt: now.toISOString() });
    st.log(`[backup] FAILED: ${r.error}`);
    await alertAdmin(svc, 'backup_failed', 'The daily backup failed', `${r.error}\nData file: ${st.dataFile}`);
  }
  return r;
}

/** Past-due owners, held-back alerts, the daily backup. Never throws; never runs twice at once. */
export async function opsCheck(svc: Services): Promise<void> {
  const st = ops(svc);
  if (st.checking) return;
  st.checking = true;
  try {
    const jobs: [string, () => unknown][] = [
      ['past-due check', () => checkPastDue(svc)],
      ['held alerts', () => flushHeldAlerts(svc)],
      ['old "which home?" questions', () => pruneLineAsks(svc.store, svc.clock.now())],
      ['backup', () => runDailyBackup(svc)],
    ];
    for (const [name, job] of jobs) {
      try {
        await job();
      } catch (e) {
        st.log(`[ops] ${name} failed: ${(e as Error).message}`);
      }
    }
    try { svc.store.flush(); } catch { /* the engine saves again on its next piece of work */ }
  } finally {
    st.checking = false;
  }
}

/** Server boot: remember the data file and storage, then run opsCheck soon and every minute. Returns stop(). */
export function startOps(svc: Services, o: { dataFile?: string; storeKind?: OpsState['storeKind']; everyMs?: number } = {}): () => void {
  configureOps(svc, { dataFile: o.dataFile, storeKind: o.storeKind });
  const run = () => { void opsCheck(svc); };
  const first = setTimeout(run, 5_000);
  const timer = setInterval(run, o.everyMs ?? 60_000);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
