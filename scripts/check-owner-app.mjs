// Browser check for the owner app (/app). Not part of `npm test`: it needs a browser.
//
// Starts a local server on demo data (temp DATA_FILE, SEED_DEMO=true, throwaway ADMIN_API_TOKEN, no outside
// services: every provider is the built-in mock), makes some real activity through the dev endpoints, signs in
// with a one-time admin link, then clicks through every screen at phone (390px) and desktop (1280px) widths and
// tries the main actions. Fails on any console error, page error, or request that leaves localhost (those are
// blocked, never sent).
//
// Playwright is NOT a dependency of this repo. Point at an existing install:
//   PLAYWRIGHT_MODULE=/path/to/node_modules/playwright node scripts/check-owner-app.mjs
// Defaults: PLAYWRIGHT_MODULE=/opt/node-tools/node_modules/playwright, PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers.
// Screenshots go to CHECK_OUT (default: a new folder in the system temp dir).

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MOD = process.env.PLAYWRIGHT_MODULE ?? '/opt/node-tools/node_modules/playwright';
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync('/opt/pw-browsers')) process.env.PLAYWRIGHT_BROWSERS_PATH = '/opt/pw-browsers';
let pw;
try { pw = createRequire(import.meta.url)(MOD); } catch {
  console.log(`Skipped: Playwright not found at ${MOD}. Set PLAYWRIGHT_MODULE to an existing install (this repo doesn't install it).`);
  process.exit(0);
}

const work = mkdtempSync(join(tmpdir(), 'kh-owner-app-'));
const OUT = process.env.CHECK_OUT ?? join(work, 'shots');
mkdirSync(OUT, { recursive: true });
const PORT = 20000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = randomBytes(18).toString('hex');
const OWNER = randomBytes(18).toString('hex');
const PASSWORD = 'blue spruce porch light';
const problems = [];
const say = (s) => console.log(s);

