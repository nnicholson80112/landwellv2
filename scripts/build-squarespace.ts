// Packages the KeyHelm website for Squarespace: one paste-in Code Block per page, written to
// apps/squarespace/. Each file holds its own styles, scoped under .kh-home or .kh-legal so
// nothing leaks into Squarespace's own pages, and hides Squarespace's header and footer on
// that page (the snippet brings KeyHelm's own nav and footer).
//
//   BUSINESS_EMAIL=help@yourdomain.com npm run build:squarespace
//
// Differences from the Railway-hosted site, because Squarespace is a different host:
//  - "Book a demo call" links straight to Calendly (there is no /demo redirect on Squarespace).
//  - The signup window posts as a normal form to the app's /api/public/signup, which redirects
//    to Stripe Checkout (no cross-site fetch, so the app needs no change).
//  - Fonts load from Google Fonts, and the cookie wording says Squarespace sets cookies.
// Source of truth stays apps/site/site.body.html and src/api/legal.ts: edit those, then rebuild.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { BUSINESS } from '../src/config/business.ts';
import { accessibilityStatement, cookiePolicy, privacyPolicy, refundPolicy, smsProgram, termsOfService } from '../src/api/legal.ts';

const APP_URL = (process.env.APP_URL || 'https://api-production-66895.up.railway.app').replace(/\/+$/, '');
const DEMO_URL = process.env.CALENDLY_URL || 'https://calendly.com/nnicholson80112';
const OUT = new URL('../apps/squarespace/', import.meta.url);
const FONTS = '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400..800&family=Figtree:wght@400..900&display=swap">';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Replace exactly one occurrence, or stop the build so wording drift is caught. */
function swap(s: string, from: string | RegExp, to: string, what: string): string {
  const n = typeof from === 'string' ? s.split(from).length - 1 : (s.match(new RegExp(from.source, from.flags.includes('g') ? from.flags : from.flags + 'g')) ?? []).length;
  if (n !== 1) throw new Error(`build-squarespace: expected one match for ${what}, found ${n}. Update scripts/build-squarespace.ts.`);
  return s.replace(from, to);
}

