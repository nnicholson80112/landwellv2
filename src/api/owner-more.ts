// More of the owner app's API: the leasing pipeline, the calendar, the books and the state document
// library. Same rules as owner-routes.ts: scoped to the signed-in owner, plain 400s, cents out.
//
//   GET /api/leasing · GET /api/calendar?month=YYYY-MM · GET /api/books · POST /api/expenses
//   GET /api/documents · GET /api/documents/:doc?tenantId=&propertyId= (JSON) · GET /api/documents/:doc/page (printable page)

import type { ServerResponse } from 'node:http';
import type { Req, Handler } from './server.ts';
import type { Services } from '../services.ts';
import type { Expense, Owner, Property, Tenant } from '../domain/types.ts';
import { Invalid, body, dollars, fail, notFound, oneOf, text, ymd } from './owner-data.ts';
import { allows, entitlementsOf, MIN_PLAN } from '../billing/entitlements.ts';
import { PLAN_NAMES } from '../billing/plans.ts';
import { CO } from '../config/colorado.ts';
import { DOC_CSP, DOCS, docPage, isDocId, renderDoc, stateRules, type DocFields } from '../leases/state-docs.ts';

interface Kit {
  route: (method: string, path: string, h: Handler, auth?: boolean) => void;
  json: (res: ServerResponse, code: number, data: unknown) => void;
}

const mine = <T extends { ownerId: string }>(rows: T[], ownerId: string) => rows.filter((r) => r.ownerId === ownerId);
const addressOf = (p: Property | undefined) => (p ? `${p.address}, ${p.city}` : 'Unknown home');
const keyOf = (s: string | undefined) => String(s ?? '').replace(/[^\d@a-z.+]/gi, '').toLowerCase();

/* ---------------- leasing ---------------- */

export const LEASING_STAGES = [
  { id: 'inquiry', name: 'Inquiry' }, { id: 'tour', name: 'Tour' }, { id: 'applied', name: 'Applied' },
  { id: 'decision', name: 'Your decision' }, { id: 'approved', name: 'Approved' }, { id: 'lease_sent', name: 'Lease sent' },
] as const;

export function leasingView(svc: Services, ownerId: string) {
  const s = svc.store;
  const props = s.list('properties', (p) => p.ownerId === ownerId);
  const byId = new Map(props.map((p) => [p.id, p]));
  const homes = props.filter((p) => p.status !== 'occupied').map((p) => ({
    id: p.id, address: p.address, city: p.city, beds: p.beds, baths: p.baths, rent: p.rent, status: p.status,
    selfTours: p.lock?.kind === 'smart' || p.lock?.kind === 'lockbox',
  }));
  const apps = s.list('applications', (a) => a.ownerId === ownerId && !['denied', 'withdrawn'].includes(a.status));
  const appKeys = new Set(apps.flatMap((a) => [keyOf(a.phone), keyOf(a.email)]).filter(Boolean));
  const people: { id: string; name: string; propertyId?: string; address?: string; stage: string; when?: string; detail: string }[] = [];
  for (const a of apps) {
    const stage = a.status === 'ready_for_owner' ? 'decision' : a.status === 'approved' ? 'approved' : 'applied';
    people.push({ id: a.id, name: a.applicantName, propertyId: a.propertyId, address: addressOf(byId.get(a.propertyId)), stage, when: a.submittedAt,
      detail: stage === 'decision' ? 'Screening is done. Compare the report with your written criteria.' : stage === 'approved' ? 'Approved. The lease goes out next.' : 'Application in. Screening is running.' });
  }
  for (const p of s.list('prospects', (x) => x.ownerId === ownerId)) {
    if (appKeys.has(keyOf(p.phone)) || appKeys.has(keyOf(p.email))) continue;
    const tour = s.list('showings', (x) => x.prospectId === p.id && x.status !== 'cancelled').sort((a, b) => b.at.localeCompare(a.at))[0];
    const propertyId = tour?.propertyId ?? p.interestedIn;
    people.push({ id: p.id, name: p.name ?? 'New prospect', propertyId, address: propertyId ? addressOf(byId.get(propertyId)) : undefined,
      stage: tour ? 'tour' : 'inquiry', when: tour?.at ?? p.createdAt,
      detail: tour ? (tour.status === 'completed' ? 'Toured. KeyHelm sent the application link.' : `Self-tour ${tour.status === 'confirmed' ? 'booked' : 'requested'}.`) : 'Asked about a home.' });
  }
  for (const l of s.list('leases', (x) => x.ownerId === ownerId && x.status === 'out_for_signature')) {
    const names = l.tenantIds.map((t) => s.get('tenants', t)?.name).filter(Boolean).join(' and ') || 'New tenant';
    people.push({ id: l.id, name: names, propertyId: l.propertyId, address: addressOf(byId.get(l.propertyId)), stage: 'lease_sent', when: l.startDate, detail: `Lease starts ${l.startDate}. Waiting for signatures.` });
  }
  return { homes, stages: LEASING_STAGES, people, note: 'KeyHelm never scores, ranks or recommends applicants. You decide using the same written criteria for everyone.' };
}

