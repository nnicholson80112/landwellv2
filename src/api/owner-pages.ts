// Server-rendered owner pages: sign in, set a password, forgot password, after checkout.
// Bright and simple, mobile first, the site's own fonts (no third-party requests), no scripts.

import { BRAND } from '../config/brand.ts';
import { BUSINESS } from '../config/business.ts';
import { POLICY_LINKS } from './legal.ts';
import { MIN_PASSWORD } from './auth.ts';

export const esc = (s: string) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const LOGO = '<svg viewBox="0 0 150 150" width="30" height="30" aria-hidden="true"><rect width="150" height="150" rx="34" fill="#C8502D"/><polygon points="75,34 118,70 118,118 32,118 32,70" fill="#FFF6EC" stroke="#FFF6EC" stroke-width="8" stroke-linejoin="round"/><circle cx="75" cy="86" r="11" fill="#1E2B2F"/><polygon points="69,92 81,92 85,112 65,112" fill="#1E2B2F"/></svg>';

const CSS = `
@font-face{font-family:'Montagu Slab';font-weight:500 700;font-display:swap;src:url(/fonts/montagu-slab-latin.woff2) format('woff2')}
@font-face{font-family:'Figtree';font-weight:300 900;font-display:swap;src:url(/fonts/figtree-latin.woff2) format('woff2')}
:root{--bg:#FFF6EC;--surface:#FFFDF9;--ink:#1E2B2F;--muted:#56636A;--line:#EADFD2;--brand:#C8502D;--brand-deep:#A9401F;--brand-ink:#FFFFFF;--sun:#E8A33D;--sun-soft:#FCEBCB;--mint:#0E9F6E;--mint-soft:#DDF6EC;--coral:#9A3412;--coral-soft:#FFE7DA}
@media (prefers-color-scheme:dark){:root{--bg:#12191B;--surface:#1A2427;--ink:#F3EEE7;--muted:#A5B0B3;--line:#2B393D;--brand:#E0714D;--brand-deep:#EE8A68;--brand-ink:#12191B;--sun-soft:#3A2E17;--mint:#3DD39B;--mint-soft:#123A2D;--coral:#FF9B6B;--coral-soft:#3D2416;color-scheme:dark}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;flex-direction:column;background:var(--bg);color:var(--ink);font:17px/1.55 'Figtree','Segoe UI',system-ui,sans-serif}
a{color:var(--brand);font-weight:600}
:focus-visible{outline:3px solid var(--sun);outline-offset:2px}
header{padding:18px 20px}
.logo{display:inline-flex;align-items:center;gap:9px;font:700 22px 'Montagu Slab',Georgia,'Times New Roman',serif;letter-spacing:-0.03em;color:var(--ink);text-decoration:none}
main{flex:1;width:100%;max-width:460px;margin:0 auto;padding:12px 16px 40px}
h1{font:700 clamp(28px,7vw,36px)/1.1 'Montagu Slab',Georgia,'Times New Roman',serif;letter-spacing:-0.025em;margin:8px 0 10px}
.lead{color:var(--muted);margin:0 0 18px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:18px;padding:22px;box-shadow:0 18px 40px -28px rgba(30,43,47,.35)}
label{display:block;font-weight:700;margin:14px 0 6px}
label:first-child{margin-top:0}
input{width:100%;min-height:50px;border:1.5px solid var(--line);border-radius:12px;padding:10px 14px;font:inherit;color:inherit;background:var(--surface)}
input:focus{border-color:var(--brand)}
.hint{color:var(--muted);font-size:14px;margin:6px 0 0}
.cta{display:flex;width:100%;align-items:center;justify-content:center;min-height:52px;margin-top:20px;border:0;border-radius:10px;background:var(--brand);color:var(--brand-ink);font:700 17px 'Figtree','Segoe UI',system-ui,sans-serif;cursor:pointer;text-decoration:none;box-shadow:0 8px 22px -10px var(--brand)}
.cta:hover{background:var(--brand-deep)}
.cta.ghost{background:var(--surface);color:var(--ink);border:1.5px solid var(--line);box-shadow:none}
.links{display:flex;flex-wrap:wrap;justify-content:space-between;gap:10px;margin-top:16px;font-size:15px}
.msg{border-radius:12px;padding:12px 14px;margin:0 0 16px;font-weight:600}
.msg.error{background:var(--coral-soft);color:var(--coral)}
.msg.ok{background:var(--mint-soft);color:var(--ink)}
.msg.note{background:var(--sun-soft);color:var(--ink)}
.who{display:flex;align-items:center;gap:10px;background:var(--bg);border-radius:12px;padding:10px 14px;margin:0 0 6px;font-weight:600;word-break:break-all}
footer{padding:20px 16px 28px;text-align:center;font-size:14px;color:var(--muted)}
footer nav{display:flex;flex-wrap:wrap;justify-content:center;gap:6px 16px;margin-bottom:6px}footer a{color:var(--muted);font-weight:400}
`;

