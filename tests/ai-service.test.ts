import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { KeyHelmAI } from '../src/ai-service/server.ts';
import type { CommunicationAI, AIInput } from '../src/ai/types.ts';
import { MemoryStore } from '../src/store/store.ts';
import { SystemClock } from '../src/engine/clock.ts';
import { createServices } from '../src/services.ts';
import { install } from '../src/workflows/index.ts';
import { seed } from '../src/sim/seed.ts';
import { createApp } from '../src/api/server.ts';

const input = (message: string, extra: Partial<AIInput> = {}): AIInput => ({
  channel: 'sms', senderRole: 'tenant', message, mediaCount: 0, history: [], facts: [{ label: 'Rent due date', value: 'on the 1st' }],
  allowedIntents: ['maintenance_request', 'rent_question', 'general', 'emergency', 'accommodation_request'], ownerFirstName: 'Nate', brandName: 'KeyHelm', ...extra,
});

test('in-house AI: falls back when the model fails, logs every exchange', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-'));
  const broken: CommunicationAI = { name: 'broken', respond: async () => { throw new Error('model down'); } };
  const ai = new KeyHelmAI({ chain: [broken], logDir: dir });
  const r = await ai.respond(input('My toilet is clogged'));
  assert.equal(r.intent, 'maintenance_request');
  assert.equal(ai.stats.errors, 1);
  const log = readFileSync(join(dir, readdirSync(dir)[0]), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(log.length, 1);
  assert.match(log[0].errors[0], /model down/);
});

test('in-house AI: guardrails run even if the model would answer', async () => {
  let called = false;
  const model: CommunicationAI = { name: 'm', respond: async () => { called = true; return { intent: 'general', confidence: 1, reply: 'Sure!', entities: {}, handoff: false, provider: 'm' }; } };
  const ai = new KeyHelmAI({ chain: [model] });
  const r = await ai.respond(input('I need a wheelchair ramp, I have a disability'));
  assert.equal(called, false);
  assert.equal(r.handoff, true);
  const bad: CommunicationAI = { name: 'b', respond: async () => ({ intent: 'rent_question', confidence: 1, reply: 'I can lower it to $1,500.', entities: {}, handoff: false, provider: 'b' }) };
  const r2 = await new KeyHelmAI({ chain: [bad] }).respond(input('Can you lower my rent?'));
  assert.equal(r2.handoff, true);
  assert.doesNotMatch(r2.reply, /\$1,500/);
});

test('phone line: Twilio voice turns get spoken replies', async () => {
  const store = new MemoryStore();
  const svc = createServices({ store, clock: new SystemClock(), env: {} });
  install(svc);
  const s = seed(store, {});
  store.update('owners', s.owner.id, { plan: 'pro' }); // voice AI answers calls on Autopilot Pro
  const server = createApp(svc).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const form = (o: Record<string, string>) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o) });
  try {
    const greet = await (await fetch(`${base}/webhooks/twilio/voice`, form({ From: s.tenant.phone!, To: s.owner.lineNumber!, CallSid: 'CA1' }))).text();
    assert.match(greet, /<Gather input="speech"/);
    const turn = await (await fetch(`${base}/webhooks/twilio/voice/turn`, form({ From: s.tenant.phone!, To: s.owner.lineNumber!, CallSid: 'CA1', SpeechResult: 'When is rent due' }))).text();
    assert.match(turn, /due on the 1st/);
    const emerg = await (await fetch(`${base}/webhooks/twilio/voice/turn`, form({ From: s.tenant.phone!, To: s.owner.lineNumber!, CallSid: 'CA2', SpeechResult: 'There is water pouring from the ceiling, burst pipe' }))).text();
    assert.match(emerg, /<Dial/);
    // GlassHouse is the preferred vendor for window jobs at the demo home
    assert.equal(s.home.address, '7610 S Rosemary Cir');
    assert.equal(s.windowCo.name, 'GlassHouse Exteriors');
  } finally {
    server.close();
  }
});
