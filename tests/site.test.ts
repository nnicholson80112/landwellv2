// The public website, the /sms page Twilio's A2P 10DLC reviewers read, and the texting
// clauses in the Privacy policy and Terms. Nothing here talks to the outside world: fetch is
// wrapped so only this machine's test server can be reached.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { MemoryStore } from '../src/store/store.ts';
import { FakeClock, SystemClock } from '../src/engine/clock.ts';
import { createServices } from '../src/services.ts';
import { install } from '../src/workflows/index.ts';
import { seed } from '../src/sim/seed.ts';
import { runDemo } from '../src/sim/demo.ts';
import { createApp, loadStatic } from '../src/api/server.ts';
import { BUSINESS } from '../src/config/business.ts';
import { BRAND } from '../src/config/brand.ts';
import { LIST_PRICE } from '../src/billing/offers.ts';
import { OWNER_SMS_OPT_IN, POLICY_LINKS, SMS_NO_SHARING, SMS_SAMPLES, privacyPolicy, smsKeywordReplies, smsProgram, termsOfService } from '../src/api/legal.ts';

// Only the local test server may be fetched (no Stripe, Twilio, Postmark, Anthropic, Calendly...).
const realFetch = globalThis.fetch;
globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(url)) return Promise.reject(new Error(`blocked external request in tests: ${url}`));
  return realFetch(input, init);
}) as typeof fetch;

const root = new URL('../', import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), 'utf8');
const SITE = read('apps/site/index.html');
const BODY = read('apps/site/site.body.html');
const text = (html: string) => html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ');

