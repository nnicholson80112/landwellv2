// The owner app at /app (apps/owner): who gets it, its Content-Security-Policy, that it is self-contained
// (no outside URLs, no HTML string sinks), that every change it sends carries the CSRF header, that every
// screen and the API calls behind them exist, and the install manifest and icon.
// Every outside service is mocked: global fetch only answers for this test server.
// The browser walk-through (every tab at 390px and 1280px) is scripts/check-owner-app.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script, runInNewContext } from 'node:vm';
import type { AddressInfo } from 'node:net';
import { MemoryStore } from '../src/store/store.ts';
import { FakeClock } from '../src/engine/clock.ts';
import { createServices } from '../src/services.ts';
import { install } from '../src/workflows/index.ts';
import { seed } from '../src/sim/seed.ts';
import { createApp, LIMIT } from '../src/api/server.ts';
import { RateLimiter, limitsFromEnv } from '../src/api/guard.ts';
import { hashPassword, resetLoginLimits } from '../src/api/auth.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP_FILE = join(ROOT, 'apps/owner/index.html');
const PW = 'blue spruce porch light';
const TABS = ['today', 'rent', 'repairs', 'messages', 'homes', 'settings'] as const;

/** Only this test server answers. Anything else is a test bug (and never leaves the machine). */
function guardFetch() {
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: any, init?: any) => {
    const u = String(url instanceof Request ? url.url : url);
    if (u.startsWith('http://127.0.0.1:')) return real(url, init);
    throw new Error(`blocked outside call in a test: ${u}`);
  }) as typeof fetch;
  return () => { globalThis.fetch = real; };
}

