// What /api/admin/status shows: one look at whether the live business is healthy.

import { existsSync, statSync } from 'node:fs';
import type { Services } from '../services.ts';
import { DAY } from '../engine/clock.ts';
import { clip } from '../workflows/lib.ts';
import { AI_FALLBACK_WINDOW_MS, alertRecords, firstLine } from './alerts.ts';
import { listBackups } from './backup.ts';
import { onSharedNumber, sharedNumber } from './lines.ts';
import { ops } from './state.ts';

export function opsStatus(svc: Services) {
  const st = ops(svc);
  const env = st.env;
  const store = svc.store;
  const now = svc.clock.now();
  const nowMs = now.getTime();
  const dayAgo = new Date(nowMs - DAY).toISOString();
  const weekAgo = new Date(nowMs - 7 * DAY).toISOString();

  const owners = store.list('owners');
  const byBilling: Record<string, number> = {};
  for (const o of owners) byBilling[o.billing?.status ?? 'none'] = (byBilling[o.billing?.status ?? 'none'] ?? 0) + 1;
  const paying = owners.filter((o) => o.billing?.status === 'active');

  const runs = svc.engine.runs();
  const waitingByWorkflow: Record<string, number> = {};
  for (const r of runs) if (r.status === 'waiting') waitingByWorkflow[r.workflow] = (waitingByWorkflow[r.workflow] ?? 0) + 1;
  const failed = runs.filter((r) => r.status === 'failed' && r.updatedAt >= weekAgo).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  const pending = store.list('approvals', (a) => a.status === 'pending');
  const stale = pending.filter((a) => a.createdAt <= dayAgo).sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const recent = store.list('messages', (m) => m.at >= dayAgo);
  const unrouted = store.list('messages', (m) => !m.ownerId && m.direction === 'in' && m.at >= weekAgo).sort((a, b) => b.at.localeCompare(a.at));

  const health = store.health?.() ?? null;
  const kind = st.storeKind ?? health?.kind ?? 'memory';
  let dataFileBytes: number | null = null;
  try {
    if (st.dataFile && existsSync(st.dataFile)) dataFileBytes = statSync(st.dataFile).size;
  } catch { /* unreadable: shown as null */ }
  const backups = st.dataFile ? listBackups(st.dataFile) : [];
  const shared = sharedNumber(env);

  return {
    ok: true,
    at: now.toISOString(),
    startedAt: st.startedAt,
    commit: (env.RAILWAY_GIT_COMMIT_SHA ?? env.GIT_COMMIT ?? 'unknown').slice(0, 7),
    owners: { total: owners.length, byBilling },
    subscriptions: { active: paying.length, doors: paying.reduce((s, o) => s + (o.billing?.doors ?? 0), 0), pastDue: byBilling.past_due ?? 0 },
    runs: {
      waiting: Object.values(waitingByWorkflow).reduce((s, n) => s + n, 0),
      waitingByWorkflow,
      failedLast7Days: failed.length,
      failed: failed.slice(0, 25).map((r) => ({ id: r.id, workflow: r.workflow, ownerId: r.ownerId ?? null, at: r.updatedAt, error: firstLine(r.error) })),
    },
    approvals: {
      pending: pending.length,
      pendingOver24h: stale.length,
      oldest: stale.slice(0, 25).map((a) => ({ id: a.id, ownerId: a.ownerId, kind: a.kind, title: a.title, code: a.code ?? null, createdAt: a.createdAt })),
    },
    messages: {
      last24h: { in: recent.filter((m) => m.direction === 'in').length, out: recent.filter((m) => m.direction === 'out').length },
      unroutedLast7Days: unrouted.length,
      unrouted: unrouted.slice(0, 10).map((m) => ({ at: m.at, from: m.from ?? m.threadKey, to: m.to ?? null, channel: m.channel, body: clip(m.body, 160) })),
    },
    ai: {
      provider: svc.ai.name,
      fallbacksLast15Min: st.aiFallbacks.filter((t) => nowMs - t < AI_FALLBACK_WINDOW_MS).length,
      lastError: st.lastAiError ?? null,
    },
    messaging: svc.adapters.messaging.name,
    engine: { lastTickAt: st.lastTickAt ?? null, secondsSinceTick: st.lastTickAt ? Math.round((nowMs - Date.parse(st.lastTickAt)) / 1000) : null },
    store: { kind, health, dataFile: st.dataFile ?? null, dataFileBytes },
    backup: {
      enabled: !!st.dataFile && (kind === 'postgres' || (kind === 'file' && !env.DATABASE_URL?.trim())),
      last: backups[0] ?? null,
      count: backups.length,
      lastResult: st.backup.lastResult ?? null,
      lastError: st.backup.lastError ? { at: st.backup.lastErrorAt, error: st.backup.lastError } : null,
    },
    alerts: {
      phoneSet: !!env.ADMIN_ALERT_PHONE?.trim(),
      emailSet: !!env.ADMIN_ALERT_EMAIL?.trim(),
      recent: alertRecords(svc).slice(0, 10).map((a) => ({ kind: a.kind, lastSentAt: a.lastSentAt ?? null, lastSubject: a.lastSubject ?? null, sent: a.sent, heldBack: a.heldCount })),
    },
    lines: {
      sharedNumber: shared ?? (env.TWILIO_FROM?.trim() ? 'a Twilio Messaging Service' : null),
      ownersOnShared: owners.filter((o) => onSharedNumber(o, env)).length,
      dedicated: owners.filter((o) => !onSharedNumber(o, env)).map((o) => ({ ownerId: o.id, name: o.name, lineNumber: o.lineNumber })),
    },
  };
}