/** Prefix every selector with `root`. :root, html and body become the root itself; @font-face is dropped (Google Fonts instead). */
function scope(css: string, root: string): string {
  css = css.replace(/\/\*[\s\S]*?\*\//g, '');
  let out = '', i = 0;
  const block = (from: number) => { let d = 0; for (let j = from; j < css.length; j++) { if (css[j] === '{') d++; else if (css[j] === '}' && --d === 0) return j; } throw new Error('unbalanced CSS'); };
  while (i < css.length) {
    const open = css.indexOf('{', i);
    if (open < 0) break;
    const head = css.slice(i, open).trim(), end = block(open);
    let inner = css.slice(open + 1, end);
    if (head.startsWith('@font-face')) { /* dropped */ }
    else if (head.startsWith('@media') || head.startsWith('@supports')) out += `${head}{${scope(inner, root)}}`;
    else if (head.startsWith('@')) out += `${head}{${inner}}`;
    else out += head.split(',').map((sel) => {
      // body's overflow-x would stop the sticky nav; the frame clips sideways overflow on the real body instead.
      if (sel.trim() === 'body') inner = inner.replace(/overflow-x:hidden;?/, '');
      const s = sel.trim();
      if (s.startsWith(':root')) return root + s.slice(5);
      if (s === 'html' || s === 'body') return root;
      if (s === '*') return `${root},${root} *`;
      return `${root} ${s}`;
    }).join(',') + `{${inner}}`;
    i = end + 1;
  }
  return out;
}

/** Hides Squarespace's own header and footer on this page and lets the snippet run edge to edge. */
const SQUARESPACE_FRAME = `
body:has(.kh-page) #header,body:has(.kh-page) .header-announcement-bar-wrapper,body:has(.kh-page) #footer-sections{display:none!important}
.page-section:has(.kh-page){padding:0!important;min-height:0!important}
.page-section:has(.kh-page) .content-wrapper{padding:0!important;max-width:none!important}
html:has(.kh-page),body:has(.kh-page){overflow-x:clip}
html:has(.kh-home){scroll-behavior:smooth;scroll-padding-top:76px}
.kh-page{width:100vw;max-width:100vw;margin-left:calc(50% - 50vw);position:relative}
.kh-page :is(h1,h2,h3,h4,p,li){white-space:normal;text-transform:none}`;

const fill = (s: string) => s
  .replaceAll('{{BUSINESS_LEGAL_NAME}}', esc(BUSINESS.legalName))
  .replaceAll('{{BUSINESS_ADDRESS}}', esc(BUSINESS.address))
  .replaceAll('{{BUSINESS_EMAIL}}', esc(BUSINESS.email))
  .replaceAll('{{YEAR}}', String(new Date().getFullYear()));

/* ---------------- home page ---------------- */
function home(): string {
  const src = readFileSync(new URL('../apps/site/site.body.html', import.meta.url), 'utf8');
  const css = src.match(/<style>([\s\S]*?)<\/style>/)![1];
  let body = src.slice(src.indexOf('</style>') + '</style>'.length);
  const script = body.match(/<script>[\s\S]*?<\/script>/)![0];
  body = body.replace(script, '');

  body = fill(body).replaceAll('href="/demo"', `href="${esc(DEMO_URL)}" target="_blank" rel="noopener"`);
  body = swap(body, 'This website has no ads, no trackers and no cookies.', 'This website has no ads and no advertising trackers.', 'FAQ privacy sentence');
  // The signup window becomes a plain form post to the app, which answers with a redirect to Stripe Checkout.
  body = swap(body, '<form class="sheet" id="m-form" autocomplete="on" novalidate>', `<form class="sheet" id="m-form" autocomplete="on" novalidate method="post" action="${esc(APP_URL)}/api/public/signup"><input type="hidden" name="ref" id="m-ref">`, 'signup form tag');
  for (const [id, name] of [['m-name', 'name'], ['m-email', 'email'], ['m-phone', 'phone'], ['m-doors', 'doors'], ['m-plan', 'plan'], ['m-term', 'term'], ['m-agree', 'agree'], ['m-sms', 'smsConsent']]) {
    body = swap(body, ` id="${id}"`, ` id="${id}" name="${name}"`, `signup field ${id}`);
  }
  const modal = body.match(/<div class="modal"[\s\S]*?<\/form>\s*<\/div>/)![0];
  body = body.replace(modal, '');

  let js = swap(script, /fetch\('\/api\/public\/signup'[\s\S]*?btn\.textContent='Continue to checkout'\}\);/, "$('#m-ref').value=ref;$('#m-form').submit();", 'signup fetch');
  // Squarespace may wrap the page in transformed containers, so the dialog moves to <body> to cover the screen.
  js = swap(js, "querySelectorAll('a[href],button:not([disabled]),input,select')", "querySelectorAll('a[href],button:not([disabled]),input:not([type=hidden]),select')", 'focus trap selector');
  // Coming back from the app's error page with Back: the button must work again.
  js = swap(js, '})();\n</script>', "window.addEventListener('pageshow',function(){var b=$('#m-submit');b.disabled=false;b.textContent='Continue to checkout'});\n})();\n</script>", 'script end');
  js = swap(js, "var modal=$('#modal'),", "document.body.appendChild($('#kh-modal-root'));var modal=$('#modal'),", 'modal lookup');

  return `<!-- KeyHelm home page for Squarespace. Built by scripts/build-squarespace.ts from apps/site/site.body.html. Do not edit by hand. -->
${FONTS}
<style>${scope(css, '.kh-home')}
${SQUARESPACE_FRAME}</style>
<div class="kh-page kh-home">${body.trim()}</div>
<div class="kh-home" id="kh-modal-root">${modal}</div>
${js}
`;
}

/* ---------------- legal pages ---------------- */
const LOGO = '<svg width="28" height="28" viewBox="0 0 150 150" aria-hidden="true" style="vertical-align:-6px;margin-right:8px"><rect width="150" height="150" rx="34" fill="#C8502D"/><polygon points="75,34 118,70 118,118 32,118 32,70" fill="#FFF6EC" stroke="#FFF6EC" stroke-width="8" stroke-linejoin="round"/><circle cx="75" cy="86" r="11" fill="#1E2B2F"/><polygon points="69,92 81,92 85,112 65,112" fill="#1E2B2F"/></svg>';

