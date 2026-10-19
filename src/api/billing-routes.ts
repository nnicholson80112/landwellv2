// Billing, private offers, signup, admin console and onboarding (Calendly).
//
//   Public:   POST /api/public/signup        new owner → Stripe Checkout (first month today)
//             GET  /offer/:id                 personal offer page (the link is the only way in)
//             GET  /billing/done              after checkout → set a password → /app (book onboarding there)
//   Webhooks: POST /webhooks/stripe           KeyHelm's own subscription only (never rent)
//             POST /webhooks/calendly         onboarding booked / canceled
//   Owner:    GET  /api/billing  · POST /api/billing/checkout · GET /api/offers
//   Admin:    GET  /admin  · GET /api/admin/overview · POST /api/admin/offers · POST /api/admin/offers/:id/revoke
//             (Authorization: Bearer <ADMIN_API_TOKEN>)

import { TERMS_VERSION } from './legal.ts';
import { clientIp } from './guard.ts';
import type { ServerResponse } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import type { Req, Handler } from './server.ts';
import type { Services } from '../services.ts';
import type { BillingTerm, Offer, Owner, TableName } from '../domain/types.ts';
import { verifyStripeSignature } from '../adapters/live.ts';
import { StripeBilling, applyBillingEvent, PLANS, TERMS, type Plan } from '../billing/stripe.ts';
import { BASE_PRICE, LIST_PRICE, OFFER_RULES, PRESETS, PRICE_FLOOR, MAX_MONTHS_MONTHLY, offerPrice, REFERRAL_CREDIT_CENTS, expireOffers, issueOffer, pickOffer, quote, referralCodeFor, termLabel, usableOffers, type IssueInput } from '../billing/offers.ts';
import { BRAND } from '../config/brand.ts';
import { checkoutDone } from './owner-routes.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

interface Kit {
  route: (method: string, path: string, h: Handler, auth?: boolean) => void;
  json: (res: ServerResponse, code: number, data: unknown) => void;
  html: (res: ServerResponse, code: number, body: string) => void;
  page: (title: string, inner: string) => string;
  esc: (s: string) => string;
  mine: <K extends TableName>(svc: Services, table: K, ownerId: string) => any[];
}