/* ---------------- calendar ---------------- */

export function calendarView(svc: Services, owner: Owner, month: string) {
  const s = svc.store;
  const tz = owner.timezone || svc.cfg.tz;
  const dayOf = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
  const timeOf = (iso: string) => new Date(iso).toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
  const props = new Map(s.list('properties', (p) => p.ownerId === owner.id).map((p) => [p.id, p]));
  const events: { date: string; time?: string; title: string; kind: 'showing' | 'rent' | 'deadline' | 'repair' | 'task' | 'call'; tab?: string }[] = [];
  for (const sh of s.list('showings', (x) => x.ownerId === owner.id && ['requested', 'confirmed'].includes(x.status))) {
    const who = s.get('prospects', sh.prospectId)?.name ?? 'a prospect';
    events.push({ date: dayOf(sh.at), time: timeOf(sh.at), title: `Self-tour: ${who}, ${props.get(sh.propertyId)?.address ?? ''}`.replace(/, $/, ''), kind: 'showing', tab: 'leasing' });
  }
  const rentDays = new Map<string, number>();
  for (const c of s.list('charges', (x) => x.ownerId === owner.id && x.kind === 'rent' && x.status !== 'void')) rentDays.set(c.dueDate, (rentDays.get(c.dueDate) ?? 0) + 1);
  for (const [date, n] of rentDays) events.push({ date, title: `Rent due, ${n} ${n === 1 ? 'home' : 'homes'}`, kind: 'rent', tab: 'rent' });
  for (const l of s.list('leases', (x) => x.ownerId === owner.id && x.status === 'active')) {
    const who = l.tenantIds.map((t) => s.get('tenants', t)?.name).filter(Boolean).join(' and ');
    events.push({ date: l.endDate, title: `Lease ends: ${who || props.get(l.propertyId)?.address}`, kind: 'deadline', tab: 'homes' });
  }
  for (const w of s.list('workOrders', (x) => x.ownerId === owner.id && ['new', 'triaged', 'awaiting_vendor', 'awaiting_owner'].includes(x.status))) {
    events.push({ date: dayOf(w.respondBy), time: timeOf(w.respondBy), title: `Repair must start (Colorado): ${w.summary}`, kind: 'repair', tab: 'repairs' });
  }
  for (const t of s.list('tasks', (x) => x.ownerId === owner.id && x.status === 'open' && !!x.dueAt)) events.push({ date: dayOf(t.dueAt!), title: t.title, kind: 'task', tab: 'today' });
  if (owner.onboarding?.startTime) events.push({ date: dayOf(owner.onboarding.startTime), time: timeOf(owner.onboarding.startTime), title: 'Your KeyHelm setup call', kind: 'call' });
  return { month, events: events.filter((e) => e.date.startsWith(month)).sort((a, b) => (a.date + (a.time ?? '')).localeCompare(b.date + (b.time ?? ''))) };
}

/* ---------------- books ---------------- */

