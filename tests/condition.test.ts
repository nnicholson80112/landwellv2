// Condition reports: the full move-in flow, each side's limits, photos and move-out. No outside service is called.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { MemoryStore } from '../src/store/store.ts';
import { FakeClock } from '../src/engine/clock.ts';
import { createServices } from '../src/services.ts';
import { install } from '../src/workflows/index.ts';
import { seed } from '../src/sim/seed.ts';
import { createApp, LIMIT } from '../src/api/server.ts';
import { RateLimiter, limitsFromEnv } from '../src/api/guard.ts';
import { defaultRooms } from '../src/api/condition.ts';
import type { OutboxMessaging } from '../src/adapters/mock.ts';

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]).toString('base64');
const photos = mkdtempSync(join(tmpdir(), 'kh-photos-'));
process.env.PHOTO_DIR = photos;
process.on('exit', () => rmSync(photos, { recursive: true, force: true }));

function boot() {
  const L = limitsFromEnv();
  Object.assign(LIMIT, { ip: new RateLimiter(L.ip), owner: new RateLimiter(L.owner), publicForm: new RateLimiter(L.publicForm) });
  const store = new MemoryStore();
  const clock = new FakeClock('2026-10-12T16:00:00Z');
  const svc = createServices({ store, clock, env: {} });
  install(svc);
  const s = seed(store, {});
  store.kvSet('tokens', 'tok', s.owner.id);
  const { id: _id, ...rest } = s.owner;
  const other = store.insert('owners', { ...rest, email: 'other@example.com', phone: '+17205550999' });
  store.kvSet('tokens', 'tok2', other.id);
  const server = createApp(svc).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const send = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const owner = (method: string, path: string, body?: unknown, token = 'tok') => send(method, path, body, { authorization: `Bearer ${token}` });
  const start = async (kind = 'move_in') => (await (await owner('POST', '/api/condition-reports', { propertyId: s.home.id, kind })).json());
  const link = async () => new URL((await (await owner('POST', `/api/tenants/${s.tenant.id}/my-home`, {})).json()).url).pathname;
  return { store, svc, clock, s, base, send, owner, start, link, outbox: svc.adapters.messaging as OutboxMessaging, close: () => server.close() };
}

test('default rooms follow the size of the home', () => {
  const names = defaultRooms({ beds: 2, baths: 1.5 }).map((r) => r.name);
  for (const n of ['Kitchen', 'Bedroom 1', 'Bedroom 2', 'Bathroom 1', 'Bathroom 2']) assert.ok(names.includes(n), n);
  assert.ok(defaultRooms({ beds: 1, baths: 1 }).some((r) => r.name === 'Bedroom'));
});