const usd = (c: number) => '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 });
const asPlan = (v: unknown, d: Plan): Plan => (PLANS.includes(v as Plan) ? (v as Plan) : d);
const asTerm = (v: unknown, d: BillingTerm): BillingTerm => (TERMS.includes(v as BillingTerm) ? (v as BillingTerm) : d);
const asDoors = (v: unknown, d = 1) => Math.max(1, Math.min(500, Math.round(Number(v)) || d));
const cleanEmail = (e: unknown) => String(e ?? '').trim().toLowerCase();
const validEmail = (e: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
const normPhone = (p: unknown) => { const d = String(p ?? '').replace(/[^\d+]/g, ''); return d.startsWith('+') ? d : d.length === 10 ? '+1' + d : d.length === 11 && d.startsWith('1') ? '+' + d : d; };

function billingClient(svc: Services): StripeBilling | undefined {
  return process.env.STRIPE_SECRET_KEY ? new StripeBilling({ secretKey: process.env.STRIPE_SECRET_KEY, publicUrl: svc.cfg.publicUrl }) : undefined;
}

function isAdmin(req: Req): boolean {
  const want = process.env.ADMIN_API_TOKEN;
  const got = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  if (!want || !got || want.length !== got.length) return false;
  return timingSafeEqual(Buffer.from(want), Buffer.from(got));
}

/** Public view of an offer (never internal notes). */
const offerView = (svc: Services, o: Offer) => ({
  id: o.id, kind: o.kind, kindLabel: OFFER_RULES[o.kind].label, title: o.title, mode: o.mode ?? 'percent', percentOff: o.percentOff, months: o.months,
  pricePerDoor: Object.fromEntries(PLANS.map((p) => [p, Object.fromEntries(o.terms.map((t) => [t, offerPrice({ mode: o.mode ?? 'percent', percentOff: o.percentOff }, p, t)]))])),
  terms: o.terms, plans: o.plans ?? null, expiresAt: o.expiresAt, status: o.status, link: `${svc.cfg.publicUrl.replace(/\/$/, '')}/offer/${o.id}`,
});

export function registerBillingRoutes({ route, json, html, page, esc, mine }: Kit) {
  /* ---------------- Checkout (shared by owner + public signup) ---------------- */
  async function startCheckout(svc: Services, owner: Owner, o: { plan: Plan; term: BillingTerm; doors: number; offerId?: string }) {
    const client = billingClient(svc);
    if (!client) return { status: 503, body: { error: 'Billing is not set up yet: add STRIPE_SECRET_KEY in Railway.' } };
    if (owner.billing?.status === 'active') return { status: 409, body: { error: 'This account already has an active subscription.' } };
    const now = svc.clock.now();
    expireOffers(svc.store, now);
    const picked = pickOffer(svc.store, { owner }, o.plan, o.term, now, o.offerId);
    if (picked.error) return { status: 400, body: { error: picked.error } };
    try {
      const s = await client.createCheckout({ owner, plan: o.plan, term: o.term, doors: o.doors, offer: picked.offer });
      svc.store.update('owners', owner.id, { billing: { ...(owner.billing ?? {}), status: 'checkout_started', plan: o.plan, term: o.term, doors: o.doors, checkoutSessionId: s.id, updatedAt: now.toISOString() } });
      return { status: 200, body: { url: s.url, plan: o.plan, term: o.term, doors: o.doors, offer: picked.offer ? offerView(svc, picked.offer) : null, quote: quote(o.plan, o.term, o.doors, picked.offer) } };
    } catch (e) {
      return { status: 502, body: { error: (e as Error).message } };
    }
  }

  /* ---------------- Owner ---------------- */
  route('GET', '/api/billing', (req, res, svc) => {
    const owner = svc.store.get('owners', req.params.ownerId)!;
    expireOffers(svc.store, svc.clock.now());
    json(res, 200, {
      enabled: !!process.env.STRIPE_SECRET_KEY, plan: owner.plan, billing: owner.billing ?? null, onboarding: owner.onboarding ?? null,
      offers: svc.store.list('offers', (o) => o.ownerId === owner.id || (!!o.email && o.email === cleanEmail(owner.email))).map((o) => offerView(svc, o)),
      referral: { code: referralCodeFor(svc.store, owner), link: `${svc.cfg.publicUrl.replace(/\/$/, '')}/?ref=${svc.store.get('owners', owner.id)!.referralCode}`, creditPerReferral: REFERRAL_CREDIT_CENTS },
      prices: LIST_PRICE, basePrices: BASE_PRICE,
    });
  }, true);

  route('GET', '/api/offers', (req, res, svc) => {
    const owner = svc.store.get('owners', req.params.ownerId)!;
    const plan = asPlan(req.query.get('plan'), owner.plan), term = asTerm(req.query.get('term'), 'monthly');
    json(res, 200, usableOffers(svc.store, { owner }, plan, term, svc.clock.now()).map((o) => offerView(svc, o)));
  }, true);

  route('POST', '/api/billing/checkout', async (req, res, svc) => {
    const owner = svc.store.get('owners', req.params.ownerId)!;
    const r = await startCheckout(svc, owner, {
      plan: asPlan(req.body?.plan, owner.plan), term: asTerm(req.body?.term, 'monthly'),
      doors: asDoors(req.body?.doors, mine(svc, 'properties', owner.id).length || 1), offerId: req.body?.offerId || undefined,
    });
    json(res, r.status, r.body);
  }, true);

  /* ---------------- Public signup (no demo needed) ---------------- */
  route('POST', '/api/public/signup', async (req, res, svc) => {
    const form = String(req.headers['content-type'] ?? '').includes('urlencoded');
    const fail = (code: number, msg: string) => (form ? html(res, code, page('Something needs fixing', `<h1>Almost there</h1><p>${esc(msg)}</p><p><a href="javascript:history.back()">Go back</a></p>`)) : json(res, code, { error: msg }));
    const b = req.body ?? {};
    const email = cleanEmail(b.email), name = String(b.name ?? '').trim().slice(0, 80), phone = normPhone(b.phone);
    if (!name) return fail(400, 'Please enter your name.');
    if (!validEmail(email)) return fail(400, 'Please enter a valid email.');
    if (!/^\+\d{10,15}$/.test(phone)) return fail(400, 'Please enter a mobile number, like 720-555-0123.');
    const yes = (v: unknown) => v === true || v === 'yes' || v === 'on' || v === 'true';
    if (!yes(b.agree)) return fail(400, 'Please agree to the Terms of service to continue.');
    const now = svc.clock.now();
    // A record of what they agreed to and when (kept with the account).
    const consents = { termsAcceptedAt: now.toISOString(), termsVersion: TERMS_VERSION, smsConsent: yes(b.smsConsent), smsConsentAt: yes(b.smsConsent) ? now.toISOString() : undefined, ip: clientIp(req) };

    let owner = svc.store.find('owners', (o) => cleanEmail(o.email) === email);
    if (owner?.billing?.status === 'active') return fail(409, 'That email already has an active KeyHelm account. Text us or reply to your welcome email for help.');
    const viaOffer = b.offerId ? svc.store.get('offers', String(b.offerId)) : undefined;
    if (!owner) {
      owner = svc.store.insert('owners', {
        name, email, phone, plan: asPlan(b.plan, 'autopilot'), timezone: svc.cfg.tz, createdAt: now.toISOString(),
        source: viaOffer?.kind === 'demo' ? 'demo' : 'web', onboarding: { status: 'not_booked', updatedAt: now.toISOString() }, consents,
      });
    } else {
      owner = svc.store.update('owners', owner.id, { consents });
    }
    // Offers issued to this email before they had an account now belong to the account.
    for (const o of svc.store.list('offers', (x) => !x.ownerId && x.email === email)) svc.store.update('offers', o.id, { ownerId: owner.id });

    const plan = asPlan(b.plan, owner.plan), term = asTerm(b.term, 'monthly'), doors = asDoors(b.doors, 1);

    // Referral: a friend's code gives the new owner a referral offer (the friend is credited after month one).
    const ref = String(b.ref ?? '').trim().toUpperCase();
    const referrer = ref ? svc.store.find('owners', (o) => o.referralCode === ref && o.id !== owner!.id) : undefined;
    if (referrer && !svc.store.find('offers', (o) => o.ownerId === owner!.id && o.kind === 'referral')) {
      const pr = PRESETS.referral;
      issueOffer(svc.store, { ...pr, ownerId: owner.id, referrerOwnerId: referrer.id, issuedBy: 'system', note: `Referred by ${referrer.name} (${ref})` }, now);
    }
    // Self-serve buyers (no demo) get a small welcome offer once, unless they already hold something better.
    if (!usableOffers(svc.store, { owner }, plan, term, now).length && !svc.store.find('offers', (o) => o.ownerId === owner!.id && o.kind === 'web_intro')) {
      const pr = term === 'contract12' ? PRESETS['web-intro-annual'] : PRESETS['web-intro'];
      issueOffer(svc.store, { ...pr, ownerId: owner.id, issuedBy: 'system', note: 'Automatic: self-serve signup' }, now);
    }

    const r = await startCheckout(svc, svc.store.get('owners', owner.id)!, { plan, term, doors, offerId: viaOffer && viaOffer.status === 'issued' ? viaOffer.id : undefined });
    svc.engine.audit({ ownerId: owner.id, actor: 'owner', action: 'billing.signup', detail: `Signup: ${plan}, ${termLabel(term)}, ${doors} door(s)${r.status === 200 && (r.body as any).offer ? `, offer "${(r.body as any).offer.title}"` : ''}.` });
    if (form) {
      if (r.status === 200) { res.writeHead(303, { location: (r.body as any).url }); res.end(); return; }
      return fail(r.status, (r.body as any).error);
    }
    json(res, r.status, r.body);
  });

  /* ---------------- Personal offer page ---------------- */
  route('GET', '/offer/:id', (req, res, svc) => {
    expireOffers(svc.store, svc.clock.now());
    const o = svc.store.get('offers', req.params.id);
    if (!o || o.status === 'revoked') return html(res, 404, page('Offer not found', '<h1>This offer link isn\'t valid</h1><p class="muted">Ask the person who sent it for a new one.</p>'));
    if (o.status !== 'issued') return html(res, 410, page('Offer ended', `<h1>This offer has ${o.status === 'redeemed' ? 'been used' : 'ended'}</h1><p class="muted">You can still <a href="/#pricing">see our plans</a>.</p>`));
    const owner = o.ownerId ? svc.store.get('owners', o.ownerId) : undefined;
    const plans = (o.plans ?? PLANS) as Plan[];
    const ends = new Date(o.expiresAt).toLocaleString('en-US', { timeZone: svc.cfg.tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const rows = plans.map((p) => o.terms.map((t) => `<tr><td>${p[0].toUpperCase() + p.slice(1)} · ${termLabel(t)}</td><td><s class="muted">${usd(LIST_PRICE[p][t])}</s> <b>${usd(offerPrice({ mode: o.mode ?? 'percent', percentOff: o.percentOff }, p, t))}</b>/door for ${o.months} month${o.months > 1 ? 's' : ''}</td></tr>`).join('')).join('');
    html(res, 200, page(`${BRAND.name}: your offer`, `
<p class="muted">A private offer for ${esc(owner?.name ?? o.email ?? 'you')} · ends ${esc(ends)}</p>
<h1>${esc(o.title)}</h1>
<div class="card"><table style="width:100%;border-collapse:collapse">${rows}</table>
<p class="muted">After ${o.months} month${o.months > 1 ? 's' : ''}, the standard per-door price applies. Your first month is charged today. ${o.terms.includes('contract12') && !o.terms.includes('monthly') ? 'Requires a 12-month agreement, billed monthly.' : ''} This offer is for you only and can't be combined with other offers.</p></div>
<form class="card" method="post" action="/api/public/signup">
<input type="hidden" name="offerId" value="${esc(o.id)}">
<label for="n">Your name</label><input id="n" name="name" required autocomplete="name" value="${esc(owner?.name ?? '')}">
<label for="e">Email</label><input id="e" name="email" type="email" required autocomplete="email" value="${esc(owner?.email ?? o.email ?? '')}">
<label for="ph">Mobile phone</label><input id="ph" name="phone" required autocomplete="tel" value="${esc(owner?.phone ?? '')}">
<label for="p">Plan</label><select id="p" name="plan" style="width:100%;min-height:48px;border:1.5px solid #D8E1F2;border-radius:12px;padding:10px 14px;font:inherit">${plans.map((p) => `<option value="${p}" ${p === (owner?.plan ?? 'autopilot') ? 'selected' : ''}>${p[0].toUpperCase() + p.slice(1)}</option>`).join('')}</select>
<label for="t">Billing</label><select id="t" name="term" style="width:100%;min-height:48px;border:1.5px solid #D8E1F2;border-radius:12px;padding:10px 14px;font:inherit">${o.terms.map((t) => `<option value="${t}">${termLabel(t)}</option>`).join('')}</select>
<label for="d">Rental homes</label><input id="d" name="doors" type="number" min="1" max="500" value="${owner?.billing?.doors ?? 1}">
<label class="check"><input type="checkbox" name="agree" value="yes" required><span>I agree to the <a href="/terms" target="_blank" rel="noopener">Terms of service</a> and the automatic monthly renewal, and I have read the <a href="/privacy" target="_blank" rel="noopener">Privacy policy</a> and <a href="/refunds" target="_blank" rel="noopener">Refund and cancellation policy</a>.</span></label>
<label class="check"><input type="checkbox" name="smsConsent" value="yes"><span>Text me about my account, like repair approvals and tenant updates. Optional. Message frequency varies. Msg and data rates may apply. Reply STOP to opt out or HELP for help. Consent is not required to buy.</span></label>
<button>Claim offer and check out</button></form>`));
  });

  /* ---------------- After checkout: set a password, then the app (which offers the onboarding call) ---------------- */
  route('GET', '/billing/done', async (req, res, svc) => {
    const sid = req.query.get('session') ?? '';
    const owner = sid ? svc.store.find('owners', (o) => o.billing?.checkoutSessionId === sid) : undefined;
    if (owner) return checkoutDone(req, res, svc, owner, sid); // owner-routes.ts: one-time setup link → /app (Calendly link via GET /api/me)
    const cal = process.env.CALENDLY_URL;
    html(res, 200, page(`${BRAND.name}: you're subscribed`, `<h1>You're all set</h1><p>Thanks for subscribing to ${BRAND.name}. Your receipt is on its way by email.</p>${cal ? `<p><a href="${esc(cal)}">Book your onboarding call</a></p>` : '<p>We\'ll reach out within one business day to schedule your onboarding call.</p>'}`));
  });

  /* ---------------- Webhooks ---------------- */
  // Stripe: KeyHelm's OWN subscription billing only. KeyHelm never collects rent.
  route('POST', '/webhooks/stripe', async (req, res, svc) => {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) return json(res, 503, { error: 'STRIPE_WEBHOOK_SECRET is not set' });
    if (!verifyStripeSignature(secret, req.raw, String(req.headers['stripe-signature'] ?? ''))) return json(res, 400, { error: 'bad signature' });
    const done = applyBillingEvent(svc.store, req.body, svc.clock.now().toISOString());
    if (done) {
      const b = done.billing;
      svc.engine.audit({ ownerId: done.ownerId, actor: 'system', action: 'billing.updated', detail: `KeyHelm subscription: ${b.status}${b.plan ? `, ${b.plan}` : ''}${b.term ? `, ${termLabel(b.term)}` : ''}${b.doors ? `, ${b.doors} door${b.doors === 1 ? '' : 's'}` : ''} (${req.body.type}).` });
      if (done.started) {
        const o = svc.store.get('owners', done.ownerId)!;
        if (!o.onboarding) svc.store.update('owners', o.id, { onboarding: { status: 'not_booked', updatedAt: svc.clock.now().toISOString() } });
        svc.engine.emit('owner.signed_up', { ownerId: done.ownerId });
        await svc.engine.drain();
      }
      if (done.referralReward) {
        const ref = svc.store.get('owners', done.referralReward.referrerOwnerId);
        const client = billingClient(svc);
        let detail = `Referral reward of ${usd(REFERRAL_CREDIT_CENTS)} earned (offer ${done.referralReward.offerId}).`;
        if (ref?.billing?.customerId && client) {
          try { await client.credit(ref.billing.customerId, REFERRAL_CREDIT_CENTS, `Referral reward: ${svc.store.get('owners', done.ownerId)?.name ?? 'new owner'}`); detail += ' Credited to their Stripe balance.'; }
          catch (e) { detail += ` Credit failed: ${(e as Error).message}. Apply it by hand in Stripe.`; }
        } else detail += ' Referrer has no Stripe customer yet; apply it by hand.';
        svc.engine.audit({ ownerId: done.referralReward.referrerOwnerId, actor: 'system', action: 'billing.referral_credit', detail });
      }
    }
    json(res, 200, { received: true });
  });

  // Calendly: invitee.created / invitee.canceled for the onboarding event.
  route('POST', '/webhooks/calendly', (req, res, svc) => {
    const secret = process.env.CALENDLY_WEBHOOK_SECRET;
    if (!secret) return json(res, 503, { error: 'CALENDLY_WEBHOOK_SECRET is not set' });
    if (!verifyStripeSignature(secret, req.raw, String(req.headers['calendly-webhook-signature'] ?? ''), 600)) return json(res, 400, { error: 'bad signature' }); // same t=…,v1=HMAC-SHA256 scheme as Stripe
    const p = req.body?.payload ?? {};
    const ownerId = p.tracking?.utm_content;
    const owner = (ownerId && svc.store.get('owners', ownerId)) || svc.store.find('owners', (o) => cleanEmail(o.email) === cleanEmail(p.email));
    if (owner && (req.body.event === 'invitee.created' || req.body.event === 'invitee.canceled')) {
      const booked = req.body.event === 'invitee.created';
      svc.store.update('owners', owner.id, { onboarding: { status: booked ? 'booked' : 'canceled', startTime: p.scheduled_event?.start_time, eventUri: p.event ?? p.scheduled_event?.uri, updatedAt: svc.clock.now().toISOString() } });
      svc.engine.audit({ ownerId: owner.id, actor: 'owner', action: booked ? 'onboarding.booked' : 'onboarding.canceled', detail: booked ? `Onboarding call booked for ${p.scheduled_event?.start_time ?? 'a time on Calendly'}.` : 'Onboarding call canceled.' });
    }
    json(res, 200, { received: true });
  });

  /* ---------------- Admin ---------------- */
  route('GET', '/admin', (_req, res) => {
    const f = join(ROOT, 'apps/admin/index.html');
    html(res, 200, existsSync(f) ? readFileSync(f, 'utf8') : 'admin page missing');
  });

  route('GET', '/api/admin/overview', (req, res, svc) => {
    if (!isAdmin(req)) return json(res, 401, { error: 'admin only' });
    expireOffers(svc.store, svc.clock.now());
    json(res, 200, {
      owners: svc.store.list('owners').map((o) => ({ id: o.id, name: o.name, email: o.email, phone: o.phone, plan: o.plan, source: o.source ?? 'seed', billing: o.billing ?? null, onboarding: o.onboarding ?? null, referralCode: o.referralCode ?? null })),
      offers: svc.store.list('offers').sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((o) => ({ ...offerView(svc, o), ownerId: o.ownerId ?? null, email: o.email ?? null, issuedBy: o.issuedBy, campaign: o.campaign ?? null, note: o.note ?? null, createdAt: o.createdAt, redeemedAt: o.redeemedAt ?? null })),
      presets: PRESETS, rules: OFFER_RULES, prices: LIST_PRICE, basePrices: BASE_PRICE, floors: PRICE_FLOOR, maxMonthsMonthly: MAX_MONTHS_MONTHLY, billingEnabled: !!process.env.STRIPE_SECRET_KEY, calendly: !!process.env.CALENDLY_URL, calendlyWebhook: !!(process.env.CALENDLY_TOKEN && process.env.CALENDLY_WEBHOOK_SECRET),
    });
  });

  route('POST', '/api/admin/offers', (req, res, svc) => {
    if (!isAdmin(req)) return json(res, 401, { error: 'admin only' });
    const b = req.body ?? {};
    const base = b.preset ? PRESETS[String(b.preset)] : undefined;
    if (b.preset && !base) return json(res, 400, { error: 'Unknown preset' });
    const targets: { ownerId?: string; email?: string }[] = [];
    if (b.ownerId) targets.push({ ownerId: String(b.ownerId) });
    for (const e of String(b.emails ?? b.email ?? '').split(/[\s,;]+/).map(cleanEmail).filter(Boolean)) {
      if (!validEmail(e)) return json(res, 400, { error: `Not a valid email: ${e}` });
      const existing = svc.store.find('owners', (o) => cleanEmail(o.email) === e);
      targets.push(existing ? { ownerId: existing.id } : { email: e });
    }
    if (!targets.length) return json(res, 400, { error: 'Pick an owner or enter at least one email' });
    if (targets.length > 200) return json(res, 400, { error: 'Up to 200 people per batch' });
    const input: Omit<IssueInput, 'ownerId' | 'email'> = {
      kind: (b.kind ?? base?.kind) as Offer['kind'], title: String(b.title || base?.title || '').slice(0, 120),
      mode: (b.mode === 'base' || b.mode === 'percent' ? b.mode : base?.mode ?? 'percent') as Offer['mode'],
      percentOff: Number(b.percentOff ?? base?.percentOff), months: Number(b.months ?? base?.months),
      terms: (b.terms ?? base?.terms) as BillingTerm[] | undefined, plans: b.plans?.length ? b.plans : undefined,
      days: b.days !== undefined && b.days !== '' ? Number(b.days) : base?.days, campaign: b.campaign ? String(b.campaign).slice(0, 60) : undefined,
      note: b.note ? String(b.note).slice(0, 300) : undefined, issuedBy: 'admin',
    };
    if (!input.title) return json(res, 400, { error: 'Give the offer a title the customer will see' });
    const now = svc.clock.now();
    try {
      const made = targets.map((t) => {
        if (input.kind === 'winback') {
          const o = t.ownerId ? svc.store.get('owners', t.ownerId) : undefined;
          if (o?.billing?.status !== 'canceled') throw new Error(`Win-back offers are only for former customers${o ? ` (${o.name} isn't canceled)` : ''}`);
        }
        return issueOffer(svc.store, { ...input, ...t }, now);
      });
      for (const o of made) svc.engine.audit({ ownerId: o.ownerId, actor: 'system', action: 'offer.issued', detail: `${OFFER_RULES[o.kind].label} issued by admin: "${o.title}" (${o.mode === 'base' ? 'original price' : o.percentOff + '% off'} × ${o.months} mo, ends ${o.expiresAt.slice(0, 10)}).` });
      json(res, 200, made.map((o) => offerView(svc, o)));
    } catch (e) {
      json(res, 400, { error: (e as Error).message });
    }
  });

  // One click: subscribe Calendly's webhook to this server (Calendly only offers webhooks through its API).
  // Needs CALENDLY_TOKEN (a Calendly personal access token) and CALENDLY_WEBHOOK_SECRET in Railway.
  route('POST', '/api/admin/calendly/connect', async (req, res, svc) => {
    if (!isAdmin(req)) return json(res, 401, { error: 'admin only' });
    const tok = process.env.CALENDLY_TOKEN, key = process.env.CALENDLY_WEBHOOK_SECRET;
    if (!tok || !key) return json(res, 400, { error: 'Add CALENDLY_TOKEN and CALENDLY_WEBHOOK_SECRET in Railway first.' });
    const cal = async (method: string, path: string, body?: unknown) => {
      const r = await fetch('https://api.calendly.com' + path, { method, headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      const j: any = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.message ?? j?.title ?? `Calendly ${r.status}`);
      return j;
    };
    try {
      const me = (await cal('GET', '/users/me')).resource;
      const url = `${svc.cfg.publicUrl.replace(/\/$/, '')}/webhooks/calendly`;
      const existing = await cal('GET', `/webhook_subscriptions?organization=${encodeURIComponent(me.current_organization)}&user=${encodeURIComponent(me.uri)}&scope=user`);
      if ((existing.collection ?? []).some((w: any) => w.callback_url === url && w.state === 'active')) return json(res, 200, { ok: true, already: true, url });
      await cal('POST', '/webhook_subscriptions', { url, events: ['invitee.created', 'invitee.canceled'], organization: me.current_organization, user: me.uri, scope: 'user', signing_key: key });
      json(res, 200, { ok: true, url });
    } catch (e) {
      json(res, 502, { error: `Calendly said: ${(e as Error).message}. Webhooks need a paid Calendly plan.` });
    }
  });

  route('POST', '/api/admin/offers/:id/revoke', (req, res, svc) => {
    if (!isAdmin(req)) return json(res, 401, { error: 'admin only' });
    const o = svc.store.get('offers', req.params.id);
    if (!o) return json(res, 404, { error: 'not found' });
    if (o.status !== 'issued') return json(res, 400, { error: `Already ${o.status}` });
    json(res, 200, offerView(svc, svc.store.update('offers', o.id, { status: 'revoked' })));
  });
}