export function booksView(svc: Services, owner: Owner, months = 6) {
  const s = svc.store;
  const tz = owner.timezone || svc.cfg.tz;
  const monthOf = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit' }).format(new Date(iso)).slice(0, 7);
  const leases = new Map(s.list('leases', (l) => l.ownerId === owner.id).map((l) => [l.id, l]));
  const props = new Map(s.list('properties', (p) => p.ownerId === owner.id).map((p) => [p.id, p]));
  const entries = [
    ...s.list('payments', (p) => p.ownerId === owner.id).map((p) => ({ id: p.id, date: p.receivedAt.slice(0, 10), month: monthOf(p.receivedAt), kind: 'income' as const, category: 'rent', amount: p.amount, propertyId: leases.get(p.leaseId)?.propertyId, memo: 'Rent received' })),
    ...s.list('expenses', (e) => e.ownerId === owner.id).map((e) => ({ id: e.id, date: e.date, month: e.date.slice(0, 7), kind: 'expense' as const, category: e.category, amount: e.amount, propertyId: e.propertyId, memo: e.memo })),
  ].sort((a, b) => b.date.localeCompare(a.date));
  const now = monthOf(svc.clock.now().toISOString());
  const list: string[] = [];
  for (let i = months - 1; i >= 0; i--) { const [y, m] = now.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 - i, 1)); list.push(d.toISOString().slice(0, 7)); }
  const sum = (month: string, kind: 'income' | 'expense') => entries.filter((e) => e.month === month && e.kind === kind).reduce((t, e) => t + e.amount, 0);
  return {
    months: list.map((m) => ({ month: m, income: sum(m, 'income'), expenses: sum(m, 'expense') })),
    entries: entries.slice(0, 100).map((e) => ({ ...e, address: e.propertyId ? props.get(e.propertyId)?.address ?? '' : '' })),
    categories: EXPENSE_CATEGORIES,
  };
}
export const EXPENSE_CATEGORIES: Expense['category'][] = ['repairs', 'cleaning', 'utilities', 'insurance', 'hoa', 'taxes', 'software', 'other'];

/* ---------------- documents ---------------- */

