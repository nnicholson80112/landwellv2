// Durable workflow engine.
//
// A workflow is an async function. Anything with a side effect goes through
// ctx (ctx.step, ctx.send, ctx.approval, ctx.sleep, ctx.waitFor...). Each of
// those calls is recorded on the run. When a run has to wait (for a vendor's
// reply, the owner's approval, or a date), the engine saves the run and stops.
// When the wait is over, the function is replayed from the top: recorded
// calls return their saved results instantly, so nothing happens twice, and
// execution continues where it left off. Runs survive restarts because the
// record lives in the Store.
//
// Rule for workflow authors: never read the clock, random numbers or the
// network directly inside a workflow. Use ctx.now(), ctx.step(), etc.

import type { Clock } from './clock.ts';
import { localParts } from './clock.ts';
import type { Store } from '../store/store.ts';
import { newId } from '../store/store.ts';
import type { Approval, AuditEntry } from '../domain/types.ts';

export type Trigger =
  | { event: string; when?: (payload: any) => boolean; dedupeKey?: (payload: any) => string }
  | { schedule: { every: 'day' | 'hour' | 'week'; at?: string; weekday?: number } }
  | { manual: true };

export interface WorkflowDef<S = any, I = any> {
  name: string;
  title: string; // human name shown in the app ("Repair request")
  description: string;
  trigger: Trigger;
  run: (ctx: Ctx<S>, input: I) => Promise<unknown>;
}

type Wait =
  | { kind: 'time'; key: string; until: string }
  | { kind: 'event'; key: string; event: string; match: Record<string, unknown>; until?: string };

export interface RunRecord {
  id: string;
  workflow: string;
  input: any;
  ownerId?: string;
  status: 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';
  steps: Record<string, { v: any; at: string }>;
  wait?: Wait;
  waitLabel?: string; // plain words: "Waiting for the vendor to reply"
  result?: any;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

class Suspend {
  readonly wait: Wait;
  readonly label: string;
  constructor(wait: Wait, label: string) {
    this.wait = wait;
    this.label = label;
  }
}

export interface EngineHooks {
  onApprovalCreated?: (a: Approval) => Promise<void> | void;
  onRunFailed?: (run: RunRecord, err: unknown) => Promise<void> | void;
  log?: (line: string) => void;
}

export class Engine<S = any> {
  private defs = new Map<string, WorkflowDef<S>>();
  private queue: (() => Promise<void>)[] = [];
  private draining: Promise<void> | null = null;
  readonly store: Store;
  readonly clock: Clock;
  readonly tz: string;
  svc!: S;
  hooks: EngineHooks = {};

  constructor(o: { store: Store; clock: Clock; tz?: string }) {
    this.store = o.store;
    this.clock = o.clock;
    this.tz = o.tz ?? 'America/Denver';
  }

  register(...defs: WorkflowDef<S>[]): this {
    for (const d of defs) this.defs.set(d.name, d);
    return this;
  }
  workflows(): WorkflowDef<S>[] {
    return [...this.defs.values()];
  }

  /* ------------------------------------------------------------ public API */

  /** Start a workflow directly. Returns the run id. */
  start(workflow: string, input: any, ownerId?: string): string {
    if (!this.defs.has(workflow)) throw new Error(`unknown workflow ${workflow}`);
    const now = this.clock.now().toISOString();
    const run: RunRecord = { id: newId('run'), workflow, input, ownerId: ownerId ?? input?.ownerId, status: 'running', steps: {}, createdAt: now, updatedAt: now };
    this.save(run);
    this.enqueue(run.id);
    return run.id;
  }