function boot(start = '2026-10-12T16:00:00Z' /* Mon 10:00 AM Denver */) {
  resetLoginLimits();
  const L = limitsFromEnv();
  Object.assign(LIMIT, { ip: new RateLimiter(L.ip), owner: new RateLimiter(L.owner), authFail: new RateLimiter(L.authFail) });
  const restore = guardFetch();
  const clock = new FakeClock(start);
  const store = new MemoryStore();
  const svc = createServices({ store, clock, env: {} });
  install(svc);
  const s = seed(store, {});
  const server = createApp(svc).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = (path: string, cookie?: string) => fetch(base + path, { redirect: 'manual', headers: cookie ? { cookie } : {} });
  /** Exactly what the app's api() helper sends for a change. */
  const change = (cookie: string, method: string, path: string, body?: unknown, csrf = true) =>
    fetch(base + path, { method, redirect: 'manual', headers: { cookie, accept: 'application/json', 'content-type': 'application/json', ...(csrf ? { 'X-KeyHelm': '1' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const signIn = async (next?: string) => {
    store.update('owners', s.owner.id, { passwordHash: await hashPassword(PW) });
    const r = await fetch(base + '/login', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email: s.owner.email, password: PW, ...(next ? { next } : {}) }) });
    assert.equal(r.status, 303, 'signed in');
    const cookie = r.headers.getSetCookie().map((c) => c.split(';')[0]).find((c) => c.startsWith('kh_session='))!;
    return { cookie, location: r.headers.get('location') };
  };
  return { clock, store, svc, s, base, get, change, signIn, close: () => { server.close(); restore(); } };
}

const html = () => readFileSync(APP_FILE, 'utf8');
const script = (page: string) => /<script>([\s\S]*?)<\/script>/.exec(page)![1];
const cspOf = (r: Response) => r.headers.get('content-security-policy') ?? '';

/* ---------------- who gets the app, and its CSP ---------------- */

test('/app: signed-out owners go to sign in and come back to the same screen; signed in gets the app with a fresh-nonce CSP', async () => {
  const t = boot();
  try {
    // Signed out: sign in first, then back to the screen they asked for.
    for (const [path, next] of [['/app', '%2Fapp'], ['/app/rent', '%2Fapp%2Frent'], ['/app/messages/%2B17205550111', '%2Fapp%2Fmessages%2F%252B17205550111']]) {
      const r = await t.get(path);
      assert.equal(r.status, 302, path);
      assert.equal(r.headers.get('location'), `/login?next=${next}`, path);
    }
    const dead = await t.get('/app', 'kh_session=not-a-real-session');
    assert.equal(dead.status, 302, 'a dead session is signed out');
    assert.match(dead.headers.getSetCookie().join(';'), /kh_session=;.*Max-Age=0/, 'and its cookie is cleared');

    const { cookie, location } = await t.signIn('/app/rent');
    assert.equal(location, '/app/rent', 'signing in lands on the screen they wanted');

    const r = await t.get('/app', cookie);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') ?? '', /text\/html/);
    assert.equal(r.headers.get('cache-control'), 'no-store', 'a signed-in page is never cached');
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    const csp = cspOf(r);
    const nonce = /script-src 'nonce-([A-Za-z0-9+/=]{20,})'/.exec(csp)?.[1];
    assert.ok(nonce, `script-src uses a nonce: ${csp}`);
    for (const part of ["default-src 'none'", `style-src 'nonce-${nonce}'`, "connect-src 'self'", "font-src 'self'", "frame-src 'self'", "manifest-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "object-src 'none'", "form-action 'self'", "require-trusted-types-for 'script'"]) {
      assert.ok(csp.includes(part), `CSP has ${part}`);
    }
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|https?:|\*/, 'no inline or outside allowances');
    const body = await r.text();
    const tags = body.match(/<(script|style)\b[^>]*>/g) ?? [];
    assert.ok(tags.length >= 2, 'the page has its inline style and script');
    for (const tag of tags) assert.ok(tag.includes(`nonce="${nonce}"`), `${tag} carries the response nonce`);

    const again = await t.get('/app', cookie);
    assert.notEqual(/nonce-([^']+)/.exec(cspOf(again))?.[1], nonce, 'every response gets a new nonce');

    // Deep links open the same app on that screen; anything else under /app is a 404.
    for (const path of ['/app/today', '/app/rent', '/app/repairs', '/app/messages', '/app/homes', '/app/settings', '/app/messages/%2B17205550111', '/app/messages/lisa%40example.com']) {
      const d = await t.get(path, cookie);
      assert.equal(d.status, 200, path);
      assert.match(await d.text(), /id="view-today"/, path);
    }
    for (const path of ['/app/nope', '/app/rent/x', '/app/index.html']) assert.equal((await t.get(path, cookie)).status, 404, path);
  } finally {
    t.close();
  }
});

/* ---------------- self-contained and safe ---------------- */

test('the app page is self-contained: no outside URLs, no CDN, no HTML string sinks, no em dashes, and its script parses', async () => {
  const page = html();
  const urls = [...new Set(page.match(/https?:\/\/[^\s'"`)<>]+/g) ?? [])];
  assert.deepEqual(urls, ['http://www.w3.org/2000/svg'], 'the only URL is the SVG namespace (not a request)');
  assert.doesNotMatch(page, /<script[^>]+src=|<link[^>]+rel="stylesheet"|@import|\/\/cdn|googleapis|unpkg|jsdelivr/i, 'no outside scripts, styles or fonts');
  assert.doesNotMatch(page, /\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|setAttribute\(\s*['"]on/, 'no HTML string sinks: server data only ever goes in as text');
  assert.doesNotMatch(page, /\son[a-z]+="/, 'no inline event handler attributes');
  assert.doesNotMatch(page, /[\u2014\u2013]/, 'no em or en dashes');
  assert.doesNotMatch(page, /gradient|border-radius:\s*(999|[3-9]\d)px/i, 'no gradients, no pill shapes');
  assert.match(page, /@font-face\{font-family:'Montagu Slab'[^}]*url\(\/fonts\/montagu-slab-latin\.woff2\)/);
  assert.match(page, /--display:'Montagu Slab',Georgia/, 'Georgia while the font file loads');
  assert.match(page, /@font-face\{font-family:'Figtree'[^}]*url\(\/fonts\/figtree-latin\.woff2\)/);
  for (const color of ['#FFF6EC', '#1E2B2F', '#C8502D', '#E8A33D', '#0E9F6E']) assert.ok(page.includes(color), `brand color ${color}`);
  assert.doesNotThrow(() => new Script(script(page), { filename: 'apps/owner/index.html' }), 'the inline script is valid JavaScript');

  const t = boot();
  try {
    for (const font of ['/fonts/montagu-slab-latin.woff2', '/fonts/figtree-latin.woff2', '/fonts/OFL-MontaguSlab.txt', '/favicon.svg']) {
      const r = await t.get(font);
      assert.equal(r.status, 200, `${font} is served by this site`);
    }
  } finally {
    t.close();
  }
});

/* ---------------- CSRF ---------------- */

test('every change the app sends carries X-KeyHelm: 1 with same-origin credentials, and the server refuses one without it', async () => {
  const js = script(html());
  assert.equal((js.match(/\bfetch\(/g) ?? []).length, 1, 'all requests go through one helper');
  const helper = /async function api\(method, path, body\) \{[\s\S]*?\n\}/.exec(js)?.[0] ?? '';
  assert.match(helper, /credentials: 'same-origin'/);
  assert.match(helper, /if \(method !== 'GET'\) \{\s*headers\['X-KeyHelm'\] = '1';/, 'the header goes on every non-GET request');
  assert.match(helper, /r\.status === 401\) \{ signInAgain\(\)/, 'a dead session goes back to sign in');

  const t = boot();
  try {
    const { cookie } = await t.signIn();
    const task = t.store.insert('tasks', { ownerId: t.s.owner.id, title: 'Change the furnace filter', detail: '', status: 'open' });
    const refused = await t.change(cookie, 'POST', `/api/tasks/${task.id}/done`, {}, false);
    assert.equal(refused.status, 403, 'no header: refused');
    assert.equal(t.store.get('tasks', task.id)!.status, 'open');
    const ok = await t.change(cookie, 'POST', `/api/tasks/${task.id}/done`, {});
    assert.equal(ok.status, 200, 'with the header, as the app sends it');
    assert.equal(t.store.get('tasks', task.id)!.status, 'done');
    // Signing out the way the app does: JSON answer, then the app goes to /login.
    const out = await t.change(cookie, 'POST', '/logout', {});
    assert.deepEqual(await out.json(), { ok: true });
    assert.equal((await t.get('/app', cookie)).status, 302, 'signed out');
  } finally {
    t.close();
  }
});

/* ---------------- every screen ---------------- */

test('every screen exists: six tabs, a view for each, the words owners need, and the API calls behind them answer', async () => {
  const page = html();
  for (const tab of TABS) {
    const href = tab === 'today' ? '/app' : `/app/${tab}`;
    assert.match(page, new RegExp(`<a href="${href}" data-nav data-tab="${tab}">`), `nav link for ${tab}`);
    assert.match(page, new RegExp(`<section id="view-${tab}" class="view" data-view="${tab}"`), `view for ${tab}`);
    assert.match(page, new RegExp(`async function view${tab[0].toUpperCase()}${tab.slice(1)}\\(`), `screen code for ${tab}`);
  }
  for (const words of [
    'Decisions waiting', 'Your to-dos', 'Get set up', 'Book your onboarding call', 'What KeyHelm handled this week',
    'Tenants pay you directly', 'Mark received', 'Request a repair', 'Replies go out from your KeyHelm number',
    'Add a home', 'Add a tenant', 'Add a vendor', 'Upload or paste', 'Save rules', 'Save profile', 'Manage billing', 'Sign out',
    "You're offline", 'never scores or recommends applicants',
  ]) assert.ok(page.includes(words), `says "${words}"`);
  // Accessibility basics: language, skip link, landmarks, live regions for toasts, labeled navigation.
  assert.match(page, /<html lang="en">/);
  assert.match(page, /<a class="skip" href="#main">/);
  assert.match(page, /<nav class="nav" aria-label="Main">/);
  assert.match(page, /<main id="main" tabindex="-1">/);
  assert.match(page, /id="toasts" role="status" aria-live="polite"/);
  assert.match(page, /id="alerts" role="alert" aria-live="assertive"/);
  assert.match(page, /\.btn\{[^}]*min-height:48px/, 'buttons are at least 48px tall');

  // Every change the app makes goes to a route that exists (POST/PUT/PATCH/DELETE).
  for (const path of ['/api/approvals/', '/api/tasks/', '/api/charges/', '/api/work-orders', '/api/messages/send', '/api/properties', '/api/tenants', '/api/vendors', '/api/lease-templates', '/api/rules', '/api/me', '/api/me/password', '/api/billing/portal', '/logout']) {
    assert.ok(page.includes(`'${path}`) || page.includes(`\`${path}`), `the app calls ${path}`);
  }

  // Every list the screens read answers for a signed-in owner.
  const t = boot();
  try {
    const { cookie } = await t.signIn();
    const reads = ['/api/me', '/api/approvals?status=pending', '/api/approvals?status=decided', '/api/tasks?status=open', '/api/activity?limit=200', '/api/charges?status=open', '/api/charges?status=paid', '/api/rules',
      '/api/work-orders?status=open', '/api/work-orders?status=closed', '/api/properties', '/api/tenants?status=active', '/api/tenants', '/api/vendors', '/api/lease-templates', '/api/messages/threads'];
    for (const path of reads) {
      if (path !== '/api/approvals?status=decided') assert.ok(page.includes(`'${path}'`), `the app reads ${path}`);
      const r = await t.get(path, cookie);
      assert.equal(r.status, 200, path);
    }
    // The setup checklist and the Calendly button come from /api/me.
    const me = await (await t.get('/api/me', cookie)).json();
    assert.equal(me.onboarding.steps.length, 6);
    assert.ok(['support'].every((k) => k in me));
    // A thread with no messages yet (a tenant on file) opens, so the owner can write first.
    const thread = await t.get(`/api/messages/threads/${encodeURIComponent(t.s.tenant.phone!)}`, cookie);
    assert.equal(thread.status, 200);
  } finally {
    t.close();
  }
});

/* ---------------- install ---------------- */

test('install manifest and icon: public, cached, and the manifest points at the app', async () => {
  const page = html();
  assert.match(page, /<link rel="manifest" href="\/app\/manifest\.webmanifest">/);
  const t = boot();
  try {
    const r = await t.get('/app/manifest.webmanifest'); // browsers fetch it without cookies
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'application/manifest+json');
    assert.match(r.headers.get('cache-control') ?? '', /public, max-age=\d+/);
    const etag = r.headers.get('etag')!;
    const m = await r.json();
    assert.equal(m.name, 'KeyHelm');
    assert.equal(m.display, 'standalone');
    assert.ok(m.start_url.startsWith(m.scope), 'the start page is inside the app');
    assert.ok(m.scope.startsWith('/app'), 'the scope is the app');
    assert.equal(m.background_color, '#FFF6EC');
    assert.ok(m.icons.length >= 1);
    for (const icon of m.icons) {
      const i = await t.get(icon.src);
      assert.equal(i.status, 200, icon.src);
      assert.equal(i.headers.get('content-type'), 'image/svg+xml');
      assert.match(await i.text(), /<svg[^>]*viewBox="0 0 512 512"[\s\S]*#C8502D/);
    }
    assert.equal((await fetch(t.base + '/app/manifest.webmanifest', { headers: { 'if-none-match': etag } })).status, 304, 'browsers can revalidate cheaply');
    // The start page and every shortcut open the app (signed out: sign in first).
    for (const u of [m.start_url, ...(m.shortcuts ?? []).map((x: { url: string }) => x.url)]) assert.equal((await t.get(u)).status, 302, u);
  } finally {
    t.close();
  }
});

/* ---------------- deposit decisions: the refund total ---------------- */

test('deposit decisions carry the deposit held (dollars), so the app can show the refund as deductions are typed', async () => {
  const t = boot();
  try {
    const { cookie } = await t.signIn();
    t.svc.engine.emit('moveout.notice', { ownerId: t.s.owner.id, tenantId: t.s.tenant.id, leaseId: t.s.lease.id, date: '2026-10-14', fromOwner: true });
    await t.svc.engine.drain();
    t.clock.set('2026-10-15T16:00:00Z');
    t.svc.engine.tick();
    await t.svc.engine.drain();
    const list = await (await t.get('/api/approvals?status=pending', cookie)).json();
    const dep = list.find((a: any) => a.kind === 'deposit');
    assert.ok(dep, 'a deposit decision is waiting');
    const f = dep.fields.find((x: any) => x.type === 'deductions');
    assert.equal(f.held, 2750, 'the $2,750 deposit, in dollars like every other field');
    assert.equal(f.forOption, 'deductions_entered');
  } finally {
    t.close();
  }
});

/* ---------------- the app's own words and numbers ---------------- */

test('the app writes money as $1,234, dates as "Sun, Nov 1", and drops the text-reply instructions from decisions', () => {
  const js = script(html());
  const take = (name: string) => {
    const m = new RegExp(`\\n(function ${name}\\([\\s\\S]*?\\n\\})\\n`).exec(js) ?? new RegExp(`\\n(const ${name} = [^\\n]*)\\n`).exec(js);
    assert.ok(m, `found ${name}`);
    return m[1];
  };
  const src = ['isYmd', 'ymdIn', 'addDays', 'day', 'money', 'cleanBody', 'phoneText'].map(take).join('\n');
  const ctx: Record<string, unknown> = {};
  runInNewContext(`${src}\nconst tz = () => 'America/Denver';\nconst today = () => '2026-10-20';\nObject.assign(out, { day, money, cleanBody, phoneText });`, { out: ctx, Intl, Date, String, Number, Math, isFinite });
  const { day, money, cleanBody, phoneText } = ctx as { day: (s: string) => string; money: (c: number) => string; cleanBody: (s: string) => string; phoneText: (s: string) => string };

  assert.equal(money(275_000), '$2,750');
  assert.equal(money(1_234_567), '$12,345.67');
  assert.equal(money(5_000), '$50');
  assert.equal(money(-1_050), '-$10.50');
  assert.equal(day('2026-11-01'), 'Sun, Nov 1');
  assert.equal(day('2027-02-14'), 'Sun, Feb 14, 2027', 'the year shows when it is not this year');
  assert.equal(day('2026-11-02T06:30:00Z'), 'Sun, Nov 1', "timestamps use the owner's time zone (11:30 PM Denver)");
  assert.equal(phoneText('+17205550111'), '(720) 555-0111');

  assert.equal(
    cleanBody('Lisa Chen pays $2,750/month. Offer a 12-month renewal at the same rent? To change the rent or term, add it after your YES (like "YES code $2,850 12 months").'),
    'Lisa Chen pays $2,750/month. Offer a 12-month renewal at the same rent?');
  assert.equal(
    cleanBody('Rent was due Sun, Nov 1. If only part arrived, add the amount after YES (like "YES code $1,500"). If it hasn\'t arrived, I\'ll send Lisa a polite note.'),
    'Rent was due Sun, Nov 1. If it hasn\'t arrived, I\'ll send Lisa a polite note.');
  assert.equal(
    cleanBody('Return the full deposit, or take deductions. To take deductions, reply NO with the code and list each one, like "NO code carpet cleaning $150, broken blinds $40". Only damage beyond normal wear and tear can be deducted.'),
    'Return the full deposit, or take deductions. Only damage beyond normal wear and tear can be deducted.');
  assert.equal(cleanBody('Applicant #1 for this home.\n• Monthly income at least 3x rent: $6,800/month (meets)'), 'Applicant #1 for this home.\n• Monthly income at least 3x rent: $6,800/month (meets)', 'everything else stays as written');
});
