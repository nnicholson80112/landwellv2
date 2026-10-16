import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/store/store.ts';
import { SystemClock } from '../src/engine/clock.ts';
import { createServices } from '../src/services.ts';
import { install } from '../src/workflows/index.ts';
import { seed } from '../src/sim/seed.ts';
import { menuChoice } from '../src/workflows/inbound-message.ts';
import type { AIInput, AIResult, CommunicationAI } from '../src/ai/types.ts';

/** Stands in for Claude: always keeps troubleshooting, so the tenant's menu choice decides. */
class Troubleshooter implements CommunicationAI {
  name = 'stub';
  async respond(input: AIInput): Promise<AIResult> {
    return { intent: 'maintenance_request', confidence: 0.9, reply: 'Sorry about that! Is the water coming from the faucet base or under the sink?', entities: { trade: 'plumbing', urgency: 'routine', summary: 'Kitchen sink leaking', repairAction: 'troubleshoot' }, handoff: false, provider: this.name };
  }
}

function setup() {
  const store = new MemoryStore();
  const svc = createServices({ store, clock: new SystemClock(), env: {}, ai: new Troubleshooter() });
  install(svc);
  const s = seed(store, {});
  const text = async (from: string, body: string) => { svc.engine.emit('message.received', { from, channel: 'sms', body, media: [], ownerId: s.owner.id, providerMessageId: String(Math.random()) }); await svc.engine.drain(); };
  const lastTo = (to: string) => store.list('messages', (m) => m.direction === 'out' && m.to === to).pop();
  return { store, s, text, lastTo };
}

test('menu words map to choices', () => {
  assert.equal(menuChoice('1'), 'dispatch');
  assert.equal(menuChoice('Call me'), 'call');
  assert.equal(menuChoice('email me instead'), 'email');
  assert.equal(menuChoice("It's fixed!"), 'fixed');
  assert.equal(menuChoice('9'), 'emergency');
  assert.equal(menuChoice('it is still leaking'), undefined);
});

test('repair chat: troubleshoot first, then the tenant picks "send a pro"', async () => {
  const { store, s, text, lastTo } = setup();
  await text(s.tenant.phone!, 'The kitchen sink is leaking');
  assert.equal(store.list('workOrders').length, 0, 'no vendor yet while troubleshooting');
  const first = lastTo(s.tenant.phone!)!;
  assert.match(first.body, /1 Send a pro · 2 Call me · 3 Email me · 4 It's fixed · 9 Emergency/);
  assert.ok(Array.isArray(first.meta?.options));
  await text(s.tenant.phone!, '1');
  const wo = store.list('workOrders')[0];
  assert.equal(wo.summary, 'Kitchen sink leaking');
  assert.equal(wo.trade, 'plumbing');
  assert.match(lastTo(s.tenant.phone!)!.body, /Booking a pro/);
});

test('repair chat: "it\'s fixed" closes it, "call me" and "9" reach the owner', async () => {
  const { store, s, text, lastTo } = setup();
  await text(s.tenant.phone!, 'The kitchen sink is leaking');
  await text(s.tenant.phone!, "it's fixed");
  assert.equal(store.list('workOrders').length, 0);
  assert.match(lastTo(s.tenant.phone!)!.body, /glad it's working/);

  await text(s.tenant.phone!, 'The kitchen sink is leaking again');
  const toOwner = () => store.list('messages', (m) => m.direction === 'out' && m.to === s.owner.phone).map((m) => m.body).join('\n');
  await text(s.tenant.phone!, 'call me');
  assert.match(toOwner(), /asked for a call/);
  await text(s.tenant.phone!, '9');
  assert.match(toOwner(), /URGENT: Lisa Chen pressed EMERGENCY/);
  assert.equal(store.list('workOrders')[0].urgency, 'emergency');
});

test('repair chat: "email me" continues by email', async () => {
  const { s, text, lastTo } = setup();
  await text(s.tenant.phone!, 'The kitchen sink is leaking');
  await text(s.tenant.phone!, '3');
  const mail = lastTo(s.tenant.email!)!;
  assert.equal(mail.channel, 'email');
  assert.match(mail.body, /Kitchen sink leaking/);
});

test('flooding gets shut-off help and a plumber, not 911', async () => {
  const { s, text, lastTo } = setup();
  await text(s.tenant.phone!, 'Water is pouring out from under the dishwasher');
  const r = lastTo(s.tenant.phone!)!.body;
  assert.match(r, /shut-off/);
  assert.doesNotMatch(r, /911/);
  assert.doesNotMatch(lastTo(s.owner.phone)!.body, /911/);
});

test('owner texting a question is not treated as a bad approval code', async () => {
  const { s, text, lastTo } = setup();
  await text(s.owner.phone, 'Is the Aspen Court place available?');
  assert.doesNotMatch(lastTo(s.owner.phone)!.body, /couldn't match code/);
});