  /** Publish an event: starts matching workflows and wakes runs waiting for it. */
  emit(event: string, payload: Record<string, any> = {}): string[] {
    const started: string[] = [];
    for (const d of this.defs.values()) {
      const t = d.trigger as any;
      if (t.event !== event) continue;
      if (t.when && !t.when(payload)) continue;
      if (t.dedupeKey) {
        const k = `${d.name}:${t.dedupeKey(payload)}`;
        if (this.store.kvGet('dedupe', k)) continue;
        this.store.kvSet('dedupe', k, this.clock.now().toISOString());
      }
      started.push(this.start(d.name, payload));
    }
    for (const run of this.waitingRuns()) {
      const w = run.wait!;
      if (w.kind !== 'event' || w.event !== event) continue;
      if (!Object.entries(w.match).every(([k, v]) => payload[k] === v)) continue;
      run.steps[w.key] = { v: payload, at: this.clock.now().toISOString() };
      run.status = 'running';
      run.wait = undefined;
      run.waitLabel = undefined;
      this.save(run);
      this.enqueue(run.id);
    }
    return started;
  }

  /** Call regularly (every 30s in production). Fires timers, timeouts and schedules. */
  tick(): void {
    const now = this.clock.now();
    const iso = now.toISOString();
    for (const run of this.waitingRuns()) {
      const w = run.wait!;
      const until = w.kind === 'time' ? w.until : w.until;
      if (!until || until > iso) continue;
      run.steps[w.key] = { v: w.kind === 'time' ? true : null, at: iso };
      run.status = 'running';
      run.wait = undefined;
      run.waitLabel = undefined;
      this.save(run);
      this.enqueue(run.id);
    }
    const lp = localParts(now, this.tz);
    if (this.store.kvGet('prune', 'last') !== lp.date) {
      this.store.kvSet('prune', 'last', lp.date);
      this.prune(now.getTime());
    }
    for (const d of this.defs.values()) {
      const t = d.trigger as any;
      if (!t.schedule) continue;
      const s = t.schedule as { every: string; at?: string; weekday?: number };
      let slot: string | null = null;
      if (s.every === 'hour') slot = `${lp.date}T${String(lp.hour).padStart(2, '0')}`;
      else if (s.every === 'day' && lp.time >= (s.at ?? '00:00')) slot = lp.date;
      else if (s.every === 'week' && lp.weekday === (s.weekday ?? 1) && lp.time >= (s.at ?? '00:00')) slot = lp.date;
      if (!slot) continue;
      const k = `${d.name}:${slot}`;
      if (this.store.kvGet('schedule', k)) continue;
      this.store.kvSet('schedule', k, iso);
      this.start(d.name, { slot, localDate: lp.date });
    }
  }

  /**
   * Forget finished runs so the store doesn't grow forever: scheduled sweeps after
   * 2 days, everything else after 90. The activity log (audit) keeps the history.
   * Waiting and failed runs are never removed.
   */
  prune(nowMs = this.clock.now().getTime()): number {
    let n = 0;
    for (const r of this.store.kvList<RunRecord>('runs')) {
      if (r.status !== 'completed' && r.status !== 'cancelled') continue;
      const scheduled = 'schedule' in ((this.defs.get(r.workflow)?.trigger ?? {}) as object);
      if (nowMs - Date.parse(r.updatedAt) < (scheduled ? 2 : 90) * 24 * 3600_000) continue;
      this.store.kvDelete('runs', r.id);
      n++;
    }
    return n;
  }

  /** Wait until all queued work is done (tests, demo, request handlers). */
  async drain(): Promise<void> {
    while (this.draining) await this.draining;
  }

  cancel(runId: string, reason: string): void {
    const run = this.getRun(runId);
    if (!run || run.status === 'completed') return;
    run.status = 'cancelled';
    run.error = reason;
    run.wait = undefined;
    this.save(run);
  }