test('move-in: owner sets up, tenant fills in by link, both sign, then it can not change', async () => {
  const t = boot();
  try {
    const r = await t.start();
    assert.equal(r.status, 'draft');
    assert.equal((await t.owner('GET', `/api/condition-reports/${r.id}`, undefined, 'tok2')).status, 404, "another owner can't see it");

    const rooms = (await (await t.owner('PATCH', `/api/condition-reports/${r.id}`, { rooms: ['Kitchen', 'Bedroom'] })).json()).rooms;
    assert.equal(rooms.length, 2);
    assert.equal((await t.owner('PATCH', `/api/condition-reports/${r.id}`, { rooms: ['Kitchen', 'kitchen'] })).status, 400);
    const [kitchen, bedroom] = rooms;

    const my = await t.link();
    const page = `${my}/condition/${r.id}`;
    assert.equal((await t.send('GET', page)).status, 404, 'a draft is not on My Home');
    assert.ok(!(await (await t.send('GET', my)).text()).includes('Condition reports'));

    assert.equal((await t.owner('POST', `/api/condition-reports/${r.id}/send`, {})).status, 200);
    assert.ok(t.outbox.sent.some((m) => m.to === t.s.tenant.phone && /Please fill in the move-in condition report/.test(m.body) && m.body.includes(my)), 'the tenant got the link');
    assert.match(await (await t.send('GET', my)).text(), /Fill in your move-in report/);
    assert.equal((await t.owner('PATCH', `/api/condition-reports/${r.id}`, { rooms: ['Kitchen'] })).status, 409, 'rooms are fixed once sent');

    const html = await (await t.send('GET', page)).text();
    assert.equal((await t.send('GET', page)).headers.get('cache-control'), 'no-store');
    assert.ok(html.includes('Kitchen') && html.includes('Send to my landlord'));

    assert.equal((await t.send('POST', `${page}/rooms/${kitchen.id}`, { condition: 'great' })).status, 400);
    assert.equal((await t.send('POST', `${page}/rooms/nope`, { condition: 'good' })).status, 404);
    assert.equal((await t.send('POST', `${page}/rooms/${kitchen.id}`, { condition: 'fair', note: 'Chip in the <counter>' })).status, 200);

    assert.equal((await t.send('POST', `${page}/rooms/${kitchen.id}/photos`, { data: Buffer.from('<svg></svg>').toString('base64') })).status, 400, 'only real JPEGs');
    const added = await t.send('POST', `${page}/rooms/${kitchen.id}/photos`, { data: JPEG });
    assert.equal(added.status, 201);
    const { name } = await added.json();
    assert.match(name, /^[a-f0-9]{24}\.jpg$/);
    const shown = await t.send('GET', `${page}/photos/${name}`);
    assert.equal(shown.headers.get('content-type'), 'image/jpeg');
    assert.equal(Buffer.from(await shown.arrayBuffer()).toString('base64'), JPEG);
    assert.equal((await t.send('GET', `${page}/photos/..%2F..%2Fsecret.jpg`)).status, 404);
    assert.equal((await t.send('GET', `${page}/photos/${'a'.repeat(24)}.jpg`)).status, 404);
    assert.equal((await t.owner('GET', `/api/condition-reports/${r.id}/photos/${name}`)).status, 200);
    assert.equal((await t.owner('GET', `/api/condition-reports/${r.id}/photos/${name}`, undefined, 'tok2')).status, 404);

    const removable = await (await t.send('POST', `${page}/rooms/${bedroom.id}/photos`, { data: JPEG })).json();
    assert.equal((await t.send('DELETE', `${page}/rooms/${bedroom.id}/photos/${removable.name}`)).status, 200);
    assert.ok(!readdirSync(join(photos, r.id)).includes(removable.name), 'the file is gone');

    const incomplete = await t.send('POST', `${page}/submit`, { name: 'Lisa Chen', consent: true });
    assert.equal(incomplete.status, 400);
    assert.match((await incomplete.json()).error, /Bedroom/);
    await t.send('POST', `${page}/rooms/${bedroom.id}`, { condition: 'good' });
    assert.equal((await t.send('POST', `${page}/submit`, { name: 'Lisa Chen' })).status, 400, 'must tick the box');
    assert.equal((await t.owner('POST', `/api/condition-reports/${r.id}/finish`, { name: 'Nate' })).status, 409, "the owner can't finish before the tenant without saying so");
    assert.equal((await t.send('POST', `${page}/submit`, { name: 'Lisa Chen', consent: true })).status, 200);

    assert.equal((await t.send('POST', `${page}/rooms/${kitchen.id}`, { condition: 'good' })).status, 409, "the tenant's side is locked");
    assert.ok(t.store.list('tasks', (x) => x.title.startsWith('Review the move-in report') && x.status === 'open').length === 1, 'owner to-do');
    assert.ok(t.outbox.sent.some((m) => m.to === t.s.owner.phone && /finished the move-in condition report/.test(m.body)), 'owner text');

    // The owner adds their own side; the tenant's words are untouched.
    assert.equal((await t.owner('POST', `/api/condition-reports/${r.id}/rooms/${kitchen.id}`, { condition: 'good', note: 'Looks fine' })).status, 200);
    assert.equal((await t.owner('POST', `/api/condition-reports/${r.id}/rooms/${kitchen.id}/photos`, { data: JPEG })).status, 201);
    const seen = await (await t.owner('GET', `/api/condition-reports/${r.id}`)).json();
    assert.equal(seen.rooms[0].tenant.condition, 'fair');
    assert.equal(seen.rooms[0].owner.condition, 'good');

    const during = await (await t.send('GET', page)).text();
    assert.ok(during.includes('Chip in the &lt;counter&gt;'), 'tenant text is escaped');
    assert.ok(!during.includes('Looks fine'), "the owner's side shows only once it's final");

    const done = await (await t.owner('POST', `/api/condition-reports/${r.id}/finish`, { name: 'Nate' })).json();
    assert.equal(done.status, 'done');
    assert.equal(t.store.list('tasks', (x) => x.title.startsWith('Review the move-in report') && x.status === 'open').length, 0, 'to-do closed');
    assert.ok(t.outbox.sent.some((m) => m.to === t.s.tenant.phone && /is final/.test(m.body)));
    assert.ok((await (await t.send('GET', page)).text()).includes('Looks fine'));

    for (const [m, p, b] of [['POST', `/rooms/${kitchen.id}`, { condition: 'fair' }], ['POST', `/rooms/${kitchen.id}/photos`, { data: JPEG }], ['DELETE', `/rooms/${kitchen.id}/photos/${name}`, undefined], ['POST', '/finish', { name: 'Nate' }]] as const) {
      assert.equal((await t.owner(m, `/api/condition-reports/${r.id}${p}`, b)).status, 409, `final: ${p}`);
    }
    assert.equal((await t.owner('DELETE', `/api/condition-reports/${r.id}`)).status, 409);
    assert.equal((await t.owner('DELETE', `/api/properties/${t.s.home.id}`)).status, 409);
  } finally { t.close(); }
});