/* ---------- a local server with nothing but mocks ---------- */
const env = {
  PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? work, PORT: String(PORT), DATA_FILE: join(work, 'data.json'), SEED_DEMO: 'true',
  ADMIN_API_TOKEN: ADMIN, OWNER_API_TOKEN: OWNER, PUBLIC_URL: BASE, TZ_DEFAULT: 'America/Denver',
};
const server = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', 'src/api/server.ts'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });
const stop = () => { try { server.kill('SIGTERM'); } catch { /* already gone */ } };
process.on('exit', stop);

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(BASE + '/health')).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start:\n' + serverLog);
}
const call = async (method, path, body, token = OWNER) => {
  const r = await fetch(BASE + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(data)}`);
  return data;
};

async function makeActivity() {
  // A tenant reports a repair with a photo; the window company quotes over the $150 limit → a decision.
  await call('POST', '/api/dev/inbound', { from: '+17205550111', body: 'The window screen in the back bedroom is torn and the windows are dirty after the storm.', media: ['https://example.test/screen.jpg'] });
  await call('POST', '/api/dev/inbound', { from: '+17209305782', body: 'YES Wed 10-12 $180' });
  // A prospect asks about the listed home; a tenant asks something only the owner can answer (a to-do).
  await call('POST', '/api/dev/inbound', { from: '+17205550177', body: 'Hi, is 88 Aspen Ct still available? Do you allow dogs?' });
  await call('POST', '/api/dev/inbound', { from: '+17205550111', body: 'Could I install grab bars in the bathroom? I have a disability.' });
  // An applicant with a screening report → a decision (no score, no recommendation).
  const homes = await call('GET', '/api/properties');
  const listed = homes.find((p) => p.status === 'listed');
  const r = await fetch(`${BASE}/api/public/apply/${listed.id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Jordan Morales', email: 'jordan@example.com', phone: '+17205550188', agree: true }) });
  const { applicationId } = await r.json();
  await call('POST', '/api/dev/event', { event: 'screening.completed', payload: { applicationId, report: { provider: 'Sample Screening Co', monthlyIncome: 680_000, evictionsLast: { years: 5, count: 0 }, collectionsLast: { years: 2, count: 0 }, referencesConfirmed: 2, pets: 'One 30 lb dog', agencyContact: 'Sample Screening Co, Denver CO' } } });
}

/* ---------- the browser ---------- */
const TABS = ['today', 'rent', 'repairs', 'messages', 'homes', 'settings'];
/**
 * Chrome logs every 4xx response as a console error. Expected ones: /api/billing/portal (404 until that route
 * exists; the app then shows the support email) and a 400 the check triggers on purpose (`allow400`).
 */
let allow400 = '';
const expected = (text, url) => /Failed to load resource/.test(text) && (/\/api\/billing\/portal$/.test(url ?? '') || (!!allow400 && /status of 400/.test(text) && (url ?? '').endsWith(allow400)));

async function newPage(browser, label, viewport) {
  const ctx = await browser.newContext({ viewport, isMobile: label === 'phone', hasTouch: label === 'phone' });
  await ctx.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') return route.continue();
    problems.push(`[${label}] blocked a request to ${u.href}`);
    return route.abort();
  });
  const page = await ctx.newPage();
  current = page;
  page.on('console', (m) => { if (m.type() === 'error' && !expected(m.text(), m.location()?.url)) problems.push(`[${label}] console error: ${m.text()} ${m.location()?.url ?? ''}`); });
  page.on('pageerror', (e) => problems.push(`[${label}] page error: ${e.message}`));
  return { ctx, page };
}
const drawn = (page, tab) => page.waitForFunction((t) => { const v = document.getElementById('view-' + t); return !!v && !v.hidden && v.childElementCount > 0 && !v.querySelector('.loading'); }, tab, { timeout: 10_000 });
async function open(page, label, tab) {
  await page.click(`nav a[data-tab="${tab}"]`);
  await drawn(page, tab);
  if (await page.locator(`#view-${tab} .error-card`).count()) problems.push(`[${label}] ${tab}: shows an error card: ${await page.locator(`#view-${tab} .error-card`).first().innerText()}`);
  await page.screenshot({ path: join(OUT, `${label}-${tab}.png`), fullPage: true });
}
const toast = (page, text) => page.locator('#toasts .toast', { hasText: text }).first().waitFor({ timeout: 10_000 });
let current;
async function step(label, name, fn) {
  try { await fn(); say(`  ok  ${name}`); } catch (e) {
    problems.push(`[${label}] ${name}: ${e.message.split('\n')[0]}`);
    say(`  FAIL ${name}${process.env.CHECK_VERBOSE ? '\n' + e.message.split('\n').slice(0, 20).join('\n') : ''}`);
    await current?.screenshot({ path: join(OUT, `FAIL-${label}-${name.replace(/[^a-z0-9]+/gi, '-').slice(0, 40)}.png`), fullPage: true }).catch(() => {});
  }
}

async function phonePass(browser) {
  const label = 'phone';
  const { ctx, page } = await newPage(browser, label, { width: 390, height: 844 });
  const owner = (await call('GET', '/api/me')).owner;
  const link = await call('POST', `/api/admin/owners/${owner.id}/login-link`, {}, ADMIN);
  say(`Phone (390px): signing in with a one-time link for ${owner.email}`);
  await page.goto(link.url);
  await page.fill('#password', PASSWORD);
  await page.fill('#confirm', PASSWORD);
  await Promise.all([page.waitForURL(/\/app$/), page.click('button.cta')]);
  await drawn(page, 'today');
  await page.screenshot({ path: join(OUT, 'phone-today-start.png'), fullPage: true });

  await step(label, 'every tab opens without errors', async () => { for (const t of TABS) await open(page, label, t); await open(page, label, 'today'); });
  await step(label, 'no sideways scrolling on any tab', async () => {
    for (const t of TABS) {
      await open(page, label, t);
      const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (wide > 1) throw new Error(`${t} is ${wide}px wider than the screen`);
    }
    await open(page, label, 'today');
  });
  await step(label, 'tap targets are at least 48px tall', async () => {
    const small = await page.evaluate(() => Array.from(document.querySelectorAll('nav a, main .btn, main summary, main input:not([type=checkbox]):not([type=radio]), main select')).filter((e) => e.offsetParent && e.getBoundingClientRect().height < 47.5).map((e) => (e.textContent || e.getAttribute('name') || e.tagName).trim().slice(0, 30)));
    if (small.length) throw new Error('too small: ' + small.join(', '));
  });
  await step(label, 'repair over the limit: Approve', async () => {
    const card = page.locator('article.decision', { hasText: 'Repair $180' });
    await card.getByRole('button', { name: 'Approve' }).click();
    await toast(page, 'KeyHelm takes it from here');
    await page.locator('article.decision', { hasText: 'Repair $180' }).waitFor({ state: 'detached' });
  });
  await step(label, 'applicant: buttons are equal, Deny asks first, Approve shows the start date', async () => {
    const card = page.locator('article.decision', { hasText: 'Jordan Morales' });
    const classes = await card.locator('.options .btn').evaluateAll((bs) => bs.map((b) => b.className));
    if (classes.some((c) => /primary/.test(c))) throw new Error('an applicant choice is highlighted: ' + classes.join(' | '));
    await card.getByRole('button', { name: 'Deny' }).click();
    await card.getByRole('button', { name: 'Go back' }).click();
    await card.getByRole('button', { name: 'Approve' }).click();
    await card.getByLabel('Lease start date').waitFor();
    await page.screenshot({ path: join(OUT, 'phone-today-applicant.png'), fullPage: true });
    await card.getByRole('button', { name: 'Back' }).click();
  });
  await step(label, 'renewal: rent is filled in; change it and offer the renewal', async () => {
    const card = page.locator('article.decision', { hasText: 'Renewal' });
    if (!(await card.count())) return say('       (no renewal waiting on this date; skipped)');
    await card.getByRole('button', { name: 'Offer the renewal' }).click();
    const rent = card.getByLabel('Monthly rent');
    if ((await rent.inputValue()) !== '2,750') throw new Error('rent not filled in: ' + (await rent.inputValue()));
    await rent.fill('2,800');
    await card.locator('form').getByRole('button', { name: 'Offer the renewal' }).click();
    await toast(page, 'KeyHelm takes it from here');
    const a = (await call('GET', '/api/approvals?status=decided')).find((x) => x.kind === 'renewal_terms');
    if (a?.data?.rent !== 280_000) throw new Error('renewal rent not saved in cents: ' + JSON.stringify(a?.data));
  });
  await step(label, 'to-do: open the conversation, then mark it done', async () => {
    const task = page.locator('li.task', { hasText: 'Reply to Lisa Chen' }).first();
    await task.getByRole('link', { name: 'Open messages' }).click();
    await page.waitForURL(/\/app\/messages\/%2B17205550111$/);
    await drawn(page, 'messages');
    const view = page.locator('#view-messages');
    await view.getByLabel(/^Reply to Lisa/).fill('Yes, grab bars are fine. I will send someone to install them this week.');
    await view.getByRole('button', { name: 'Send' }).click();
    await toast(page, 'Sent.');
    await page.locator('.log .msg.owner', { hasText: 'grab bars are fine' }).waitFor();
    await page.screenshot({ path: join(OUT, 'phone-messages-thread.png'), fullPage: true });
    await open(page, label, 'today');
    await page.locator('li.task', { hasText: 'Reply to Lisa Chen' }).first().getByRole('button', { name: /^Done/ }).click();
    await toast(page, 'Marked done.');
  });
  await step(label, 'add a vendor (and a plain error when the name is missing)', async () => {
    await open(page, label, 'homes');
    await page.getByRole('button', { name: 'Add a vendor' }).click();
    await page.locator('dialog[open]').waitFor();
    allow400 = '/api/vendors';
    await page.locator('dialog').getByRole('button', { name: 'Add vendor' }).click();
    await page.locator('dialog [data-field="name"] .err:not([hidden])', { hasText: 'name' }).waitFor();
    allow400 = '';
    await page.screenshot({ path: join(OUT, 'phone-homes-vendor-error.png') });
    await page.locator('dialog').getByLabel('Name', { exact: true }).fill('Peak Electric');
    await page.locator('dialog').getByLabel('Electrical').check();
    await page.locator('dialog').getByLabel('Phone').fill('720-555-0166');
    await page.locator('dialog').getByRole('button', { name: 'Add vendor' }).click();
    await toast(page, 'Vendor added.');
    await page.locator('article.vendor', { hasText: 'Peak Electric' }).waitFor();
  });
  await step(label, 'add a home, then a tenant with a lease', async () => {
    await page.getByRole('button', { name: 'Add a home' }).click();
    const d = page.locator('dialog');
    await d.getByLabel('Street address').fill('412 Elm St');
    await d.getByLabel('City').fill('Denver');
    await d.getByLabel('ZIP code').fill('80205');
    await d.getByLabel('Bedrooms').fill('2');
    await d.getByLabel('Bathrooms').fill('1.5');
    await d.getByLabel('Monthly rent').fill('2,100');
    await d.getByRole('button', { name: 'Add home' }).click();
    await toast(page, 'Home added.');
    const home = page.locator('article.home', { hasText: '412 Elm St' });
    await home.getByRole('button', { name: 'Add a tenant' }).click();
    await d.getByLabel('Full name').fill('Sam Rivera');
    await d.getByLabel('Mobile number').fill('303-555-0199');
    await d.getByLabel('Starts').fill('2026-06-01');
    await d.getByLabel('Ends').fill('2027-05-31');
    await d.getByRole('button', { name: 'Add tenant' }).click();
    await toast(page, 'Tenant added');
    await home.locator('.tenants', { hasText: 'Sam Rivera' }).waitFor();
    await page.screenshot({ path: join(OUT, 'phone-homes-after.png'), fullPage: true });
  });
  await step(label, 'request a repair', async () => {
    await open(page, label, 'repairs');
    await page.getByRole('button', { name: 'Request a repair' }).click();
    const d = page.locator('dialog');
    await d.getByLabel('What needs fixing').fill('The garbage disposal hums but does not spin.');
    await d.getByLabel('Kind of work').selectOption('appliance');
    await d.getByRole('button', { name: 'Request repair' }).click();
    await toast(page, /Repair requested|Added to the repair/);
    await page.locator('article.wo', { hasText: 'garbage disposal' }).waitFor();
  });
  await step(label, 'save the rules', async () => {
    await open(page, label, 'settings');
    await page.getByLabel('Grace days').fill('4');
    await page.getByRole('button', { name: 'Save rules' }).click();
    await toast(page, 'Rules saved.');
    const saved = await call('GET', '/api/rules');
    if (saved.graceDays !== 4) throw new Error('grace days not saved: ' + saved.graceDays);
  });
  await step(label, 'Manage billing falls back to the support email', async () => {
    await page.getByRole('button', { name: 'Manage billing' }).click();
    await page.locator('section[aria-labelledby="set-billing"] .note', { hasText: 'email' }).waitFor();
  });
  await step(label, 'rent: mark a charge received (when one is open)', async () => {
    await open(page, label, 'rent');
    const charge = page.locator('article.charge').first();
    if (!(await charge.count())) return;
    await charge.getByRole('button', { name: 'Mark received' }).click();
    await charge.getByRole('button', { name: 'Save' }).click();
    await toast(page, /Marked/);
  });
  await step(label, 'offline banner shows and hides', async () => {
    await ctx.setOffline(true);
    await page.locator('#offline:not([hidden])').waitFor();
    await ctx.setOffline(false);
    await page.locator('#offline').waitFor({ state: 'hidden' });
  });
  await step(label, 'keyboard: skip link, then the first tab', async () => {
    await page.goto(BASE + '/app');
    await drawn(page, 'today');
    await page.keyboard.press('Tab');
    if ((await page.evaluate(() => document.activeElement?.className)) !== 'skip') throw new Error('first Tab should reach the skip link');
  });
  await ctx.close();
}

async function desktopPass(browser) {
  const label = 'desktop';
  const { ctx, page } = await newPage(browser, label, { width: 1280, height: 800 });
  say('Desktop (1280px): signing in with email and password');
  const owner = (await call('GET', '/api/me')).owner;
  await page.goto(BASE + '/app/messages');
  await page.waitForURL(/\/login\?next=%2Fapp%2Fmessages$/);
  await page.fill('#email', owner.email);
  await page.fill('#password', PASSWORD);
  await Promise.all([page.waitForURL(/\/app\/messages$/), page.click('button.cta')]);
  await drawn(page, 'messages');
  await step(label, 'every tab opens without errors', async () => { for (const t of TABS) await open(page, label, t); });
  await step(label, 'messages: list and conversation side by side', async () => {
    await open(page, label, 'messages');
    await page.locator('a.thread').first().click();
    await page.locator('.thread-view').waitFor();
    const both = await page.evaluate(() => { const l = document.querySelector('.list-pane'), t = document.querySelector('.thread-pane'); return !!l && !!t && l.getBoundingClientRect().width > 0 && t.getBoundingClientRect().width > 0; });
    if (!both) throw new Error('list and thread are not both visible');
    await page.screenshot({ path: join(OUT, 'desktop-messages-thread.png'), fullPage: true });
  });
  await step(label, 'browser back returns to the last screen', async () => {
    await open(page, label, 'rent');
    await open(page, label, 'homes');
    await page.goBack();
    await drawn(page, 'rent');
  });
  await step(label, 'sign out', async () => {
    await open(page, label, 'settings');
    await Promise.all([page.waitForURL(/\/login\?signed_out=1$/), page.getByRole('button', { name: 'Sign out', exact: true }).click()]);
    const r = await page.request.get(BASE + '/app', { maxRedirects: 0 });
    if (r.status() !== 302) throw new Error('still signed in after signing out');
  });
  await ctx.close();
}

/**
 * A month of activity (the `npm run demo` story: repairs done, late November rent, a late fee) on a second local
 * server, to try the Rent screen with real charges: a partial payment, then the rest.
 */
async function monthPass(browser) {
  const label = 'month';
  const port = PORT + 1;
  const url = (p) => pathToFileURL(join(ROOT, p)).href;
  const code = `
    const { runDemo } = await import(${JSON.stringify(url('src/sim/demo.ts'))});
    const { createApp } = await import(${JSON.stringify(url('src/api/server.ts'))});
    const { hashPassword } = await import(${JSON.stringify(url('src/api/auth.ts'))});
    const { svc, store, seedData } = await runDemo({ quiet: true });
    const passwordHash = await hashPassword(process.env.CHECK_PW);
    store.update('owners', seedData.owner.id, { passwordHash });
    // A brand-new owner with nothing set up yet, for the setup checklist.
    store.insert('owners', { name: 'Robin Ortiz', email: 'robin@example.com', phone: '+17205550150', plan: 'essentials', timezone: 'America/Denver', createdAt: svc.clock.now().toISOString(), passwordHash });
    createApp(svc).listen(Number(process.env.PORT), '127.0.0.1', () => console.log('ready'));`;
  // CALENDLY_URL only builds the "Book your onboarding call" link; the check never opens it (outside requests are blocked).
  const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', code], { cwd: ROOT, env: { ...env, PORT: String(port), CHECK_PW: PASSWORD, CALENDLY_URL: 'https://calendly.com/keyhelm-check/onboarding' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stderr.on('data', (d) => { log += d; });
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('demo server did not start:\n' + log)), 60_000);
      child.stdout.on('data', (d) => { if (String(d).includes('ready')) { clearTimeout(t); resolve(); } });
      child.on('exit', (c) => reject(new Error(`demo server exited (${c}):\n${log}`)));
    });
    const base = `http://127.0.0.1:${port}`;
    const { ctx, page } = await newPage(browser, label, { width: 390, height: 844 });
    say('Phone (390px), a month of activity: rent');
    await page.goto(base + '/app/rent');
    await page.fill('#email', 'nate@example.com');
    await page.fill('#password', PASSWORD);
    await Promise.all([page.waitForURL(/\/app\/rent$/), page.click('button.cta')]);
    await drawn(page, 'rent');
    await page.screenshot({ path: join(OUT, 'month-rent.png'), fullPage: true });
    await step(label, 'late rent is marked late', async () => {
      await page.locator('article.charge.late', { hasText: 'Rent for November 2026' }).waitFor();
    });
    await step(label, 'part of the rent arrived, then the rest', async () => {
      const card = () => page.locator('article.charge', { hasText: 'Rent for November 2026' });
      await card().getByRole('button', { name: 'Mark received' }).click();
      const amount = card().getByLabel('Amount that arrived');
      if ((await amount.inputValue()) !== '2,750') throw new Error('amount not filled in with the balance: ' + (await amount.inputValue()));
      await amount.fill('1,000');
      await card().getByRole('button', { name: 'Save' }).click();
      await toast(page, '$1,750 is still owed');
      await card().locator('.big-num', { hasText: '$1,750' }).waitFor();
      await card().getByRole('button', { name: 'Mark received' }).click();
      await card().getByRole('button', { name: 'Save' }).click();
      await toast(page, 'Reminders for this one stop');
      await card().waitFor({ state: 'detached' });
    });
    await step(label, 'every tab opens without errors', async () => { for (const t of TABS) await open(page, label, t); });
    await ctx.close();

    const fresh = await newPage(browser, 'new owner', { width: 390, height: 844 });
    say('Phone (390px), a brand-new owner: the setup checklist');
    const p = fresh.page;
    await p.goto(base + '/login');
    await p.fill('#email', 'robin@example.com');
    await p.fill('#password', PASSWORD);
    await Promise.all([p.waitForURL(/\/app$/), p.click('button.cta')]);
    await drawn(p, 'today');
    await p.screenshot({ path: join(OUT, 'new-owner-today.png'), fullPage: true });
    await step('new owner', 'setup card: 0 of 6, the onboarding call button, empty states everywhere', async () => {
      await p.locator('.setup', { hasText: '0 of 6 done' }).waitFor();
      const book = p.getByRole('link', { name: /Book your onboarding call/ });
      if (!/^https:\/\/calendly\.com\/keyhelm-check\/onboarding\?/.test((await book.getAttribute('href')) ?? '')) throw new Error('Calendly link missing');
      for (const t of TABS) { await open(p, 'new owner', t); if (!(await p.locator(`#view-${t} .empty, #view-${t} form`).count())) throw new Error(`${t} has no empty state`); }
      await open(p, 'new owner', 'today');
    });
    await step('new owner', '"Add a home" from the checklist opens the form, and the step is then done', async () => {
      await p.locator('.setup').getByRole('button', { name: 'Add a home' }).click();
      const d = p.locator('dialog[open]');
      await d.waitFor();
      await d.getByLabel('Street address').fill('9 Pine Ln');
      await d.getByLabel('City').fill('Lakewood');
      await d.getByLabel('ZIP code').fill('80226');
      await d.getByLabel('Bedrooms').fill('3');
      await d.getByLabel('Bathrooms').fill('2');
      await d.getByLabel('Monthly rent').fill('2400');
      await d.getByRole('button', { name: 'Add home' }).click();
      await toast(p, 'Home added.');
      await open(p, 'new owner', 'today');
      await p.locator('.setup', { hasText: '1 of 6 done' }).waitFor();
    });
    await fresh.ctx.close();
  } finally {
    child.kill('SIGTERM');
  }
}

let browser;
try {
  await waitForServer();
  await makeActivity();
  browser = await pw.chromium.launch();
  await phonePass(browser);
  await desktopPass(browser);
  await monthPass(browser);
} catch (e) {
  problems.push('check stopped: ' + (e?.stack ?? e));
} finally {
  await browser?.close();
  stop();
}
say(`\nScreenshots: ${OUT}`);
if (problems.length) {
  say(`\n${problems.length} problem(s):\n` + problems.map((p) => '  - ' + p).join('\n'));
  process.exitCode = 1;
} else {
  say('\nOwner app check passed: no console errors, no outside requests.');
}
if (!process.env.CHECK_OUT) { /* keep screenshots in the temp folder for a look */ } else rmSync(join(work, 'data.json'), { force: true });