async function withServer<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const store = new MemoryStore();
  const svc = createServices({ store, clock: new SystemClock(), env: {} });
  install(svc);
  seed(store, {});
  const server = createApp(svc).listen(0);
  try { return await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`); } finally { server.close(); }
}

/* ---------------- the website ---------------- */

test('site: index.html is the build of site.body.html (run npm run build:site after editing)', () => {
  const head = BODY.match(/^[\s\S]*?<\/style>/)![0];
  const rest = BODY.slice(head.length);
  assert.ok(SITE.includes(head) && SITE.includes(rest), 'apps/site/index.html is out of date: run npm run build:site');
});

test('site: three plans, both terms, exact Stripe prices, and the plan ids the signup API takes', () => {
  const want = [
    { id: 'essentials', name: 'Essentials', monthly: 10, annual: 8 },
    { id: 'autopilot', name: 'Autopilot', monthly: 15, annual: 12 },
    { id: 'pro', name: 'Autopilot Pro', monthly: 20, annual: 16 },
  ];
  const cards = SITE.split(/<div class="plan(?: pop)?">/).slice(1).map((c) => c.split('</button>')[0]);
  assert.equal(cards.length, 3, 'three plan cards');
  want.forEach((p, i) => {
    const c = cards[i];
    assert.match(c, new RegExp(`<h3>${p.name}</h3>`));
    const amounts = [...c.matchAll(/<span class="amt[^"]*">\$(\d+)<\/span>/g)].map((m) => Number(m[1]));
    assert.deepEqual(amounts, [p.monthly, p.annual], `${p.name}: $${p.monthly} month-to-month, $${p.annual} on the 12-month agreement`);
    assert.match(c, /Month-to-month/);
    assert.match(c, /12-month agreement, billed monthly/);
    assert.match(c, new RegExp(`data-plan="${p.id}"`), `${p.name} button opens signup with plan ${p.id}`);
  });
  assert.match(cards[1], /class="tag"/, 'Autopilot is the highlighted plan');
  // Plan contents, from the Stripe product descriptions.
  for (const item of ['Rent reminders and late notices', 'Repair requests and vendor list', 'Guided tenant fixes', 'Applications and screening', 'Lease fill-in and e-sign', 'Income and expense books']) assert.ok(cards[0].includes(item), `Essentials: ${item}`);
  for (const item of ['Everything in Essentials', '24/7 tenant text and email assistant', 'Automatic dispatch to your vendors and staff', 'Renewals, move-outs and deposit statements', 'Monthly statements']) assert.ok(cards[1].includes(item), `Autopilot: ${item}`);
  for (const item of ['Everything in Autopilot', '24/7 emergency repair dispatch', 'Smart-lock self-showings', 'Listings on Zillow and more', 'Priority support']) assert.ok(cards[2].includes(item), `Autopilot Pro: ${item}`);
  // The calculator and the signup quote use the same numbers.
  const js = SITE.match(/var PRICE=(\{[^;]+\});/)![1].replace(/(\w+):/g, '"$1":').replace(/'/g, '"');
  const price = JSON.parse(js);
  for (const p of want) assert.deepEqual([price[p.id].name, price[p.id].monthly, price[p.id].contract12], [p.name, p.monthly, p.annual]);
  // Signup form: plan and term values the API accepts. Sends 'pro' (the API takes 'plus' only as a legacy alias).
  const planSelect = SITE.match(/<select id="m-plan">([\s\S]*?)<\/select>/)![1];
  assert.deepEqual([...planSelect.matchAll(/value="(\w+)"/g)].map((m) => m[1]), ['essentials', 'autopilot', 'pro']);
  const termSelect = SITE.match(/<select id="m-term"[^>]*>([\s\S]*?)<\/select>/)![1];
  assert.deepEqual([...termSelect.matchAll(/value="(\w+)"/g)].map((m) => m[1]), ['monthly', 'contract12']);
  assert.match(SITE, /fetch\('\/api\/public\/signup'/);
  assert.match(SITE, /plan:\$\('#m-plan'\)\.value,term:\$\('#m-term'\)\.value/);
  assert.match(SITE, /agree:\$\('#m-agree'\)\.checked,smsConsent:\$\('#m-sms'\)\.checked/);
  const t = text(SITE);
  assert.match(t, /first month is charged at checkout/i);
  assert.match(t, /No setup fee/);
  assert.match(t, /Cancel anytime/i);
});

test('site: prices match the billing code once plan ids are essentials / autopilot / pro', (t) => {
  const lp = LIST_PRICE as Record<string, Record<string, number>>;
  if (!lp.pro) return t.skip('billing still uses the old plan ids; checked after the billing rename is merged');
  assert.deepEqual([lp.essentials.monthly, lp.essentials.contract12, lp.autopilot.monthly, lp.autopilot.contract12, lp.pro.monthly, lp.pro.contract12], [1000, 800, 1500, 1200, 2000, 1600]);
});

test('site: brand and writing rules, no third-party requests, footer and CTAs', () => {
  assert.doesNotMatch(SITE, /landwell/i, 'no old name');
  assert.doesNotMatch(SITE, /—/, 'no em dashes');
  assert.doesNotMatch(SITE, /–/, 'no en dashes either');
  assert.doesNotMatch(SITE, /<script[^>]+src=/i, 'no external scripts');
  assert.doesNotMatch(SITE, /<link[^>]+href="(https?:)?\/\//i, 'no external stylesheets, fonts or preloads');
  assert.doesNotMatch(SITE, /url\(\s*['"]?(https?:)?\/\//i, 'no external CSS urls');
  assert.doesNotMatch(SITE, /@import/i);
  assert.doesNotMatch(SITE, /<(img|iframe|video|audio|source)[^>]+src="(https?:)?\/\//i, 'no embeds');
  assert.doesNotMatch(SITE, /fonts\.googleapis|fonts\.gstatic|google-analytics|googletagmanager|facebook\.net/i);
  assert.doesNotMatch(SITE, /document\.cookie|localStorage|sessionStorage/, 'no cookies or browser storage');
  assert.match(SITE, /@font-face\{font-family:'Bricolage Grotesque'[^}]*src:url\(\/fonts\/bricolage-grotesque-latin\.woff2\)/);
  assert.match(SITE, /@font-face\{font-family:'Figtree'[^}]*src:url\(\/fonts\/figtree-latin\.woff2\)/);
  assert.match(SITE, /#F6F9FF/i); assert.match(SITE, /#0E1B33/i); assert.match(SITE, /#1B4DFF/i); assert.match(SITE, /#FFC83D/i); assert.match(SITE, /#0E9F6E/i);
  // Hero and CTAs.
  assert.match(SITE, /<h1>[^<]*Your rentals, handled\./);
  assert.match(text(SITE), /Colorado landlords with 1 to 50 homes/);
  assert.match(text(SITE), /8 to 12% of rent/);
  assert.ok((SITE.match(/data-open="start"/g) ?? []).length >= 5, 'Get started is everywhere');
  assert.ok((SITE.match(/href="\/demo"/g) ?? []).length >= 3, 'Book a demo call goes to /demo (the Calendly redirect)');
  // FAQ topics.
  for (const q of ['rent money', 'fair housing', 'emergency', 'privacy', 'Colorado rules', 'cancel']) assert.match(SITE, new RegExp(`<summary>[^<]*${q}`, 'i'), `FAQ covers ${q}`);
  // Footer: every policy page, including /sms, plus the business placeholders.
  const footer = SITE.slice(SITE.indexOf('<footer'), SITE.indexOf('</footer>'));
  for (const [href] of POLICY_LINKS) assert.match(footer, new RegExp(`href="${href}"`), `footer links to ${href}`);
  assert.match(footer, /href="\/sms">Text messages</);
  assert.match(footer, /\{\{BUSINESS_LEGAL_NAME\}\}/);
  assert.match(footer, /<span class="addr">\{\{BUSINESS_ADDRESS\}\}<\/span>/, 'address sits in its own element, hidden when empty');
  assert.match(SITE, /\.addr:empty\{display:none\}/);
  assert.match(footer, /mailto:\{\{BUSINESS_EMAIL\}\}/);
  // Owner texting consent: optional, unchecked, same words as /sms.
  const sms = SITE.match(/<input type="checkbox" id="m-sms"[^>]*>/)![0];
  assert.doesNotMatch(sms, /checked|required/, 'texting box starts unchecked and is optional');
  assert.ok(text(SITE).includes(OWNER_SMS_OPT_IN), 'signup checkbox wording matches OWNER_SMS_OPT_IN');
  assert.match(SITE, /<input type="checkbox" id="m-agree" required>/);
});

test('server: / is filled in, sets no cookies, and shows no empty address line', async () => {
  const saved = BUSINESS.address;
  try {
    BUSINESS.address = '';
    loadStatic();
    await withServer(async (base) => {
      const r = await fetch(base + '/');
      assert.equal(r.status, 200);
      assert.equal(r.headers.get('set-cookie'), null, 'no cookies on the public site');
      const html = await r.text();
      assert.doesNotMatch(html, /\{\{[A-Z_]+\}\}/);
      assert.match(html, /<span class="addr"><\/span><a href="mailto:/, 'empty address: element is empty (hidden by CSS)');
      assert.match(html, new RegExp(`&copy; \\d{4} ${BUSINESS.legalName}`));
      for (const p of ['/privacy', '/terms', '/sms']) {
        const page = await (await fetch(base + p)).text();
        assert.doesNotMatch(page, /LLC,\s*[.<]|,\s*<\/p>|·\s*·/, `${p}: no stray commas or dots without an address`);
        assert.match(page, /KeyHelm LLC\. Email <a href="mailto:|Email <a href="mailto:[^"]+">[^<]+<\/a>\. KeyHelm LLC\./, `${p}: contact line reads "KeyHelm LLC." with no address`);
        assert.match(page, new RegExp(`<p>${BUSINESS.legalName} · <a href="mailto:`), `${p}: footer goes straight from name to email`);
      }
    });
    BUSINESS.address = 'PO Box 123, Denver, CO 80202';
    loadStatic();
    await withServer(async (base) => {
      const home = await (await fetch(base + '/')).text();
      assert.match(home, /<span class="addr">PO Box 123, Denver, CO 80202<\/span>/);
      const sms = await (await fetch(base + '/sms')).text();
      assert.match(sms, /KeyHelm LLC, PO Box 123, Denver, CO 80202\./);
    });
  } finally {
    BUSINESS.address = saved;
    loadStatic();
  }
});

