import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../src/engine/engine.ts';
import { FakeClock, HOUR, DAY } from '../src/engine/clock.ts';
import { MemoryStore } from '../src/store/store.ts';

function setup(file?: string) {
  const clock = new FakeClock('2026-10-12T14:00:00Z');
  const store = new MemoryStore({ file });
  const engine = new Engine({ store, clock });
  engine.svc = {};
  return { clock, store, engine };
}

test('steps run once across suspend/resume', async () => {
  const { engine } = setup();
  let calls = 0;
  engine.register({
    name: 'w', title: 'w', description: '', trigger: { event: 'go' },
    async run(ctx) {
      await ctx.step('side-effect', () => ++calls);
      const ev = await ctx.waitFor<{ x: number }>('reply', { id: 'a' });
      await ctx.step('after', () => ++calls);
      return ev?.x;
    },
  });
  const [runId] = engine.emit('go', {});
  await engine.drain();
  assert.equal(engine.getRun(runId)!.status, 'waiting');
  engine.emit('reply', { id: 'b', x: 1 }); // not a match
  await engine.drain();
  assert.equal(engine.getRun(runId)!.status, 'waiting');
  engine.emit('reply', { id: 'a', x: 7 });
  await engine.drain();
  const run = engine.getRun(runId)!;
  assert.equal(run.status, 'completed');
  assert.equal(run.result, 7);
  assert.equal(calls, 2);
});

test('waitFor times out and sleep wakes on tick', async () => {
  const { engine, clock } = setup();
  engine.register({
    name: 'w', title: 'w', description: '', trigger: { event: 'go' },
    async run(ctx) {
      const r = await ctx.waitFor('never', {}, { timeoutMs: 2 * HOUR });
      await ctx.sleep(DAY);
      return r === null ? 'timed-out' : 'got';
    },
  });
  const [id] = engine.emit('go', {});
  await engine.drain();
  clock.advance(2 * HOUR + 1);
  engine.tick();
  await engine.drain();
  assert.equal(engine.getRun(id)!.status, 'waiting');
  clock.advance(DAY);
  engine.tick();
  await engine.drain();
  assert.equal(engine.getRun(id)!.result, 'timed-out');
});

test('approvals pause the run until the owner decides', async () => {
  const { engine, store } = setup();
  const owner = store.insert('owners', { name: 'O', email: 'o@x', phone: '+1', plan: 'autopilot', timezone: 'America/Denver', createdAt: '' });
  engine.register({
    name: 'w', title: 'w', description: '', trigger: { event: 'go' },
    async run(ctx) {
      const a = await ctx.approval({ kind: 'k', title: 'Approve?', body: 'b' });
      return a?.decision;
    },
  });
  const [id] = engine.emit('go', { ownerId: owner.id });
  await engine.drain();
  const ap = store.list('approvals')[0];
  assert.equal(ap.status, 'pending');
  assert.throws(() => engine.decide(ap.id, 'maybe'));
  engine.decide(ap.id, 'approve');
  await engine.drain();
  assert.equal(engine.getRun(id)!.result, 'approve');
});

test('daily schedules fire once per local day', async () => {
  const { engine, clock } = setup();
  let n = 0;
  engine.register({ name: 's', title: 's', description: '', trigger: { schedule: { every: 'day', at: '06:00' } }, async run() { n++; } });
  engine.tick(); // 8:00 AM Denver → fires
  engine.tick();
  await engine.drain();
  clock.advance(12 * HOUR);
  engine.tick(); // 8:00 PM same day → no
  clock.advance(10 * HOUR + 1);
  engine.tick(); // 6:00 AM next day → fires
  await engine.drain();
  assert.equal(n, 2);
});

test('waiting runs survive a restart', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'lw-')), 'db.json');
  const def = {
    name: 'w', title: 'w', description: '', trigger: { event: 'go' as const },
    async run(ctx: any) {
      const ev = await ctx.waitFor('reply', { id: 'a' });
      return ev.x;
    },
  };
  const a = setup(file);
  a.engine.register(def);
  const [id] = a.engine.emit('go', {});
  await a.engine.drain();
  a.store.flush();
  const b = setup(file); // fresh process, same file
  b.engine.register(def);
  b.engine.emit('reply', { id: 'a', x: 42 });
  await b.engine.drain();
  assert.equal(b.engine.getRun(id)!.result, 42);
});

test('event dedupe prevents double starts from webhook retries', async () => {
  const { engine } = setup();
  engine.register({ name: 'w', title: 'w', description: '', trigger: { event: 'pay', dedupeKey: (p) => p.ref }, async run() { return 1; } });
  assert.equal(engine.emit('pay', { ref: 'x' }).length, 1);
  assert.equal(engine.emit('pay', { ref: 'x' }).length, 0);
});

test('finished runs are pruned (sweeps after 2 days, others after 90); waiting runs never', async () => {
  const { engine, clock } = setup();
  engine.register({ name: 'sweep', title: 's', description: '', trigger: { schedule: { every: 'hour' } }, async run() {} });
  engine.register({ name: 'job', title: 'j', description: '', trigger: { event: 'go' }, async run() {} });
  engine.register({ name: 'wait', title: 'w', description: '', trigger: { event: 'go' }, async run(ctx: any) { await ctx.waitFor('never', {}); } });
  engine.tick();
  engine.emit('go');
  await engine.drain();
  assert.equal(engine.runs().length, 3);
  clock.advance(3 * DAY);
  engine.tick();
  await engine.drain();
  assert.deepEqual(engine.runs().map((r) => r.workflow).sort(), ['job', 'sweep', 'wait'], 'old sweep gone, a fresh one ran');
  clock.advance(90 * DAY);
  engine.tick();
  await engine.drain();
  assert.deepEqual(engine.runs().map((r) => r.workflow).sort(), ['sweep', 'wait']);
});
