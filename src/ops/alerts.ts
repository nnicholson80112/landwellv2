// ADMIN ALERTS: tell Nate when something in the live business needs a person.
//
//   Where:  a text to ADMIN_ALERT_PHONE and/or an email to ADMIN_ALERT_EMAIL, through the same
//           messaging adapter as every other message (Twilio / Postmark, or the console outbox
//           when they aren't set up). Neither set: the alert is written to the server log only.
//   How often: at most one alert per kind every 10 minutes. Alerts in between are held back,
//           counted and listed (same subjects folded together) in the next alert of that kind,
//           or in a short summary once the 10 minutes are up (flushHeldAlerts, run every minute).
//   Never throws: a failed text or email is logged and the app carries on.
//
// Kinds used: run_failed, new_customer, emergency_no_vendor, ai_fallback, unrouted_message,
// past_due, backup_failed. Alert state is kept in the store (kv "opsAlerts"), so it survives restarts.

import type { Services } from '../services.ts';
import type { Approval } from '../domain/types.ts';
import type { RunRecord } from '../engine/engine.ts';
import { clip, normalizePhone, optedOut, propertyName } from '../workflows/lib.ts';
import { PLAN_NAMES, asPlanId, termName } from '../billing/plans.ts';
import { ops, track, type OpsState } from './state.ts';

export const ALERT_WINDOW_MS = 10 * 60_000;
const SEND_TIMEOUT_MS = 10_000;
const SMS_MAX = 640;
const MAX_HELD = 5;
const KV = 'opsAlerts';
const CUSTOMERS = 'opsCustomers';
const PAST_DUE = 'opsPastDue';

/** Plain words for each kind, used when alerts were held back. */
const KIND_LABEL: Record<string, string> = {
  run_failed: 'workflow failure', new_customer: 'new customer', emergency_no_vendor: 'emergency with no vendor',
  ai_fallback: 'AI fallback', unrouted_message: 'unrouted message', past_due: 'past-due payment', backup_failed: 'backup failure',
};
const label = (kind: string) => KIND_LABEL[kind] ?? kind.replace(/_/g, ' ');

export interface AlertRecord {
  kind: string;
  sent: number;
  lastSentAt?: string;
  lastSubject?: string;
  /** Alerts held back since the last one went out. */
  heldCount: number;
  held: { subject: string; n: number }[];
  heldSince?: string;
}

export interface AlertResult {
  /** Delivered on at least one channel ('console' counts when no channel is set up). */
  sent: boolean;
  channels: string[];
  /** Held back by the 10-minute limit for this kind. */
  held?: boolean;
  /** How many held-back alerts this one reported. */
  reported?: number;
}

const fresh = (kind: string): AlertRecord => ({ kind, sent: 0, heldCount: 0, held: [] });

/** Send an alert to the admin, or hold it back if one of this kind went out in the last 10 minutes. */
export async function alertAdmin(svc: Services, kind: string, subject: string, body: string): Promise<AlertResult> {
  const st = ops(svc);
  try {
    const now = svc.clock.now();
    const rec = svc.store.kvGet<AlertRecord>(KV, kind) ?? fresh(kind);
    if (rec.lastSentAt && now.getTime() - Date.parse(rec.lastSentAt) < ALERT_WINDOW_MS) {
      const same = rec.held.find((h) => h.subject === subject);
      if (same) same.n++;
      else if (rec.held.length < MAX_HELD) rec.held.push({ subject, n: 1 });
      rec.heldCount++;
      rec.heldSince ??= now.toISOString();
      svc.store.kvSet(KV, kind, rec);
      st.log(`[alert held] ${subject} (${rec.heldCount} ${label(kind)} alert${rec.heldCount === 1 ? '' : 's'} held back; one per 10 minutes)`);
      return { sent: false, held: true, channels: [] };
    }
    const reported = rec.heldCount;
    const extra = reported ? `\n\nAlso ${heldSummary(svc, rec)}` : '';
    // Saved before sending, so alerts that arrive while this one is going out are held back.
    svc.store.kvSet(KV, kind, { ...fresh(kind), sent: rec.sent + 1, lastSentAt: now.toISOString(), lastSubject: subject });
    const channels = await deliver(svc, subject, body + extra);
    return { sent: channels.length > 0, channels, reported };
  } catch (e) {
    st.log(`[alert] could not send "${subject}": ${(e as Error).message}`);
    return { sent: false, channels: [] };
  }
}