/** One branded page. `head` is extra markup for <head> (for example a refresh). */
export function ownerPage(title: string, inner: string, o: { head?: string } = {}): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} | ${esc(BRAND.name)}</title><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="/app/apple-touch-icon.png"><meta name="robots" content="noindex">${o.head ?? ''}
<style>${CSS}</style></head><body>
<header><a class="logo" href="/">${LOGO}${esc(BRAND.name)}</a></header>
<main>${inner}</main>
<footer><nav aria-label="Policies">${POLICY_LINKS.map(([h, t]) => `<a href="${h}">${t}</a>`).join('')}</nav><p>${esc(BUSINESS.legalName)} · <a href="mailto:${esc(BUSINESS.email)}">${esc(BUSINESS.email)}</a></p></footer>
</body></html>`;
}

const msg = (kind: 'error' | 'ok' | 'note', text?: string) => (text ? `<p class="msg ${kind}" role="${kind === 'error' ? 'alert' : 'status'}">${esc(text)}</p>` : '');

export function loginPage(o: { email?: string; next?: string; error?: string; notice?: string } = {}): string {
  return ownerPage('Sign in', `
<h1>Welcome back</h1>
<p class="lead">Sign in to see what needs you, answer decisions and check on your homes.</p>
<form class="card" method="post" action="/login" novalidate>
${msg('error', o.error)}${msg('ok', o.notice)}
<label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" inputmode="email" required value="${esc(o.email ?? '')}"${o.email ? '' : ' autofocus'}>
<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required${o.email ? ' autofocus' : ''}>
<input type="hidden" name="next" value="${esc(o.next ?? '/app')}">
<button class="cta">Sign in</button>
<div class="links"><a href="/forgot">Forgot your password?</a><a href="https://www.keyhelm.app/plans">New here? See plans</a></div>
</form>`);
}

export function setPasswordPage(o: { email: string; purpose: 'setup' | 'reset' | 'invite'; action: string; error?: string; ownerName?: string }): string {
  const setup = o.purpose !== 'reset';
  const lead = o.purpose === 'invite'
    ? `${esc(o.ownerName ?? 'The owner')} added you to their ${esc(BRAND.name)} account. Pick a password to sign in on your phone or computer.`
    : setup ? `You're in. Pick a password so you can sign in to ${esc(BRAND.name)} anytime, on your phone or computer.` : 'Pick a new password. You will be signed out on your other devices.';
  return ownerPage(setup ? 'Create your password' : 'Choose a new password', `
<h1>${setup ? 'Create your password' : 'Choose a new password'}</h1>
<p class="lead">${lead}</p>
<form class="card" method="post" action="${esc(o.action)}" novalidate>
${msg('error', o.error)}
<p class="who">${esc(o.email)}</p>
<input type="email" name="username" autocomplete="username" value="${esc(o.email)}" hidden>
<label for="password">New password</label><input id="password" name="password" type="password" autocomplete="new-password" minlength="${MIN_PASSWORD}" required autofocus aria-describedby="pw-hint">
<p class="hint" id="pw-hint">At least ${MIN_PASSWORD} characters. A short sentence is easy to remember.</p>
<label for="confirm">Type it again</label><input id="confirm" name="confirm" type="password" autocomplete="new-password" minlength="${MIN_PASSWORD}" required>
<button class="cta">${setup ? 'Save and open my account' : 'Save and sign in'}</button>
</form>`);
}

/** Two-step sign-in: the 6-digit code from the authenticator app. */
export function codePage(o: { ticket: string; error?: string }): string {
  return ownerPage('Enter your code', `
<h1>Enter your code</h1>
<p class="lead">Open your authenticator app and type the 6-digit code for ${esc(BRAND.name)}.</p>
<form class="card" method="post" action="/login/code" novalidate>
${msg('error', o.error)}
<label for="code">6-digit code</label><input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]*" maxlength="7" required autofocus>
<input type="hidden" name="ticket" value="${esc(o.ticket)}">
<button class="cta">Verify and sign in</button>
<p class="hint">Lost your phone? Email <a href="mailto:${esc(BUSINESS.email)}">${esc(BUSINESS.email)}</a> and we'll help you back in.</p>
</form>`);
}