/** Squarespace sets its own cookies and the fonts come from Google, so these sentences change on that host. */
function squarespaceCookieWording(path: string, html: string): string {
  if (path === 'privacy') {
    html = swap(html, 'Technical information our servers receive', 'Technical information our servers and our website host (Squarespace) receive', 'privacy technical information');
    html = swap(html, 'Railway (hosting), ', 'Railway (app hosting), Squarespace (website hosting), Google Fonts (website fonts), ', 'privacy service providers');
    return swap(html, '<p>Our website does not use advertising or analytics cookies and does not load third-party trackers. See our <a href="/cookies">Cookie policy</a>.</p>',
      '<p>Our website is hosted by Squarespace. It does not use advertising cookies or advertising trackers. Squarespace sets cookies needed to run and secure the site and, only if you accept them in the cookie banner, analytics cookies that count visits for us. See our <a href="/cookies">Cookie policy</a>.</p>', 'privacy cookie paragraph');
  }
  if (path === 'cookies') {
    html = swap(html, /<p>Our public website <b>does not set any cookies<\/b>\.[\s\S]*?<\/p>/,
      '<p>Our public website is hosted by Squarespace. Squarespace sets a few cookies that are strictly necessary to run and secure the site. If you accept them in the cookie banner, Squarespace also sets analytics cookies that tell us how many people visit and which pages they view. We do not use advertising pixels, social media widgets or other advertising trackers. The site loads its fonts from Google Fonts, so your browser contacts Google to download them. Squarespace describes its cookies in its own cookie policy.</p>', 'cookie policy website paragraph');
    html = swap(html, '<h2>Do we need a cookie banner?</h2>', '<h2>Cookie banner</h2>', 'cookie banner heading');
    html = swap(html, /<p>Because we only use storage that is strictly necessary and no tracking, we do not show a cookie consent banner\.[^<]*?(We treat Global Privacy Control)/,
      '<p>Our website shows a cookie banner. If you decline, only the strictly necessary cookies are set. If we ever add advertising tools, we will update this policy first and ask for consent where the law requires it. $1', 'cookie banner paragraph');
  }
  return html;
}

function legal(path: string, page: string): string {
  const css = page.match(/<style>([\s\S]*?)<\/style>/)![1];
  let body = page.slice(page.indexOf('<body>') + 6, page.lastIndexOf('</body>'));
  body = swap(body, /<header><a href="\/">/, `<header><a href="/">${LOGO}`, 'legal header logo');
  body = squarespaceCookieWording(path, body);
  return `<!-- KeyHelm /${path} page for Squarespace. Built by scripts/build-squarespace.ts from src/api/legal.ts. Do not edit by hand. -->
${FONTS}
<style>${scope(css, '.kh-legal')}
${SQUARESPACE_FRAME}</style>
<div class="kh-page kh-legal">${body.trim()}</div>
`;
}

mkdirSync(OUT, { recursive: true });
const pages: [string, string][] = [
  ['home', home()],
  ['privacy', legal('privacy', privacyPolicy())],
  ['terms', legal('terms', termsOfService())],
  ['sms', legal('sms', smsProgram())],
  ['cookies', legal('cookies', cookiePolicy())],
  ['refunds', legal('refunds', refundPolicy())],
  ['accessibility', legal('accessibility', accessibilityStatement())],
];
for (const [name, html] of pages) writeFileSync(new URL(`${name}.html`, OUT), html);
console.log(`Built ${pages.length} Squarespace code blocks in apps/squarespace/ (app ${APP_URL}, demo ${DEMO_URL}, email ${BUSINESS.email})`);
if (BUSINESS.email.endsWith('.example')) console.warn('Warning: BUSINESS_EMAIL is not set, so the pages show the placeholder help@keyhelm.example. Rebuild with BUSINESS_EMAIL=... before publishing.');