/** Once the 10 minutes are up, send one short summary for each kind that had alerts held back. */
export async function flushHeldAlerts(svc: Services): Promise<number> {
  let n = 0;
  try {
    const now = svc.clock.now();
    for (const rec of svc.store.kvList<AlertRecord>(KV)) {
      if (!rec.heldCount || (rec.lastSentAt && now.getTime() - Date.parse(rec.lastSentAt) < ALERT_WINDOW_MS)) continue;
      const subject = `${rec.heldCount} more ${label(rec.kind)} alert${rec.heldCount === 1 ? '' : 's'}`;
      const text = heldSummary(svc, rec);
      svc.store.kvSet(KV, rec.kind, { ...fresh(rec.kind), sent: rec.sent + 1, lastSentAt: now.toISOString(), lastSubject: subject });
      await deliver(svc, subject, text.charAt(0).toUpperCase() + text.slice(1));
      n++;
    }
  } catch (e) {
    ops(svc).log(`[alert] could not send held alerts: ${(e as Error).message}`);
  }
  return n;
}

/** The latest alert of each kind (for /api/admin/status). */
export function alertRecords(svc: Services): AlertRecord[] {
  return svc.store.kvList<AlertRecord>(KV).sort((a, b) => (b.lastSentAt ?? '').localeCompare(a.lastSentAt ?? ''));
}

function heldSummary(svc: Services, rec: AlertRecord): string {
  const n = rec.heldCount;
  // Plain spaces: some Node versions put a narrow no-break space before AM/PM.
  const since = rec.heldSince ? new Date(rec.heldSince).toLocaleTimeString('en-US', { timeZone: svc.cfg.tz, hour: 'numeric', minute: '2-digit' }).replace(/\s+/g, ' ') : 'the last alert';
  const list = rec.held.map((h) => (h.n > 1 ? `${h.subject} (x${h.n})` : h.subject)).join('; ');
  const listed = rec.held.reduce((s, h) => s + h.n, 0);
  return `${n} more ${label(rec.kind)} alert${n === 1 ? '' : 's'} since ${since} (held back so you aren't flooded): ${list}${n > listed ? `; and ${n - listed} more` : ''}.`;
}

async function deliver(svc: Services, subject: string, text: string): Promise<string[]> {
  const st = ops(svc);
  const phone = st.env.ADMIN_ALERT_PHONE?.trim();
  const email = st.env.ADMIN_ALERT_EMAIL?.trim();
  const title = `${svc.brand.name} alert: ${subject}`;
  if (!phone && !email) {
    st.log(`[alert] ${subject}\n${text}`);
    return ['console'];
  }
  st.log(`[alert] ${subject}`);
  const jobs: Promise<string | null>[] = [];
  if (phone) {
    const to = normalizePhone(phone);
    if (optedOut(svc.store, to, 'sms')) st.log('[alert] ADMIN_ALERT_PHONE replied STOP, so no alert text was sent (text START to that number to turn texts back on)');
    else jobs.push(attempt(st, 'text', () => svc.adapters.messaging.send({ channel: 'sms', to, body: clip(`${title}\n${text}`, SMS_MAX) })).then((ok) => (ok ? 'sms' : null)));
  }
  if (email) {
    const body = `${text}\n\nSent by the ${svc.brand.name} server. Alerts of one kind go out at most once every 10 minutes. Details: GET /api/admin/status with the admin token.`;
    jobs.push(attempt(st, 'email', () => svc.adapters.messaging.send({ channel: 'email', to: email, subject: title, body })).then((ok) => (ok ? 'email' : null)));
  }
  const out = (await Promise.all(jobs)).filter((c): c is string => !!c);
  if (!out.length) st.log(`[alert] not delivered: ${subject}\n${text}`);
  return out;
}