function docFields(svc: Services, owner: Owner, tenant: Tenant | undefined, prop: Property): DocFields {
  const s = svc.store;
  const lease = tenant ? s.find('leases', (l) => l.status === 'active' && l.tenantIds.includes(tenant.id)) : undefined;
  const rules = s.get('rules', owner.id);
  const usd = (c: number | undefined) => (c === undefined ? undefined : `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: c % 100 ? 2 : 0 })}`);
  const nice = (d: string | undefined) => (d ? new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : undefined);
  const rent = lease?.rent ?? prop.rent;
  const co = prop.state === 'CO';
  const fee = rules?.lateFee ?? (co ? Math.max(CO.lateFee.flatCapCents, Math.round(rent * CO.lateFee.percentCap)) : undefined);
  const ord = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`;
  return {
    landlord: owner.name, tenants: tenant?.name, address: `${prop.address}, ${prop.city}`, start: nice(lease?.startDate), end: nice(lease?.endDate),
    rent: usd(rent), dueDay: rules ? ord(rules.rentDueDay) : undefined, payMethod: rules?.howToPay, lateAfter: rules ? `${rules.graceDays} days` : undefined,
    lateFee: usd(fee), deposit: usd(lease?.deposit ?? prop.deposit), pets: rules?.petPolicy, landlordEmail: owner.email, amountDue: usd(rent),
    forwarding: tenant?.forwardingAddress,
  };
}

/* ---------------- routes ---------------- */

export function registerMoreRoutes(kit: Kit) {
  const r = (method: string, path: string, fn: (req: Req, res: ServerResponse, svc: Services, ownerId: string) => void) =>
    kit.route(method, path, async (req, res, svc) => {
      try {
        fn(req, res, svc, req.params.ownerId);
        if (req.method !== 'GET') svc.store.flush();
      } catch (e) {
        if (e instanceof Invalid) return kit.json(res, e.status, e.field ? { error: e.message, field: e.field } : { error: e.message });
        throw e;
      }
    }, true);
  const ownerOf = (svc: Services, id: string) => svc.store.get('owners', id) ?? notFound();

  r('GET', '/api/leasing', (_req, res, svc, ownerId) => kit.json(res, 200, leasingView(svc, ownerId)));

  r('GET', '/api/calendar', (req, res, svc, ownerId) => {
    const month = req.query.get('month') ?? svc.clock.now().toISOString().slice(0, 7);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) fail('month should look like 2026-11.', 'month');
    kit.json(res, 200, calendarView(svc, ownerOf(svc, ownerId), month));
  });

  r('GET', '/api/books', (_req, res, svc, ownerId) => kit.json(res, 200, booksView(svc, ownerOf(svc, ownerId))));

  r('POST', '/api/expenses', (req, res, svc, ownerId) => {
    const b = body(req.body);
    const propertyId = String(b.propertyId ?? '');
    const prop = svc.store.get('properties', propertyId);
    if (!prop || prop.ownerId !== ownerId) fail('Pick one of your homes.', 'propertyId');
    const e = svc.store.insert('expenses', {
      ownerId, propertyId,
      category: oneOf(b.category, EXPENSE_CATEGORIES, { field: 'category', label: 'a category', required: true })!,
      amount: dollars(b.amount, { field: 'amount', label: 'the amount', required: true, min: 0.01, max: 1_000_000 })!,
      date: ymd(b.date, { field: 'date', label: 'the date' }) ?? svc.clock.now().toISOString().slice(0, 10),
      memo: text(b.memo, { field: 'memo', label: 'what it was for', max: 200, required: true })!,
    });
    svc.engine.audit({ ownerId, actor: 'owner', action: 'books.expense', detail: `Expense added: ${e.memo} ($${(e.amount / 100).toFixed(2)}).` });
    kit.json(res, 201, { expense: e });
  });

  r('GET', '/api/documents', (_req, res, svc, ownerId) => {
    const owner = ownerOf(svc, ownerId);
    const props = svc.store.list('properties', (p) => p.ownerId === ownerId);
    const ent = entitlementsOf(owner);
    kit.json(res, 200, {
      docs: DOCS.map((d) => ({ id: d.id, title: d.title, group: d.group, summary: d.summary, included: allows(owner, d.feature), plan: MIN_PLAN[d.feature], planName: PLAN_NAMES[MIN_PLAN[d.feature]] })),
      homes: props.map((p) => ({ id: p.id, address: p.address, city: p.city, state: p.state, stateName: stateRules(p.state)?.name ?? p.state })),
      tenants: mine(svc.store.list('tenants', (t) => t.status !== 'former'), ownerId).map((t) => ({ id: t.id, name: t.name, propertyId: t.propertyId })),
      plan: ent.plan,
    });
  });

  /** The document filled in for one tenant or home, or why it's locked. Unknown ids and other owners' records are 404s. */
  const filled = (svc: Services, ownerId: string, req: Req) => {
    const owner = ownerOf(svc, ownerId);
    const docId = req.params.doc;
    if (!isDocId(docId)) notFound();
    const meta = DOCS.find((d) => d.id === docId)!;
    if (!allows(owner, meta.feature)) {
      const plan = MIN_PLAN[meta.feature];
      return { locked: { error: `${meta.title} is part of ${PLAN_NAMES[plan]}.`, plan, planName: PLAN_NAMES[plan] } } as const;
    }
    const tenantId = req.query.get('tenantId');
    const tenant = tenantId ? svc.store.get('tenants', tenantId) : undefined;
    if (tenantId && (!tenant || tenant.ownerId !== ownerId)) notFound();
    const prop = svc.store.get('properties', tenant?.propertyId ?? req.query.get('propertyId') ?? '');
    if (!prop || prop.ownerId !== ownerId) fail('Pick one of your homes or tenants.', 'propertyId');
    const st = stateRules(prop!.state);
    if (!st) fail(`We don't have documents for ${prop!.state} yet.`, 'propertyId');
    return { id: meta.id, title: meta.title, state: st!.name, html: renderDoc(meta.id, st!, docFields(svc, owner, tenant, prop!)) };
  };

  r('GET', '/api/documents/:doc', (req, res, svc, ownerId) => {
    const d = filled(svc, ownerId, req);
    if (d.locked) return kit.json(res, 403, d.locked);
    kit.json(res, 200, d);
  });

  // The same document as its own page: the app shows it in a frame, and it prints or saves as a PDF.
  kit.route('GET', '/api/documents/:doc/page', async (req, res, svc) => {
    let status = 200;
    let page: string;
    try {
      const d = filled(svc, req.params.ownerId, req);
      if (d.locked) { status = 403; page = docPage('Not in your plan', { message: d.locked.error }); }
      else page = docPage(`${d.title} (${d.state})`, { doc: d.html });
    } catch (e) {
      if (!(e instanceof Invalid)) throw e;
      status = e.status;
      page = docPage("This document didn't open", { message: e.message });
    }
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': DOC_CSP, 'x-frame-options': 'SAMEORIGIN' });
    res.end(page);
  }, true);
}
