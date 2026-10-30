// My Home: a tenant's private page. No login, just a long random link the owner shares (see
// POST /api/tenants/:id/my-home). It shows the home guide, lease basics, how to reach us and the signed
// lease. Read-only, and it ends when the tenant is marked as moved out. KeyHelm never takes payments here.

import { randomBytes } from 'node:crypto';
import type { Services } from '../services.ts';
import type { Store } from '../store/store.ts';
import type { Lease, Tenant } from '../domain/types.ts';
import type { SignRequest } from '../adapters/esign-native.ts';
import { firstName, money, ordinal } from '../workflows/lib.ts';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** The tenant's link, made on first use. `fresh` makes a new one and turns the old one off. */
export function myHomeUrl(store: Store, tenantId: string, publicUrl: string, fresh = false): string {
  let token = store.kvGet<string>('myHomeByTenant', tenantId);
  if (token && fresh) { store.kvDelete('myHome', token); token = undefined; }
  if (!token) {
    token = randomBytes(24).toString('base64url');
    store.kvSet('myHome', token, tenantId);
    store.kvSet('myHomeByTenant', tenantId, token);
  }
  return `${publicUrl.replace(/\/$/, '')}/my-home/${token}`;
}

/** Who a link belongs to. Former tenants' links stop working. */
export function myHomeTenant(store: Store, token: string): Tenant | undefined {
  if (!/^[\w-]{32}$/.test(token)) return undefined;
  const id = store.kvGet<string>('myHome', token);
  const t = id ? store.get('tenants', id) : undefined;
  return t && t.status !== 'former' ? t : undefined;
}

const longDate = (d: string, timeZone: string) => new Date(d).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone });

const leaseOf = (store: Store, t: Tenant): Lease | undefined => store.find('leases', (l) => l.tenantIds.includes(t.id) && l.status === 'active');

/** Every signature on the lease this tenant signed, or nothing if they didn't sign it here. */
function signedLease(store: Store, t: Tenant, lease: Lease | undefined): SignRequest[] {
  if (!lease) return [];
  const all = store.kvList<SignRequest>('sign').filter((r) => r.refId === lease.id && r.status === 'signed');
  const mine = all.filter((r) => r.signer.role === 'tenant' && r.signer.name === t.name).pop();
  return mine ? all.filter((r) => r.envelopeId === mine.envelopeId) : [];
}

const STYLE = `<style>dl{margin:0}dt{font-weight:700;margin-top:12px}dt:first-child{margin-top:0}dd{margin:0}.text{white-space:pre-wrap;margin:0}h2{font-size:20px;margin:0 0 10px}.cta{display:inline-block;background:#C8502D;color:#fff;border-radius:10px;padding:12px 20px;font-weight:700;text-decoration:none;margin-top:12px}</style>`;
const card = (title: string, inner: string) => `<section class="card"><h2>${esc(title)}</h2>${inner}</section>`;
const list = (rows: [string, string][]) => `<dl>${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;

export function myHomePage(svc: Services, t: Tenant, token: string): { title: string; inner: string } {
  const { store } = svc;
  const p = store.get('properties', t.propertyId)!;
  const rules = store.get('rules', t.ownerId);
  const lease = leaseOf(store, t);
  const g = p.homeGuide ?? {};
  const contacts = Object.entries(g.contacts ?? {});
  const tips = Object.entries(g.tips ?? {});
  const details = [...Object.entries(p.facts), ...Object.entries(rules?.facts ?? {})].filter(([k]) => k !== 'Available from');
  const hasGuide = !!(g.welcome || g.rules || contacts.length || tips.length);

  const leaseRows: [string, string][] = [];
  if (lease) {
    leaseRows.push(['Lease dates', `${longDate(lease.startDate, 'UTC')} to ${longDate(lease.endDate, 'UTC')}`]);
    leaseRows.push(['Rent', `${money(lease.rent)} a month${rules ? `, due on the ${ordinal(rules.rentDueDay)}` : ''}`]);
  }
  leaseRows.push(['How to pay', rules?.howToPay || 'Pay your landlord directly, the way you normally do.']);
  const signed = signedLease(store, t, lease).length > 0;

  const inner = STYLE + `<h1>${esc(p.address)}</h1><p class="muted">Hi ${esc(firstName(t.name))}. This page is private to you, so please don't share the link.</p>`
    + (g.welcome ? card('Welcome', `<p class="text">${esc(g.welcome)}</p>`) : '')
    + card('Need something?', `<p>For a repair or a question, reply to any ${esc(svc.brand.name)} text or email. Send a photo if you can.</p><p><strong>Gas smell, fire, smoke or someone hurt? Call 911 first.</strong></p>`)
    + card('Your lease', list(leaseRows) + (signed ? `<a class="cta" href="/my-home/${esc(token)}/lease">Read your signed lease</a>` : `<p class="muted">Need a copy of your lease? Ask your landlord.</p>`))
    + (contacts.length ? card('Who to contact', list(contacts)) : '')
    + (g.rules ? card('House rules', `<p class="text">${esc(g.rules)}</p>`) : '')
    + (tips.length ? card('Good to know', list(tips)) : '')
    + (details.length ? card('About your home', list(details)) : '')
    + (hasGuide ? '' : `<p class="muted">Your landlord hasn't added a home guide yet.</p>`);
  return { title: `My Home: ${p.address}`, inner };
}

/** The signed lease, read-only. Undefined when this tenant has no lease signed in KeyHelm. */
export function myHomeLease(svc: Services, t: Tenant, token: string): { title: string; inner: string } | undefined {
  const sigs = signedLease(svc.store, t, leaseOf(svc.store, t));
  if (!sigs.length) return undefined;
  const rows = sigs.map((s) => `<li>${esc(s.signedName ?? s.signer.name)}, ${esc(longDate(s.signedAt!, svc.cfg.tz))}</li>`).join('');
  return {
    title: sigs[0].title,
    inner: `<p><a href="/my-home/${esc(token)}">Back to My Home</a></p><h1>${esc(sigs[0].title)}</h1><pre>${esc(sigs[0].body)}</pre><section class="card"><strong>Signed by</strong><ul>${rows}</ul></section>`,
  };
}