/* ---------------- /sms and the A2P wording ---------------- */

test('GET /sms: the text message program page has everything A2P reviewers look for', async () => {
  await withServer(async (base) => {
    const r = await fetch(base + '/sms');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') ?? '', /text\/html/);
    const html = await r.text();
    assert.equal(html, smsProgram(), 'served from the legal page builder');
    const t = text(html);
    assert.match(html, /<title>KeyHelm text messages \| KeyHelm<\/title>/);
    assert.match(html, /<h1>KeyHelm text messages<\/h1>/);
    assert.doesNotMatch(html, /Draft\./, 'owner-approved: no draft notice');
    assert.doesNotMatch(html, /—|landwell/i);
    // Sender.
    assert.match(t, /sent by KeyHelm LLC on behalf of landlords/);
    // Program description.
    for (const w of [/Repair updates/, /Rent reminders/, /Showing scheduling/, /Lease, renewal, move-in and move-out notices/, /Replies to messages you send/]) assert.match(t, w);
    assert.match(t, /never send marketing or promotional texts/i);
    // Opt-in paths.
    assert.match(t, /landlord adds you to KeyHelm/i);
    assert.match(t, /first text is a welcome message/i);
    assert.match(t, /When you text a landlord's KeyHelm number/);
    assert.match(t, /optional checkbox that starts unchecked/);
    assert.ok(t.includes(OWNER_SMS_OPT_IN), 'quotes the signup checkbox word for word');
    assert.match(t, /don't have to check it to buy/);
    // Frequency, rates, keywords, support.
    assert.match(t, /Message frequency varies/);
    assert.match(t, /Message and data rates may apply/);
    assert.match(t, /Reply STOP/); assert.match(t, /Reply START/); assert.match(t, /Reply HELP/);
    assert.ok(t.includes(smsKeywordReplies().help), 'shows the HELP reply');
    assert.match(html, new RegExp(`mailto:${BUSINESS.email.replace(/\./g, '\\.')}`), 'support email');
    assert.match(html, /href="\/privacy"/); assert.match(html, /href="\/terms"/);
    // The no-sharing statement, word for word.
    assert.equal(SMS_NO_SHARING, 'No mobile information will be shared with third parties or affiliates for marketing or promotional purposes.');
    assert.ok(t.includes(SMS_NO_SHARING));
    assert.match(t, /opt-in data and consent are not shared with any third parties/);
    assert.match(t, /carriers are not liable for delayed or undelivered messages/i);
    // 3 to 5 samples, each shown.
    assert.ok(SMS_SAMPLES.length >= 3 && SMS_SAMPLES.length <= 5);
    for (const s of SMS_SAMPLES) assert.ok(t.includes(s.text.replace(/\s+/g, ' ')), `sample shown: ${s.label}`);
    assert.ok(SMS_SAMPLES.some((s) => /Reply STOP/.test(s.text)), 'one sample shows how to opt out');
    assert.ok(SMS_SAMPLES.filter((s) => s.text.includes(BRAND.name)).length >= 2, 'samples name the brand');
    // Footer on every legal page links to /sms.
    const privacy = await (await fetch(base + '/privacy')).text();
    assert.match(privacy, /<a href="\/sms">Text messages<\/a>/);
  });
});

test('sample texts are what the workflows really send', async () => {
  const b = BRAND.name;
  const shapes: [string, RegExp][] = [
    ['welcome', new RegExp(`^Hi [A-Z][a-z]+! Your landlord now uses ${b} for .+\\. Text this number anytime for repairs \\(send a photo\\) or questions\\. You'll keep paying rent to your landlord the same way; we'll just send you a reminder before it's due\\. Reply STOP to opt out of texts\\.$`)],
    ['rent reminder', /^Hi [A-Z][a-z]+, a heads-up: rent of \$[\d,]+ for .+ is due [A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}\. .+$/],
    ['repair update', /^Your repair is booked with .+ \(.+\)\. If you need to reach them: \d{3}-\d{3}-\d{4}\. Text me here if anything changes\.$/],
    ['showing', /^You're booked for [A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} [AP]M at .+\. Your door code arrives 15 minutes before\.$/],
    ['owner alert', new RegExp(`^${b}: Repair \\$[\\d,]+: .+\\. .+ can do ".+" .+ for \\$[\\d,]+\\. Your limit is \\$[\\d,]+\\.\\nReply YES [A-Z2-9]{3} \\(Approve\\) or NO [A-Z2-9]{3} \\(Decline\\)\\.$`)],
  ];
  assert.equal(SMS_SAMPLES.length, shapes.length);
  SMS_SAMPLES.forEach((s, i) => assert.match(s.text, shapes[i][1], `sample ${i + 1} (${shapes[i][0]}) has the code's wording`));
  // The sample's rent "how to pay" line is the default the rent workflow uses when the owner hasn't set one.
  assert.match(read('src/workflows/rent.ts'), /DEFAULT_HOW_TO_PAY = 'Please pay your landlord the way you normally do\.'/);
  assert.ok(SMS_SAMPLES[1].text.endsWith('Please pay your landlord the way you normally do.'));

  // Real texts: the full demo month, plus a tenant welcome.
  const { store } = await runDemo({ quiet: true });
  const sent = store.list('messages', (m) => m.direction === 'out').map((m) => m.body);
  const clock = new FakeClock('2026-10-12T16:00:00Z'); // Mon 10:00 AM Denver, outside quiet hours
  const st2 = new MemoryStore();
  const svc = createServices({ store: st2, clock, env: {} });
  install(svc);
  const s = seed(st2, {});
  svc.engine.emit('tenant.added', { tenantId: s.tenant.id });
  await svc.engine.drain();
  sent.push(...st2.list('messages', (m) => m.direction === 'out').map((m) => m.body));
  for (const [name, re] of shapes) assert.ok(sent.some((body) => re.test(body)), `the workflows send a ${name} text in this shape`);
});

test('HELP / STOP / START replies for Twilio Advanced Opt-Out: one plain text each', () => {
  const r = smsKeywordReplies();
  const gsm = /^[A-Za-z0-9 @$_!"#%&'()*+,\-./:;<=>?\n]*$/;
  for (const [k, v] of Object.entries(r)) {
    assert.ok(v.startsWith(`${BRAND.name}:`), `${k} reply names the brand`);
    assert.ok(v.length <= 160, `${k} reply fits one text (${v.length})`);
    assert.match(v, gsm, `${k} reply uses only plain GSM characters`);
  }
  assert.match(r.help, /Msg frequency varies\. Msg & data rates may apply\. Reply STOP to opt out\./);
  assert.ok(r.help.includes(BUSINESS.email));
  assert.match(r.stop, /unsubscribed/); assert.match(r.stop, /START/);
  assert.match(r.start, /HELP/); assert.match(r.start, /STOP/);
  for (const s of SMS_SAMPLES) assert.match(s.text, gsm, `sample "${s.label}" is plain GSM text`);
});

/* ---------------- Privacy policy and Terms ---------------- */

test('privacy policy: A2P texting clauses, consent data excluded from sharing', () => {
  const html = privacyPolicy();
  const t = text(html);
  assert.ok(t.includes(SMS_NO_SHARING));
  assert.match(t, /Text messaging originator opt-in data and consent are excluded from every sharing category in this policy and will not be shared with any third parties\./);
  assert.match(t, /We do not sell personal information/);
  assert.match(html, /<h2>Text messages<\/h2>/);
  assert.match(t, /Message frequency varies\. Message and data rates may apply\. Reply STOP to stop texts or HELP for help\./);
  assert.match(t, /not a condition of purchase/);
  assert.match(html, /href="\/sms"/);
  assert.doesNotMatch(html, /—|Draft\./);
});

test('terms: a Text messaging section with program, consent, frequency, rates, HELP/STOP and carriers', () => {
  const html = termsOfService();
  const section = html.slice(html.indexOf('<h2>5. Text messaging</h2>'), html.indexOf('<h2>6.'));
  assert.ok(section.length > 200, 'section 5 is Text messaging');
  const t = text(section);
  assert.match(t, /sent by KeyHelm LLC on behalf of landlords/);
  assert.match(t, /repair updates, rent reminders and late notices, showing scheduling, lease, renewal, move-in and move-out notices/);
  assert.match(t, /consent is not a condition of purchase/);
  assert.match(t, /only if they have agreed to get texts from you about your rental/);
  assert.match(t, /Message frequency varies\./);
  assert.match(t, /Message and data rates may apply\./);
  assert.match(t, /Reply HELP for help or STOP to cancel/);
  assert.match(t, /Mobile carriers are not liable for delayed or undelivered messages\./);
  assert.ok(t.includes(SMS_NO_SHARING));
  assert.match(section, /href="\/sms"/);
  assert.doesNotMatch(html, /—|Draft\./);
});

test('live check covers /sms', () => {
  assert.match(read('scripts/live-check.mjs'), /\['\/sms', /);
});

test('legal pages are finished: no bracketed placeholders, 12-month agreement terms spelled out', async () => {
  const { termsOfService, refundPolicy, privacyPolicy, smsProgram, cookiePolicy } = await import('../src/api/legal.ts');
  for (const [name, page] of [['terms', termsOfService()], ['refunds', refundPolicy()], ['privacy', privacyPolicy()], ['sms', smsProgram()], ['cookies', cookiePolicy()]] as const) {
    const text = page.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ');
    assert.doesNotMatch(text, /\[[A-Z][^\]]{8,}\]/, `${name} still has a placeholder`);
    assert.doesNotMatch(text, /attorney/i, `${name} mentions an attorney`);
  }
  assert.match(refundPolicy(), /Ending a 12-month agreement early/);
  assert.match(termsOfService(), /continues <b>month to month at the same agreement price<\/b>/);
  assert.match(termsOfService(), /Arapahoe County, Colorado/);
});
