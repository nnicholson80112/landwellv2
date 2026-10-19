import { test } from 'node:test';
import assert from 'node:assert/strict';
import { precheck, postcheck, checkAdCopy } from '../src/ai/guardrails.ts';
import { RuleBasedAI, summarize, guessTrade } from '../src/ai/rules.ts';
import { prepareTemplate, fillTemplate } from '../src/leases/template.ts';
import { cappedLateFee } from '../src/config/colorado.ts';
import { compareCriteria } from '../src/workflows/leasing.ts';

test('guardrails route sensitive topics to the owner', () => {
  assert.equal(precheck('Do you accept service animals? I have a disability').intent, 'accommodation_request');
  assert.equal(precheck('Is this a safe neighborhood?').intent, 'fair_housing_sensitive');
  assert.equal(precheck('Are there good schools nearby for my kids?').route, true);
  assert.equal(precheck('Why was my application denied?').intent, 'screening_decision_question');
  assert.equal(precheck('I will call my lawyer about this').intent, 'complaint_or_legal');
  assert.equal(precheck('I smell gas').emergency, true);
  assert.equal(precheck('The faucet drips').route, false);
  // Everyday words that must NOT be mistaken for legal or accommodation topics.
  assert.equal(precheck('Is the Aspen Court place still available, and do you allow dogs?').route, false, 'street names with Court');
  assert.equal(precheck('This is Sue from unit B, the dryer is broken').route, false, 'a tenant named Sue');
  assert.equal(precheck("I'm hearing a weird noise from the furnace").route, false, 'hearing a noise');
  assert.equal(precheck('I am going to take you to court').intent, 'complaint_or_legal');
  assert.equal(precheck("I'm going to sue the landlord").intent, 'complaint_or_legal');
  assert.equal(precheck('I wear a hearing aid, could you add a doorbell light?').intent, 'accommodation_request');
});

test('postcheck blocks invented amounts and steering language', () => {
  const facts = [{ label: 'Rent for 1 Main St', value: '$2,150/month, all-in' }];
  assert.equal(postcheck('Rent is $2,150 a month.', facts).ok, true);
  assert.equal(postcheck('I can do $1,900 for you!', facts).ok, false);
  assert.equal(postcheck('It is perfect for families.', facts).ok, false);
  assert.equal(postcheck("You're approved!", facts).ok, false);
  assert.equal(checkAdCopy('Great home, adults only').ok, false);
});

test('rule-based AI classifies common messages', async () => {
  const ai = new RuleBasedAI();
  const base = { channel: 'sms' as const, mediaCount: 0, history: [], facts: [{ label: 'Pet policy', value: 'Cats only.' }], ownerFirstName: 'Nate', brandName: 'KeyHelm' };
  const all = ['maintenance_request', 'rent_question', 'listing_question', 'showing_request', 'renewal_response', 'move_out_notice', 'general', 'vendor_update', 'application_question', 'lease_question'] as any;
  assert.equal((await ai.respond({ ...base, senderRole: 'tenant', message: 'My toilet is clogged', allowedIntents: all })).entities.trade, 'plumbing');
  assert.equal((await ai.respond({ ...base, senderRole: 'prospect', message: 'Do you allow cats?', allowedIntents: all })).reply, 'Cats only. Would you like to schedule a self-guided tour?');
  const v = await ai.respond({ ...base, senderRole: 'vendor', message: 'YES Thu 1-3 $220', allowedIntents: all });
  assert.equal(v.entities.vendorAccept, true);
  assert.equal(v.entities.vendorQuote, 220);
  const d = await ai.respond({ ...base, senderRole: 'vendor', message: 'Done, $240', allowedIntents: all });
  assert.equal(d.entities.vendorDone, true);
  assert.equal(d.entities.vendorInvoice, 240);
  assert.equal(summarize('Hi! The sink is leaking under the cabinet. Can someone come?'), 'The sink is leaking under the cabinet');
  assert.equal(guessTrade('I smell gas'), 'plumbing');
});

test('lease templates: blanks become fields, then fill', () => {
  const p = prepareTemplate('Made on ________ between ________ ("Landlord") and ________ ("Tenant"). Monthly rent of $______. Deposit of $______. Weird blank ______.');
  assert.deepEqual(p.fields, ['today', 'owner_name', 'tenant_names', 'monthly_rent', 'security_deposit', 'blank_1']);
  const f = fillTemplate(p.body, { today: '2026-10-12', owner_name: 'Nate', tenant_names: 'Lisa', monthly_rent: '$2,150', security_deposit: '$2,150' });
  assert.match(f.text, /monthly rent of \$2,150\./i);
  assert.deepEqual(f.missing, ['blank_1']);
});

test('Colorado late fee cap: greater of $50 or 5%', () => {
  assert.equal(cappedLateFee(10_000, 150_000), 7_500); // 5% of $1,500 = $75
  assert.equal(cappedLateFee(10_000, 80_000), 5_000); // $50 floor
  assert.equal(cappedLateFee(2_500, 300_000), 2_500); // owner asked for less
});

test('criteria comparison is mechanical, no scores', () => {
  const rows = compareCriteria([{ key: 'income_multiple', label: '3x rent', value: 3 }, { key: 'references', label: '1 ref', value: 1 }], { provider: 'x', monthlyIncome: 500_000, referencesConfirmed: 0, agencyContact: 'x' }, 200_000);
  assert.deepEqual(rows.map((r) => r.met), ['no', 'no']);
});