export function linkInvalidPage(): string {
  return ownerPage('Link expired', `
<h1>This link has expired</h1>
<p class="lead">Sign-in links work once and only for a short time. Ask for a fresh one and we'll get you in.</p>
<div class="card"><a class="cta" href="/forgot">Get a new link</a><a class="cta ghost" href="/login">Sign in with my password</a></div>`);
}

export function forgotPage(o: { email?: string; error?: string } = {}): string {
  return ownerPage('Reset your password', `
<h1>Reset your password</h1>
<p class="lead">Enter the email on your account and we'll send you a link to choose a new password.</p>
<form class="card" method="post" action="/forgot" novalidate>
${msg('error', o.error)}
<label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" inputmode="email" required autofocus value="${esc(o.email ?? '')}">
<button class="cta">Send me a link</button>
<div class="links"><a href="/login">Back to sign in</a></div>
</form>`);
}

/** Same words whether or not the email has an account. */
export function forgotSentPage(emailWorks: boolean): string {
  return ownerPage('Check your email', emailWorks ? `
<h1>Check your email</h1>
<p class="lead">If that email has a ${esc(BRAND.name)} account, a link to choose a new password is on its way. It works for 1 hour. Check your spam folder if you don't see it in a few minutes.</p>
<div class="card"><a class="cta ghost" href="/login">Back to sign in</a></div>` : `
<h1>We'll help you get back in</h1>
<p class="lead">Email us at <a href="mailto:${esc(BUSINESS.email)}">${esc(BUSINESS.email)}</a> from the address on your account and we'll send you a sign-in link.</p>
<div class="card"><a class="cta" href="mailto:${esc(BUSINESS.email)}?subject=${encodeURIComponent('Sign-in link please')}">Email ${esc(BRAND.name)} support</a><a class="cta ghost" href="/login">Back to sign in</a></div>`);
}

/** After checkout, while Stripe finishes confirming the payment. Refreshes itself (to `refresh`) until it gives up. */
export function checkoutWaitingPage(refresh?: string): string {
  if (!refresh) {
    return ownerPage('Almost there', `
<h1>This is taking longer than usual</h1>
<p class="lead">Your payment may still be processing. Your receipt and a sign-in link will reach you by email, or email us at <a href="mailto:${esc(BUSINESS.email)}">${esc(BUSINESS.email)}</a> and we'll get you set up.</p>
<div class="card"><a class="cta ghost" href="/login">Go to sign in</a></div>`);
  }
  return ownerPage('Finishing up', `
<h1>Finishing up your payment</h1>
<p class="lead">This usually takes a few seconds. This page refreshes on its own.</p>
<div class="card"><p class="msg note" role="status">Waiting for the payment confirmation from Stripe.</p><a class="cta ghost" href="${esc(refresh)}">Refresh now</a></div>`, { head: `<meta http-equiv="refresh" content="3;url=${esc(refresh)}">` });
}

/** After checkout, for an account whose sign-in link goes to the email on file instead. */
export function checkoutEmailPage(emailWorks: boolean, email: string): string {
  return ownerPage("You're subscribed", `
<h1>You're all set</h1>
<p class="lead">Thanks for subscribing to ${esc(BRAND.name)}. Your receipt is on its way by email.</p>
<div class="card">${emailWorks
    ? `<p class="msg ok" role="status">We emailed a sign-in link to ${esc(email)}. Open it on this device to set your password.</p><a class="cta ghost" href="/login">Sign in with my password</a>`
    : `<p>To get your sign-in link, email <a href="mailto:${esc(BUSINESS.email)}">${esc(BUSINESS.email)}</a> from ${esc(email)}.</p><a class="cta ghost" href="/login">Sign in with my password</a>`}</div>`);
}

/** Placeholder for the signed-in app until apps/owner/index.html exists. */
export function appPlaceholderPage(name: string, email: string, calendlyUrl?: string | null): string {
  return ownerPage('Your account', `
<h1>Hi ${esc(name.split(/\s+/)[0] || 'there')}</h1>
<p class="lead">You're signed in as ${esc(email)}. Decisions and updates also reach you by text and email.</p>
<div class="card">${calendlyUrl ? `<p class="msg note">Next step: a short call to set up your homes, lease, tenants and vendors together.</p><a class="cta" href="${esc(calendlyUrl)}">Book your onboarding call</a>` : ''}
<form method="post" action="/logout"><button class="cta ghost">Sign out</button></form></div>`);
}

export function blockedPage(text: string): string {
  return ownerPage('Please try again', `<h1>Please try again</h1><p class="lead">${esc(text)}</p><div class="card"><a class="cta" href="/login">Back to sign in</a></div>`);
}