async function attempt(st: OpsState, what: string, fn: () => Promise<unknown>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([fn(), new Promise((_ok, fail) => { timer = setTimeout(() => fail(new Error('timed out')), SEND_TIMEOUT_MS); timer.unref?.(); })]);
    return true;
  } catch (e) {
    st.log(`[alert] ${what} failed: ${(e as Error).message}`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------- what triggers an alert ---------------- */

export const firstLine = (s?: string): string => (s ?? '').split('\n')[0].trim().slice(0, 300) || 'no error message';

/** engine.hooks.onRunFailed: a workflow stopped with an error. */
export async function runFailedAlert(svc: Services, run: RunRecord): Promise<AlertResult | undefined> {
  try {
    const owner = run.ownerId ? svc.store.get('owners', run.ownerId) : undefined;
    const title = svc.engine.workflows().find((w) => w.name === run.workflow)?.title ?? run.workflow;
    return await alertAdmin(svc, 'run_failed', `Workflow failed: ${title}`,
      `${title} (${run.workflow}, run ${run.id})${owner ? ` for ${owner.name}, ${owner.email}` : ''} stopped with: ${firstLine(run.error)}${owner ? '\nThe owner got a to-do to take a look.' : ''}`);
  } catch (e) {
    ops(svc).log(`[alert] workflow failure alert failed: ${(e as Error).message}`);
    return undefined;
  }
}

/** 'owner.signed_up': a new paying customer. Once per owner, ever. */
export async function newCustomerAlert(svc: Services, ownerId: string): Promise<AlertResult | undefined> {
  try {
    const o = svc.store.get('owners', ownerId);
    if (!o || svc.store.kvGet(CUSTOMERS, ownerId)) return undefined;
    svc.store.kvSet(CUSTOMERS, ownerId, { ownerId, at: svc.clock.now().toISOString() });
    const plan = asPlanId(o.billing?.plan ?? o.plan);
    const doors = o.billing?.doors;
    const term = o.billing?.term;
    return await alertAdmin(svc, 'new_customer',
      `New ${svc.brand.name} customer: ${o.name}, ${o.email}, ${plan ? PLAN_NAMES[plan] : 'no plan'}, ${doors ?? 'unknown'} door${doors === 1 ? '' : 's'}`,
      `${term ? termName(term).replace(/^./, (c) => c.toUpperCase()) : 'Billing term not set'}. Phone ${o.phone || 'not given'}. Owner id ${o.id}.`);
  } catch (e) {
    ops(svc).log(`[alert] new customer alert failed: ${(e as Error).message}`);
    return undefined;
  }
}

/** engine.hooks.onApprovalCreated: an emergency repair that no vendor accepted. */
export async function approvalAlert(svc: Services, a: Approval): Promise<AlertResult | undefined> {
  if (a.kind !== 'vendor_needed') return undefined;
  try {
    const store = svc.store;
    const wo = typeof a.data?.workOrderId === 'string' ? store.get('workOrders', a.data.workOrderId) : undefined;
    if (!wo || wo.urgency !== 'emergency') return undefined;
    const owner = store.get('owners', a.ownerId);
    const tenant = wo.tenantId ? store.get('tenants', wo.tenantId) : undefined;
    const code = store.get('approvals', a.id)?.code ?? a.code;
    return await alertAdmin(svc, 'emergency_no_vendor', `Emergency with no vendor: ${propertyName(store, wo.propertyId)}`,
      `"${clip(wo.summary, 160)}" (${wo.trade}). No vendor accepted the emergency job.` +
      `${owner ? ` Owner ${owner.name}: ${owner.phone || owner.email}.` : ''}` +
      `${tenant ? ` Tenant ${tenant.name}: ${tenant.phone ?? tenant.email ?? 'no contact on file'}.` : ''}` +
      ` The owner was asked to arrange it${code ? ` (code ${code})` : ''}.`);
  } catch (e) {
    ops(svc).log(`[alert] emergency alert failed: ${(e as Error).message}`);
    return undefined;
  }
}

/**
 * Owners whose KeyHelm subscription is past due (Stripe marked the payment failed): one alert per
 * owner each time it happens. Run from the server's ops check every minute; no billing code changed.
 */
export async function checkPastDue(svc: Services): Promise<string[]> {
  const store = svc.store;
  const owners = store.list('owners');
  const marked = new Map(store.kvList<{ ownerId: string }>(PAST_DUE).map((r) => [r.ownerId, r]));
  for (const id of marked.keys()) {
    const o = owners.find((x) => x.id === id);
    if (!o || o.billing?.status !== 'past_due') store.kvDelete(PAST_DUE, id); // paid again (or gone): alert again next time
  }
  const due = owners.filter((o) => o.billing?.status === 'past_due' && !marked.has(o.id));
  if (!due.length) return [];
  const now = svc.clock.now().toISOString();
  for (const o of due) store.kvSet(PAST_DUE, o.id, { ownerId: o.id, at: now, since: o.billing!.updatedAt });
  const line = (o: (typeof due)[number]) => {
    const plan = asPlanId(o.billing?.plan ?? o.plan);
    const doors = o.billing?.doors;
    return `${o.name}, ${o.email}, ${o.phone || 'no phone'}: ${plan ? PLAN_NAMES[plan] : 'no plan'}${doors ? `, ${doors} door${doors === 1 ? '' : 's'}` : ''}, past due since ${(o.billing!.updatedAt ?? now).slice(0, 10)}`;
  };
  await alertAdmin(svc, 'past_due', due.length === 1 ? `Payment past due: ${due[0].name}` : `${due.length} customers are past due`,
    `${due.map(line).join('\n')}\nTheir latest ${svc.brand.name} subscription payment didn't go through (Stripe marked it past due). Check Stripe and reach out if needed.`);
  return due.map((o) => o.id);
}

/* ---------------- AI falling back to the built-in rules ---------------- */

export const AI_FALLBACK_WINDOW_MS = 15 * 60_000;
export const AI_FALLBACK_COUNT = 3;
const AI_WATCH = new WeakMap<object, Services>();

/** Connect this server's AI (the ResilientAI from pickAI) to its alerts. */
export function watchAI(svc: Services): void {
  AI_WATCH.set(svc.ai, svc);
}

/** ResilientAI.onError (src/services.ts): the AI failed and the rules answered. 3 times in 15 minutes → alert. */
export function aiFellBack(ai: object, err: unknown): void {
  const svc = AI_WATCH.get(ai);
  if (!svc) return;
  const st = ops(svc);
  const now = svc.clock.now().getTime();
  const message = firstLine(err instanceof Error ? err.message : String(err)).slice(0, 200);
  st.lastAiError = { at: new Date(now).toISOString(), message };
  st.aiFallbacks = [...st.aiFallbacks.filter((t) => now - t < AI_FALLBACK_WINDOW_MS), now];
  if (st.aiFallbacks.length < AI_FALLBACK_COUNT) return;
  const n = st.aiFallbacks.length;
  st.aiFallbacks = [];
  track(svc, alertAdmin(svc, 'ai_fallback', 'The AI keeps falling back to built-in rules',
    `${n} replies in the last 15 minutes used the built-in rules because the AI (${svc.ai.name}) failed. Last error: ${message}. Tenants still get answers, but simpler ones. Check the ai service in Railway and the AI daily limits.`));
}