test('a tenant only reaches reports they are on, and a move-out report compares with move-in', async () => {
  const t = boot();
  try {
    const r = await t.start();
    await t.owner('POST', `/api/condition-reports/${r.id}/send`, {});
    const stranger = t.store.insert('tenants', { ownerId: t.s.owner.id, propertyId: t.s.vacant.id, name: 'Sam Lee', phone: '+17205550222', preferredChannel: 'sms', autopay: false, status: 'active' });
    const theirs = new URL((await (await t.owner('POST', `/api/tenants/${stranger.id}/my-home`, {})).json()).url).pathname;
    assert.equal((await t.send('GET', `${theirs}/condition/${r.id}`)).status, 404);
    assert.equal((await t.send('POST', `${theirs}/condition/${r.id}/rooms/${r.rooms[0].id}`, { condition: 'good' })).status, 404);

    // The owner can finish without the tenant, after rating every room, and the record says so.
    assert.equal((await t.owner('POST', `/api/condition-reports/${r.id}/finish`, { name: 'Nate', withoutTenant: true })).status, 400);
    for (const room of r.rooms) await t.owner('POST', `/api/condition-reports/${r.id}/rooms/${room.id}`, { condition: 'good' });
    const done = await (await t.owner('POST', `/api/condition-reports/${r.id}/finish`, { name: 'Nate', withoutTenant: true })).json();
    assert.equal(done.ownerAck.withoutTenant, true);

    const out = await t.start('move_out');
    assert.deepEqual(out.rooms.map((x: { name: string }) => x.name), r.rooms.map((x: { name: string }) => x.name), 'same rooms as move-in');
    assert.equal(out.moveIn.id, r.id);
    assert.equal(out.rooms[0].owner, undefined, 'a fresh start');
    assert.equal((await t.owner('DELETE', `/api/condition-reports/${out.id}`)).status, 200, 'an unsent report can be removed');
  } finally { t.close(); }
});

test('move-out points the owner to the reports only when one is on file', async () => {
  for (const withReport of [false, true]) {
    const t = boot();
    try {
      if (withReport) t.store.insert('conditionReports', { ownerId: t.s.owner.id, propertyId: t.s.home.id, tenantIds: [t.s.tenant.id], kind: 'move_in', status: 'done', rooms: [], createdAt: '2026-01-01T00:00:00Z', ownerAck: { name: 'Nate', at: '2026-01-02T00:00:00Z' } });
      t.svc.engine.emit('moveout.notice', { ownerId: t.s.owner.id, tenantId: t.s.tenant.id, date: '2026-10-20' });
      await t.svc.engine.drain();
      const task = t.store.find('tasks', (x) => x.title.startsWith('Move-out walkthrough'))!;
      assert.equal(/condition report is under Homes/.test(task.detail), withReport);
    } finally { t.close(); }
  }
});
