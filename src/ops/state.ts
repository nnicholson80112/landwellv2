// Running-the-business state, one per server (per Services, so tests that make many servers in
// one process never share it): where admin alerts go, the last engine tick, the data file and
// the last backup. Kept in memory; anything that must survive a restart lives in the store.

import type { Services } from '../services.ts';

export type Env = Record<string, string | undefined>;

export interface OpsState {
  /** Where settings are read from (ADMIN_ALERT_PHONE, ADMIN_ALERT_EMAIL, ADMIN_API_TOKEN, TWILIO_FROM, DATABASE_URL). */
  env: Env;
  /** Console line for alerts and ops problems. */
  log: (line: string) => void;
  startedAt: string;
  /** Recorded by the server's 30-second engine tick (see noteTick). */
  lastTickAt?: string;
  /** The JSON data file (DATA_FILE) and which storage the server opened. */
  dataFile?: string;
  storeKind?: 'file' | 'postgres' | 'memory';
  backup: { lastAt?: string; lastFile?: string; lastResult?: string; lastError?: string; lastErrorAt?: string };
  /** When the AI fell back to the built-in rules (ms), for "it keeps failing" alerts. */
  aiFallbacks: number[];
  lastAiError?: { at: string; message: string };
  /** Alerts still being sent in the background (tests and shutdown can wait for them). */
  pending: Set<Promise<unknown>>;
  checking?: boolean;
}

const STATE = new WeakMap<object, OpsState>();

export function ops(svc: Services): OpsState {
  let s = STATE.get(svc);
  if (!s) {
    s = { env: process.env, log: (line) => console.warn(line), startedAt: new Date().toISOString(), backup: {}, aiFallbacks: [], pending: new Set() };
    STATE.set(svc, s);
  }
  return s;
}

/** Override settings for this server (tests pass their own env and a quiet log). */
export function configureOps(svc: Services, patch: Partial<Pick<OpsState, 'env' | 'log' | 'dataFile' | 'storeKind'>>): OpsState {
  return Object.assign(ops(svc), patch);
}

/** Keep a background promise so callers can wait for it with opsSettled(). */
export function track(svc: Services, p: Promise<unknown>): void {
  const s = ops(svc);
  s.pending.add(p);
  const done = () => { s.pending.delete(p); };
  p.then(done, done);
}

/** Wait until every background alert has been sent (or has failed and been logged). */
export async function opsSettled(svc: Services): Promise<void> {
  const s = ops(svc);
  while (s.pending.size) await Promise.allSettled([...s.pending]);
}

/** The engine tick ran (called from the server's tick interval). */
export function noteTick(svc: Services): void {
  ops(svc).lastTickAt = svc.clock.now().toISOString();
}