  getRun(id: string): RunRecord | undefined {
    return this.store.kvGet<RunRecord>('runs', id);
  }
  runs(filter?: (r: RunRecord) => boolean): RunRecord[] {
    return this.store.kvList<RunRecord>('runs').filter((r) => !filter || filter(r)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /* ------------------------------------------------------------ internals */

  private waitingRuns(): RunRecord[] {
    return this.store.kvList<RunRecord>('runs').filter((r) => r.status === 'waiting' && r.wait);
  }
  private save(run: RunRecord): void {
    run.updatedAt = this.clock.now().toISOString();
    this.store.kvSet('runs', run.id, run);
  }
  private enqueue(runId: string): void {
    this.queue.push(() => this.execute(runId));
    if (!this.draining) {
      this.draining = (async () => {
        while (this.queue.length) await this.queue.shift()!();
        this.store.flush();
        this.draining = null;
      })();
    }
  }

  private async execute(runId: string): Promise<void> {
    const run = this.getRun(runId);
    if (!run || run.status !== 'running') return;
    const def = this.defs.get(run.workflow)!;
    const ctx = new Ctx<S>(this, run);
    try {
      run.result = await def.run(ctx, run.input);
      run.status = 'completed';
      run.wait = undefined;
      run.waitLabel = undefined;
      this.save(run);
    } catch (e) {
      if (e instanceof Suspend) {
        run.status = 'waiting';
        run.wait = e.wait;
        run.waitLabel = e.label;
        this.save(run);
        return;
      }
      run.status = 'failed';
      run.error = e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e);
      this.save(run);
      this.audit({ ownerId: run.ownerId, actor: 'system', workflow: run.workflow, runId: run.id, action: 'workflow.failed', detail: e instanceof Error ? e.message : String(e) });
      this.hooks.log?.(`✗ ${run.workflow} failed: ${run.error}`);
      await this.hooks.onRunFailed?.(run, e);
    }
  }

  audit(a: Omit<AuditEntry, 'id' | 'at'>): AuditEntry {
    return this.store.insert('audit', { ...a, at: this.clock.now().toISOString() });
  }

  /** Used by Ctx.approval(). */
  async _createApproval(a: Omit<Approval, 'id' | 'status' | 'createdAt'>): Promise<Approval> {
    const rec = this.store.insert('approvals', { ...a, status: 'pending', createdAt: this.clock.now().toISOString() });
    await this.hooks.onApprovalCreated?.(rec);
    return rec;
  }

  /** The owner (or API) decides an approval. Wakes the waiting workflow. */
  decide(approvalId: string, decision: string, note?: string, data?: Record<string, unknown>): Approval {
    const a = this.store.get('approvals', approvalId);
    if (!a) throw new Error('approval not found');
    if (a.status !== 'pending') throw new Error('approval already decided');
    if (!a.options.includes(decision)) throw new Error(`decision must be one of: ${a.options.join(', ')}`);
    const done = this.store.update('approvals', approvalId, { status: 'decided', decision, note, decidedAt: this.clock.now().toISOString(), data: { ...a.data, ...(data ?? {}) } });
    this.audit({ ownerId: a.ownerId, actor: 'owner', runId: a.runId, action: 'approval.decided', detail: `${a.title}: ${decision}${note ? ` (${note})` : ''}` });
    this.emit('approval.decided', { approvalId, decision, note, data: done.data });
    return done;
  }
}

/** The handle a workflow uses for every side effect. */
export class Ctx<S> {
  private counters = new Map<string, number>();
  readonly runId: string;
  readonly svc: S;
  private engine: Engine<S>;
  private run: RunRecord;

  constructor(engine: Engine<S>, run: RunRecord) {
    this.engine = engine;
    this.run = run;
    this.runId = run.id;
    this.svc = engine.svc;
  }

  get store(): Store {
    return this.engine.store;
  }
  get ownerId(): string | undefined {
    return this.run.ownerId;
  }
  setOwner(ownerId: string): void {
    if (this.run.ownerId !== ownerId) {
      this.run.ownerId = ownerId;
      this.engine.store.kvSet('runs', this.run.id, this.run);
    }
  }

  private key(name: string): string {
    const n = (this.counters.get(name) ?? 0) + 1;
    this.counters.set(name, n);
    return n === 1 ? name : `${name}#${n}`;
  }
  private persist(): void {
    this.run.updatedAt = this.engine.clock.now().toISOString();
    this.engine.store.kvSet('runs', this.run.id, this.run);
  }

