// The Test lab (npm run sandbox): texts as anyone, time jumps, reset. And the live server,
// which has no lab, answers 404 to every lab route.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { MemoryStore } from '../src/store/store.ts';
import { OffsetClock, SystemClock, DAY } from '../src/engine/clock.ts';
import { createServices } from '../src/services.ts';
import { install } from '../src/workflows/index.ts';
import { seed } from '../src/sim/seed.ts';
import { Lab, LabError } from '../src/sim/lab.ts';
import { createApp } from '../src/api/server.ts';

function sandbox() {
  const store = new MemoryStore();
  const clock = new OffsetClock();
  const svc = createServices({ store, clock, env: {} });
  install(svc);
  let ownerId = '';
  const reseed = () => { ownerId = seed(store, { DEMO_VENDOR_PHONE: '+17205550122' }).owner.id; };
  reseed();
  const lab = new Lab(svc, clock, { reseed });
  return { store, clock, svc, lab, owner: () => ownerId };
}

test('lab: a tenant text starts a repair and the vendor is texted after the photo', async () => {
  const { lab, owner, store } = sandbox();
  await lab.text(owner(), 'tenant', 'The window screen in the back bedroom is torn.');
  await lab.text(owner(), 'tenant', 'Here you go', true);
  assert.ok(store.list('messages', (m) => m.direction === 'out' && m.to === '+17205550122').length, 'the window vendor got the job');
  assert.equal(store.list('workOrders').length, 1);
});

test('lab: jumping to rent day fires the reminder and moves the clock', async () => {
  const { lab, owner, store, clock } = sandbox();
  const t = lab.targets(owner());
  assert.ok(t.rent.at && t['1h'].at && t.lease_end.at);
  const sent = await lab.jump(owner(), 'rent');
  assert.ok(sent > 0);
  assert.ok(clock.offsetMs > 0);
  assert.ok(store.list('messages', (m) => m.direction === 'out' && /rent of .+ is due today/.test(m.body)).length, 'due-today reminder went out');
  assert.equal(store.kvGet('lab', 'offsetMs'), clock.offsetMs, 'the jump is saved for restarts');
});

test('lab: jumps that passed or are too far say why; reset starts over at real time', async () => {
  const { lab, owner, store, clock } = sandbox();
  clock.advance(500 * DAY);
  await assert.rejects(lab.jump(owner(), 'lease_end'), (e) => e instanceof LabError && /passed/i.test(e.message));
  await lab.text(owner(), 'tenant', 'STOP');
  const before = owner();
  lab.reset();
  assert.equal(clock.offsetMs, 0);
  assert.notEqual(owner(), before, 'fresh demo data');
  assert.equal(store.list('owners').length, 1);
  assert.equal(store.list('messages').length, 0);
});

test('lab: the live server (no lab) answers 404 to every lab route', async () => {
  const store = new MemoryStore();
  const svc = createServices({ store, clock: new SystemClock(), env: {} });
  install(svc);
  seed(store, {});
  store.kvSet('tokens', 't0k', store.list('owners')[0].id);
  const server = createApp(svc).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const auth = { authorization: 'Bearer t0k', 'content-type': 'application/json' };
    assert.equal((await fetch(`${base}/api/lab`, { headers: auth })).status, 404);
    for (const p of ['text', 'jump', 'screening', 'id-check', 'reset']) {
      assert.equal((await fetch(`${base}/api/lab/${p}`, { method: 'POST', headers: auth, body: JSON.stringify({ who: 'tenant', body: 'hi', to: '1d' }) })).status, 404, p);
    }
    assert.equal('lab' in (await (await fetch(`${base}/api/me`, { headers: auth })).json()), false, 'the app never shows the tab');
  } finally {
    server.close();
  }
});
