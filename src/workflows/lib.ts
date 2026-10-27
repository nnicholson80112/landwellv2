// Helpers shared by all workflows.

import type { Ctx } from '../engine/engine.ts';
import type { Services } from '../services.ts';
import type { Channel, Owner, Property, Prospect, Tenant, Vendor, Cents } from '../domain/types.ts';
import type { Fact } from '../ai/types.ts';
import type { Store } from '../store/store.ts';
import { localParts } from '../engine/clock.ts';

export type C = Ctx<Services>;

export const money = (c: Cents | undefined): string =>
  c === undefined ? 'n/a' : '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 });

export const firstName = (n: string): string => n.split(/\s+/)[0];

export function normalizePhone(p: string): string {
  const d = p.replace(/[^\d+]/g, '');
  if (d.startsWith('+')) return d;
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d.startsWith('1')) return '+' + d;
  return d;
}
/** A phone as people write it in a text: "+17209305782" → "720-930-5782". Anything else is left as is. */
export function phoneForText(p: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(p.trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : p;
}
export const addressKey = (a: string): string => (a.includes('@') ? a.trim().toLowerCase() : normalizePhone(a));

export type Party =
  | { role: 'owner'; owner: Owner }
  | { role: 'tenant'; tenant: Tenant; ownerId: string }
  | { role: 'vendor'; vendor: Vendor; ownerId: string }
  | { role: 'prospect'; prospect: Prospect; ownerId: string }
  | { role: 'unknown' };

/** Who is this phone number or email? */
export function identify(store: Store, from: string, ownerHint?: string): Party {
  const k = addressKey(from);
  const match = (p?: string, e?: string) => (p && addressKey(p) === k) || (e && e.toLowerCase() === k);
  const owner = store.find('owners', (o) => !!match(o.phone, o.email));
  if (owner) return { role: 'owner', owner };
  const tenant = store.find('tenants', (t) => t.status !== 'former' && !!match(t.phone, t.email) && (!ownerHint || t.ownerId === ownerHint));
  if (tenant) return { role: 'tenant', tenant, ownerId: tenant.ownerId };
  const vendor = store.find('vendors', (v) => !!match(v.phone, v.email) && (!ownerHint || v.ownerId === ownerHint));
  if (vendor) return { role: 'vendor', vendor, ownerId: vendor.ownerId };
  const prospect = store.find('prospects', (p) => !!match(p.phone, p.email) && (!ownerHint || p.ownerId === ownerHint));
  if (prospect) return { role: 'prospect', prospect, ownerId: prospect.ownerId };
  // Former tenants still write about their deposit; the front desk sends them to the owner.
  const former = store.find('tenants', (t) => t.status === 'former' && !!match(t.phone, t.email) && (!ownerHint || t.ownerId === ownerHint));
  if (former) return { role: 'tenant', tenant: former, ownerId: former.ownerId };
  return { role: 'unknown' };
}

/** True when this phone number replied STOP. Texts to it are skipped until it replies START. */
export function optedOut(store: Store, to: string, channel: Channel): boolean {
  return (channel === 'sms' || channel === 'voice') && !!store.kvGet('optOut', addressKey(to));
}

/** Send a message exactly once per run (keyed by label) and record it. */
export async function send(ctx: C, m: { label: string; ownerId?: string; to: string; channel: Channel; body: string; subject?: string; meta?: Record<string, unknown> }): Promise<void> {
  await ctx.step(`send:${m.label}`, async () => {
    if (m.channel === 'sms' && optedOut(ctx.store, m.to, 'sms')) return 'skipped:opted-out';
    const r = await ctx.svc.adapters.messaging.send({ channel: m.channel, to: m.to, body: m.body, subject: m.subject });
    ctx.store.insert('messages', { ownerId: m.ownerId, threadKey: addressKey(m.to), direction: 'out', channel: m.channel, to: m.to, body: m.body, media: [], at: ctx.svc.clock.now().toISOString(), meta: { ...m.meta, providerId: r.providerId, runId: ctx.runId } });
    return r.providerId;
  });
}

export function contactOf(p: { phone?: string; email?: string; preferredChannel?: Channel }): { to: string; channel: Channel } | null {
  if (p.preferredChannel === 'email' && p.email) return { to: p.email, channel: 'email' };
  if (p.phone) return { to: p.phone, channel: 'sms' };
  if (p.email) return { to: p.email, channel: 'email' };
  return null;
}

/** Where to reach a tenant: their preferred channel, or email if they texted STOP. */
export function tenantContact(store: Store, tenant: Tenant): { to: string; channel: Channel } | null {
  const c = contactOf(tenant);
  if (c && optedOut(store, c.to, c.channel) && tenant.email) return { to: tenant.email, channel: 'email' };
  return c;
}

export async function tellTenant(ctx: C, label: string, tenant: Tenant, body: string): Promise<void> {
  const c = tenantContact(ctx.store, tenant);
  if (c) await send(ctx, { label, ownerId: tenant.ownerId, ...c, body, subject: c.channel === 'email' ? `${ctx.svc.brand.name}: ${propertyName(ctx.store, tenant.propertyId)}` : undefined });
}

/**
 * For notices that can wait (rent reminders, renewal offers, move-out steps):
 * hold them until the owner's quiet hours end, then send. Replies to a tenant who
 * just wrote, repairs and emergencies use tellTenant and go right away.
 */
export async function noticeTenant(ctx: C, label: string, tenant: Tenant, body: string): Promise<void> {
  const until = await ctx.step(`quiet:${label}`, () => quietUntil(ctx.svc, tenant.ownerId, ctx.svc.clock.now()));
  if (until) await ctx.sleepUntil(until, 'Waiting for quiet hours to end');
  await tellTenant(ctx, label, tenant, body);
}
export async function tellVendor(ctx: C, label: string, vendor: Vendor, body: string): Promise<void> {
  const c = contactOf(vendor);
  if (c) await send(ctx, { label, ownerId: vendor.ownerId, ...c, body });
}
export async function tellOwner(ctx: C, label: string, ownerId: string, body: string): Promise<void> {
  const o = ctx.store.get('owners', ownerId);
  // Text only owners who agreed to texts at signup (seeded and older accounts have no record and keep texts).
  const sms = !!o?.phone && o.consents?.smsConsent !== false;
  if (o) await send(ctx, { label, ownerId, to: sms ? o.phone : o.email, channel: sms ? 'sms' : 'email', body });
}

/** Facts the AI is allowed to state for this conversation. */
export function buildFacts(store: Store, ownerId: string, propertyId?: string, publicUrl = ''): Fact[] {
  const rules = store.get('rules', ownerId);
  const facts: Fact[] = [];
  if (rules) {
    facts.push({ label: 'Rent due date', value: `on the ${ordinal(rules.rentDueDay)} of each month` });
    facts.push({ label: 'How to pay rent', value: rules.howToPay || 'Rent is paid to your landlord directly, the way you normally pay. Ask your landlord if you are unsure.' });
    if (rules.petPolicy) facts.push({ label: 'Pet policy', value: rules.petPolicy });
    for (const [k, v] of Object.entries(rules.facts)) facts.push({ label: k, value: v });
  }
  const p = propertyId ? store.get('properties', propertyId) : undefined;
  const homes = p ? [p] : store.list('properties', (x) => x.ownerId === ownerId && (x.status === 'listed' || x.status === 'vacant'));
  for (const h of homes) {
    const name = h.address;
    if (h.status === 'listed' || h.status === 'vacant') {
      facts.push({ label: `Availability of ${name}`, value: h.status === 'vacant' || !h.facts['Available from'] || h.facts['Available from'] === 'now' ? 'Available now; taking applications' : `Available from ${h.facts['Available from']}; taking applications` });
      facts.push({ label: `Rent for ${name}`, value: `${money(h.rent)}/month, all-in` });
      facts.push({ label: `Security deposit for ${name}`, value: money(h.deposit) });
      facts.push({ label: `Size of ${name}`, value: `${h.beds} bed / ${h.baths} bath` });
      facts.push({ label: `Application for ${name}`, value: `Apply here: ${publicUrl}/apply/${h.id}` });
      if (rules && rules.showingMode !== 'owner') facts.push({ label: `Showings for ${name}`, value: `Self-guided tours run daily ${hourLabel(rules.showingHours.start)} to ${hourLabel(rules.showingHours.end)} after a quick ID check.` });
      else facts.push({ label: `Showings for ${name}`, value: 'Reply with a few days and times that work and the owner will confirm a showing.' });
    }
    for (const [k, v] of Object.entries(h.facts)) if (k !== 'Available from') facts.push({ label: `${k} (${name})`, value: v });
  }
  return facts;
}

export function hourLabel(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  const h12 = h % 12 || 12;
  return `${h12}${m ? ':' + String(m).padStart(2, '0') : ''} ${h < 12 ? 'AM' : 'PM'}`;
}

export function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

export function propertyName(store: Store, id?: string): string {
  return (id && store.get('properties', id)?.address) || 'the property';
}

export function activeLeaseFor(store: Store, propertyId: string) {
  return store.find('leases', (l) => l.propertyId === propertyId && l.status === 'active');
}

export function isQuietHours(svc: Services, ownerId: string, at: Date = svc.clock.now()): boolean {
  const r = svc.store.get('rules', ownerId);
  if (!r) return false;
  const t = localParts(at, svc.cfg.tz).time;
  const { start, end } = r.quietHours;
  return start > end ? t >= start || t < end : t >= start && t < end;
}

/** If it's quiet hours now, the moment they end (ISO); otherwise null. */
export function quietUntil(svc: Services, ownerId: string, from: Date): string | null {
  if (!isQuietHours(svc, ownerId, from)) return null;
  let t = Math.ceil(from.getTime() / (15 * 60_000)) * 15 * 60_000;
  for (let i = 0; i < 4 * 24 && isQuietHours(svc, ownerId, new Date(t)); i++) t += 15 * 60_000;
  return new Date(t).toISOString();
}

/** "2026-11-01" → "Sun, Nov 1" (adds the year when it isn't this year). */
export function niceDate(ymd: string, today?: string): string {
  const d = new Date(ymd.slice(0, 10) + 'T12:00:00Z');
  if (isNaN(d.getTime())) return ymd;
  const sameYear = !today || today.slice(0, 4) === ymd.slice(0, 4);
  return d.toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

/** Cut text for a text message at a word boundary. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  return cut.slice(0, Math.max(cut.lastIndexOf(' '), max * 0.6)).replace(/[\s,;:.]+$/, '') + '…';
}

/** Quote what someone wrote inside a sentence without doubling punctuation. */
export function quote(body: string, max = 120): string {
  return `"${clip(body.trim().replace(/\s+/g, ' '), max)}"`;
}

/** A tenant's words as a job line for a vendor: "Resident reports: "I smell gas in the kitchen"". */
export function jobLine(summary: string): string {
  return /^(i|i'm|im|my|we|we're|our|there'?s|it'?s)\b/i.test(summary.trim()) ? `Resident reports: ${quote(summary, 140)}` : summary;
}

export type { Property, Tenant, Vendor };