  /** Run fn once per run; on replay returns the saved result. */
  async step<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
    const k = this.key(name);
    if (k in this.run.steps) return this.run.steps[k].v as T;
    const v = await fn();
    this.run.steps[k] = { v: v === undefined ? null : v, at: this.engine.clock.now().toISOString() };
    this.persist();
    return v;
  }

  /** The current time, recorded so replays see the same value. */
  async now(): Promise<Date> {
    const iso = await this.step('now', () => this.engine.clock.now().toISOString());
    return new Date(iso);
  }

  async sleepUntil(iso: string, label = 'Waiting'): Promise<void> {
    const k = this.key('sleep');
    if (k in this.run.steps) return;
    if (this.engine.clock.now().toISOString() >= iso) {
      this.run.steps[k] = { v: true, at: this.engine.clock.now().toISOString() };
      this.persist();
      return;
    }
    throw new Suspend({ kind: 'time', key: k, until: iso }, label);
  }
  async sleep(ms: number, label = 'Waiting'): Promise<void> {
    const start = await this.now();
    return this.sleepUntil(new Date(start.getTime() + ms).toISOString(), label);
  }

  /**
   * Pause until an event with matching fields arrives. Returns its payload,
   * or null if timeoutMs passes first.
   */
  async waitFor<T = any>(event: string, match: Record<string, unknown>, opts: { timeoutMs?: number; label?: string } = {}): Promise<T | null> {
    const k = this.key(`wait:${event}`);
    if (k in this.run.steps) return this.run.steps[k].v as T | null;
    let until: string | undefined;
    if (opts.timeoutMs !== undefined) {
      const startKey = `${k}:start`;
      if (!(startKey in this.run.steps)) {
        this.run.steps[startKey] = { v: this.engine.clock.now().toISOString(), at: this.engine.clock.now().toISOString() };
        this.persist();
      }
      until = new Date(new Date(this.run.steps[startKey].v).getTime() + opts.timeoutMs).toISOString();
    }
    throw new Suspend({ kind: 'event', key: k, event, match, until }, opts.label ?? `Waiting for ${event}`);
  }

  /**
   * Ask the owner to decide. Creates an Approval (shown in the app and sent
   * by text), then pauses. Returns the decision, or null on timeout.
   */
  async approval(a: { kind: string; title: string; body: string; options?: string[]; data?: Record<string, unknown>; timeoutMs?: number }): Promise<{ decision: string; note?: string; data: Record<string, unknown> } | null> {
    if (!this.run.ownerId) throw new Error('approval needs ownerId on the run');
    const rec = await this.step(`approval:${a.kind}`, () =>
      this.engine._createApproval({ ownerId: this.run.ownerId!, runId: this.run.id, kind: a.kind, title: a.title, body: a.body, options: a.options ?? ['approve', 'decline'], data: a.data ?? {} }),
    );
    const ev = await this.waitFor<{ decision: string; note?: string; data: Record<string, unknown> }>('approval.decided', { approvalId: rec.id }, { timeoutMs: a.timeoutMs, label: `Waiting for you: ${a.title}` });
    if (!ev) {
      await this.step(`approval-expire:${a.kind}`, () => this.engine.store.update('approvals', rec.id, { status: 'expired' }));
      return null;
    }
    return { decision: ev.decision, note: ev.note, data: ev.data };
  }

  /** Emit an event exactly once per run. */
  async emit(event: string, payload: Record<string, any>): Promise<void> {
    await this.step(`emit:${event}`, () => {
      this.engine.emit(event, payload);
      return true;
    });
  }

  /** Write to the owner-visible activity log exactly once per run. */
  async log(action: string, detail: string, opts: { actor?: AuditEntry['actor']; data?: Record<string, unknown> } = {}): Promise<void> {
    await this.step(`log:${action}`, () =>
      this.engine.audit({ ownerId: this.run.ownerId, actor: opts.actor ?? 'system', workflow: this.run.workflow, runId: this.run.id, action, detail, data: opts.data }),
    );
  }
}
