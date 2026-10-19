// Owner API helpers: input checks (plain-words errors), the setup checklist, default
// rules, what the app needs to answer each kind of decision, and message threads.
// Money: requests are in dollars, stored records (and responses) are in cents.

import type { Services } from '../services.ts';
import type { Store } from '../store/store.ts';
import type { Approval, Message, Owner, OwnerRules, ScreeningCriterion } from '../domain/types.ts';
import { checkAdCopy } from '../ai/guardrails.ts';
import { optionLabel } from '../workflows/owner.ts';
import { addressKey, identify, normalizePhone, optedOut } from '../workflows/lib.ts';
import { addDays } from '../engine/clock.ts';
import { CO } from '../config/colorado.ts';

/* ======================= input checks ======================= */

/** A bad request with a plain message (400), or 404/409 when status says so. */
export class Invalid extends Error {
  status: number;
  field?: string;
  constructor(message: string, field?: string, status = 400) {
    super(message);
    this.status = status;
    this.field = field;
  }
}
export const fail = (message: string, field?: string, status = 400): never => { throw new Invalid(message, field, status); };
export const notFound = (): never => fail('Not found.', undefined, 404);
export const conflict = (message: string, field?: string): never => fail(message, field, 409);

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const usd = (d: number) => '$' + d.toLocaleString('en-US', { maximumFractionDigits: 2 });
const isBlank = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && !v.trim());
export const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

interface Opt { field: string; label: string; required?: boolean }

/** The JSON body as an object (or a 400). */
export function body(v: unknown): Record<string, unknown> {
  if (v === undefined || v === null || (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v as object).length)) return {};
  if (!isObj(v)) fail('Send a JSON object.');
  return v as Record<string, unknown>;
}

export function text(v: unknown, o: Opt & { max: number; multiline?: boolean }): string | undefined {
  if (isBlank(v)) { if (o.required) fail(`Please enter ${o.label}.`, o.field); return v === undefined ? undefined : ''; }
  if (typeof v !== 'string' && typeof v !== 'number') fail(`${cap(o.label)} should be text.`, o.field);
  let s = String(v).replace(/\r\n?/g, '\n').replace(CONTROL, '');
  s = o.multiline ? s.trim() : s.replace(/\s+/g, ' ').trim();
  if (s.length > o.max) fail(`${cap(o.label)} is too long (${o.max} characters at most).`, o.field);
  return s;
}

/** Dollars in (2750, "2,750.50", "$2750"), cents out. */
export function dollars(v: unknown, o: Opt & { min?: number; max: number }): number | undefined {
  if (isBlank(v)) { if (o.required) fail(`Please enter ${o.label}.`, o.field); return undefined; }
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\s*\$?\s*\d[\d,]*(\.\d{1,2})?\s*$/.test(v) ? Number(v.replace(/[$,\s]/g, '')) : NaN;
  if (!Number.isFinite(n)) fail(`${cap(o.label)} should be a dollar amount, like 2750 or 2,750.50.`, o.field);
  if (n < (o.min ?? 0)) fail(`${cap(o.label)} must be at least ${usd(o.min ?? 0)}.`, o.field);
  if (n > o.max) fail(`${cap(o.label)} can't be more than ${usd(o.max)}.`, o.field);
  return Math.round(n * 100);
}

export function int(v: unknown, o: Opt & { min: number; max: number }): number | undefined {
  if (isBlank(v)) { if (o.required) fail(`Please enter ${o.label}.`, o.field); return undefined; }
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\s*-?\d+\s*$/.test(v) ? Number(v) : NaN;
  if (!Number.isInteger(n)) fail(`${cap(o.label)} should be a whole number.`, o.field);
  if (n < o.min || n > o.max) fail(`${cap(o.label)} should be between ${o.min} and ${o.max}.`, o.field);
  return n;
}

/** Beds and baths: 0 to 20, in half steps. */
export function rooms(v: unknown, o: Opt): number | undefined {
  if (isBlank(v)) { if (o.required) fail(`Please enter ${o.label}.`, o.field); return undefined; }
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 20 || Math.round(n * 2) !== n * 2) fail(`${cap(o.label)} should be a number from 0 to 20 (halves are fine).`, o.field);
  return n;
}

export function bool(v: unknown, o: Opt): boolean | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (v === true || v === false) return v;
  const s = String(v).trim().toLowerCase();
  if (['true', 'yes', 'on', '1'].includes(s)) return true;
  if (['false', 'no', 'off', '0'].includes(s)) return false;
  return fail(`${cap(o.label)} should be true or false.`, o.field);
}

export function oneOf<T extends string>(v: unknown, list: readonly T[], o: Opt): T | undefined {
  if (isBlank(v)) { if (o.required) fail(`Please choose ${o.label}.`, o.field); return undefined; }
  const s = String(v).trim();
  if (!list.includes(s as T)) fail(`${cap(o.label)} should be one of: ${list.join(', ')}.`, o.field);
  return s as T;
}

export function email(v: unknown, o: Opt): string | undefined {
  if (isBlank(v)) { if (o.required) fail(`Please enter ${o.label}.`, o.field); return v === undefined ? undefined : ''; }
  const s = String(v).trim().toLowerCase();
  if (s.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)) fail(`Please enter a valid email for ${o.label}.`, o.field);
  return s;
}

export function phone(v: unknown, o: Opt): string | undefined {
  if (isBlank(v)) { if (o.required) fail(`Please enter ${o.label}.`, o.field); return v === undefined ? undefined : ''; }
  const p = normalizePhone(String(v));
  if (!/^\+\d{10,15}$/.test(p)) fail(`Please enter ${o.label} as a mobile number, like 720-555-0123.`, o.field);
  return p;
}

export function ymd(v: unknown, o: Opt): string | undefined {
  if (isBlank(v)) { if (o.required) fail(`Please enter ${o.label}.`, o.field); return undefined; }
  const s = String(v).trim();
  const d = new Date(s + 'T12:00:00Z');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) fail(`${cap(o.label)} should be a date like 2026-11-01.`, o.field);
  return s;
}

export function hhmm(v: unknown, o: Opt): string | undefined {
  if (isBlank(v)) { if (o.required) fail(`Please enter ${o.label}.`, o.field); return undefined; }
  const s = String(v).trim();
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s)) fail(`${cap(o.label)} should be a time like 09:00 or 19:30.`, o.field);
  return s;
}

/** Words the AI may quote to the public must pass the same fair-housing list as listing ads. */
export function fairHousing(s: string | undefined, o: Opt): string | undefined {
  if (!s) return s;
  const r = checkAdCopy(s);
  if (!r.ok) {
    const src = r.problems[0].replace(/^[^:]*:\s*/, '');
    let found = '';
    try { found = new RegExp(src, 'i').exec(s)?.[0] ?? ''; } catch { /* keep generic */ }
    fail(`${cap(o.label)} can't say${found ? ` "${found}"` : ' that'}: it could break fair housing rules. Please reword it.`, o.field);
  }
  return s;
}

/** A small map of plain facts (parking, trash day...). */
export function facts(v: unknown, o: Opt): Record<string, string> | undefined {
  if (v === undefined) return undefined;
  if (v === null) return {};
  if (!isObj(v)) fail(`${cap(o.label)} should be a list of names and values.`, o.field);
  const out: Record<string, string> = {};
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length > 30) fail(`${cap(o.label)}: 30 at most.`, o.field);
  for (const [k, val] of entries) {
    const key = text(k, { field: o.field, label: 'a fact name', max: 60, required: true })!;
    const value = text(val, { field: o.field, label: `"${key}"`, max: 300 });
    if (value) out[key] = fairHousing(value, { field: o.field, label: `"${key}"` })!;
  }
  return out;
}

/** Https links to photos. */
export function links(v: unknown, o: Opt & { max: number }): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) fail(`${cap(o.label)} should be a list of links.`, o.field);
  const list = v as unknown[];
  if (list.length > o.max) fail(`${cap(o.label)}: ${o.max} at most.`, o.field);
  return list.map((x) => {
    const s = String(x ?? '').trim();
    let ok = false;
    try { ok = new URL(s).protocol === 'https:' && s.length <= 1000; } catch { ok = false; }
    if (!ok) fail(`${cap(o.label)} should be https links.`, o.field);
    return s;
  });
}

/* ======================= trades ======================= */

export const TRADES = ['general', 'plumbing', 'electrical', 'hvac', 'appliance', 'windows', 'locks', 'pest', 'roofing', 'exterior_cleaning', 'landscaping', 'cleaning', 'painting', 'flooring'] as const;

export function trades(v: unknown, o: Opt): string[] | undefined {
  if (v === undefined) return undefined;
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : fail(`${cap(o.label)} should be a list, like ["plumbing"].`, o.field);
  const out = [...new Set((list as unknown[]).map((t) => String(t ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_')).filter(Boolean))];
  if (!out.length) return ['general'];
  if (out.length > 10) fail(`${cap(o.label)}: 10 at most.`, o.field);
  for (const t of out) if (!/^[a-z][a-z_]{1,29}$/.test(t)) fail(`"${t}" isn't a trade we recognize. Use words like ${TRADES.slice(1, 5).join(', ')}.`, o.field);
  return out;
}

/* ======================= rules ======================= */

/** Conservative starting rules for a new owner: every repair over $150 asks first, no late fee, owner-led showings. */
export function defaultRules(ownerId: string): OwnerRules {
  return {
    id: ownerId, ownerId, repairSpendLimit: 15_000, emergencySpendLimit: 50_000, rentDueDay: 1, graceDays: 5, lateFee: 0, howToPay: '',
    autoLateNotice: true, petPolicy: '', screeningCriteria: [], showingMode: 'owner', showingHours: { start: '09:00', end: '19:00' },
    renewalLeadDays: 120, quietHours: { start: '21:00', end: '08:00' }, alwaysRouteToOwner: [], facts: {},
  };
}

/** Workflows read the owner's rules; make sure a new owner has some before tenants start texting. */
export function ensureRules(svc: Services, ownerId: string): OwnerRules {
  const cur = svc.store.get('rules', ownerId);
  if (cur) return cur;
  svc.store.kvSet('rulesDefaulted', ownerId, svc.clock.now().toISOString());
  return svc.store.insert('rules', defaultRules(ownerId));
}

export const rulesSaved = (store: Store, ownerId: string) => !!store.get('rules', ownerId) && (!!store.kvGet('rulesSaved', ownerId) || !store.kvGet('rulesDefaulted', ownerId));

const CRITERIA: ScreeningCriterion['key'][] = ['income_multiple', 'evictions_years', 'collections_years', 'references', 'pets', 'custom'];

/** Checks a full or partial rules update. Returns only the fields that were sent. */
export function rulesPatch(b: Record<string, unknown>): Partial<OwnerRules> {
  const p: Partial<OwnerRules> = {};
  const has = (k: string) => k in b;
  if (has('repairSpendLimit')) p.repairSpendLimit = dollars(b.repairSpendLimit, { field: 'repairSpendLimit', label: 'the repair spending limit', max: 100_000, required: true });
  if (has('emergencySpendLimit')) p.emergencySpendLimit = dollars(b.emergencySpendLimit, { field: 'emergencySpendLimit', label: 'the emergency spending limit', max: 100_000, required: true });
  if (has('rentDueDay')) p.rentDueDay = int(b.rentDueDay, { field: 'rentDueDay', label: 'the rent due day', min: 1, max: 28, required: true });
  if (has('graceDays')) p.graceDays = int(b.graceDays, { field: 'graceDays', label: 'grace days', min: 0, max: 30, required: true });
  if (has('lateFee')) p.lateFee = dollars(b.lateFee, { field: 'lateFee', label: 'the late fee', max: 10_000, required: true });
  if (has('howToPay')) p.howToPay = fairHousing(text(b.howToPay, { field: 'howToPay', label: 'how tenants pay you', max: 300 }) ?? '', { field: 'howToPay', label: 'How tenants pay you' });
  if (has('autoLateNotice')) p.autoLateNotice = bool(b.autoLateNotice, { field: 'autoLateNotice', label: 'late notices' }) ?? true;
  if (has('petPolicy')) p.petPolicy = fairHousing(text(b.petPolicy, { field: 'petPolicy', label: 'the pet policy', max: 500, multiline: true }) ?? '', { field: 'petPolicy', label: 'The pet policy' });
  if (has('showingMode')) p.showingMode = oneOf(b.showingMode, ['self', 'owner', 'both'] as const, { field: 'showingMode', label: 'showings', required: true });
  // Colorado generally needs 90 days' notice to not renew (HB24-1098), so renewals start at least that early.
  if (has('renewalLeadDays')) p.renewalLeadDays = int(b.renewalLeadDays, { field: 'renewalLeadDays', label: 'renewal lead days', min: CO.nonRenewalNoticeDays, max: 365, required: true });
  for (const k of ['showingHours', 'quietHours'] as const) {
    if (!has(k)) continue;
    const v = b[k];
    if (!isObj(v)) fail(`${k === 'showingHours' ? 'Showing hours' : 'Quiet hours'} should have a start and an end, like {"start":"09:00","end":"19:00"}.`, k);
    const o = v as Record<string, unknown>;
    const start = hhmm(o.start, { field: k, label: 'the start time', required: true })!, end = hhmm(o.end, { field: k, label: 'the end time', required: true })!;
    if (start === end) fail('The start and end times must be different.', k);
    if (k === 'showingHours' && start > end) fail('Showing hours must start before they end.', k);
    p[k] = { start, end };
  }
  if (has('alwaysRouteToOwner')) {
    const v = b.alwaysRouteToOwner;
    const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : v == null ? [] : fail('Topics to handle yourself should be a list of words.', 'alwaysRouteToOwner');
    if ((list as unknown[]).length > 20) fail('Topics to handle yourself: 20 at most.', 'alwaysRouteToOwner');
    p.alwaysRouteToOwner = (list as unknown[]).map((x) => text(x, { field: 'alwaysRouteToOwner', label: 'a topic', max: 40 }) ?? '').filter(Boolean);
  }
  if (has('facts')) p.facts = facts(b.facts, { field: 'facts', label: 'facts' }) ?? {};
  if (has('screeningCriteria')) {
    const v = b.screeningCriteria;
    if (!Array.isArray(v)) fail('Screening criteria should be a list.', 'screeningCriteria');
    if ((v as unknown[]).length > 10) fail('Screening criteria: 10 at most.', 'screeningCriteria');
    p.screeningCriteria = (v as unknown[]).map((c) => {
      if (!isObj(c)) return fail('Each screening criterion needs a key, a label and a value.', 'screeningCriteria');
      const key = oneOf(c.key, CRITERIA, { field: 'screeningCriteria', label: 'the criterion type', required: true })!;
      const label = fairHousing(text(c.label, { field: 'screeningCriteria', label: 'the criterion', max: 120, required: true }), { field: 'screeningCriteria', label: 'The criterion' })!;
      let value: number | string;
      if (key === 'income_multiple') value = Number(String(c.value ?? '').replace(/x$/i, ''));
      else if (key === 'evictions_years' || key === 'collections_years' || key === 'references') value = int(c.value, { field: 'screeningCriteria', label: `the value for "${label}"`, min: 0, max: 10, required: true })!;
      else value = fairHousing(text(c.value, { field: 'screeningCriteria', label: `the value for "${label}"`, max: 120, required: true }), { field: 'screeningCriteria', label: `The value for "${label}"` })!;
      if (key === 'income_multiple' && !(Number.isFinite(value) && (value as number) >= 1 && (value as number) <= 5)) fail('Income multiple should be between 1 and 5 (like 3 for "3x rent").', 'screeningCriteria');
      return { key, label, value };
    });
  }
  return p;
}

/* ======================= setup checklist ======================= */

export const SETUP_STEPS = [
  { key: 'homes', title: 'Add your homes' },
  { key: 'lease', title: 'Upload your lease' },
  { key: 'tenants', title: 'Add your tenants' },
  { key: 'vendors', title: 'Add your vendors' },
  { key: 'rules', title: 'Set your rules (spending limit, pets, screening criteria)' },
  { key: 'howToPay', title: 'Tell us how tenants pay you (Zelle, check, your bank portal) so reminders say the right thing' },
] as const;
export type StepKey = (typeof SETUP_STEPS)[number]['key'];

/** Which checklist step an onboarding "Setup step" task is (by its words, so small wording changes still match). */
export function stepOfTask(title: string): StepKey | undefined {
  if (/\bpay\b/i.test(title)) return 'howToPay';
  if (/\brules?\b/i.test(title)) return 'rules';
  if (/\blease\b/i.test(title)) return 'lease';
  if (/\bvendors?\b/i.test(title)) return 'vendors';
  if (/\btenants?\b/i.test(title)) return 'tenants';
  if (/\bhomes?\b|\bpropert/i.test(title)) return 'homes';
  return undefined;
}

export function setupDone(store: Store, ownerId: string): Record<StepKey, boolean> {
  const mine = (t: 'properties' | 'leaseTemplates' | 'tenants' | 'vendors') => store.list(t, (r: { ownerId: string }) => r.ownerId === ownerId);
  return {
    homes: mine('properties').length > 0,
    lease: mine('leaseTemplates').length > 0,
    tenants: store.list('tenants', (t) => t.ownerId === ownerId && t.status !== 'former').length > 0,
    vendors: mine('vendors').length > 0,
    rules: rulesSaved(store, ownerId),
    howToPay: !!store.get('rules', ownerId)?.howToPay?.trim(),
  };
}

export function checklist(store: Store, ownerId: string) {
  const done = setupDone(store, ownerId);
  const steps = SETUP_STEPS.map((s) => ({ key: s.key, title: s.title, done: done[s.key] }));
  return { steps, done: steps.filter((s) => s.done).length, total: steps.length, complete: steps.every((s) => s.done) };
}

/** Close onboarding "Setup step" to-dos whose data now exists. Returns how many closed. */
export function syncSetupTasks(svc: Services, ownerId: string): number {
  const open = svc.store.list('tasks', (t) => t.ownerId === ownerId && t.status === 'open' && t.detail === 'Setup step');
  if (!open.length) return 0;
  const done = setupDone(svc.store, ownerId);
  let n = 0;
  for (const t of open) {
    const k = stepOfTask(t.title);
    if (!k || !done[k]) continue;
    svc.store.update('tasks', t.id, { status: 'done' });
    svc.engine.audit({ ownerId, actor: 'owner', action: 'onboarding.step_done', detail: `Setup step done: ${t.title}` });
    n++;
  }
  return n;
}

/* ======================= plans ======================= */

const PLAN_NAMES: Record<string, string> = { essentials: 'Essentials', autopilot: 'Autopilot', pro: 'Autopilot Pro', plus: 'Autopilot Pro' };
/** 'plus' is the old id for Autopilot Pro. */
export const planId = (p: unknown) => (String(p ?? '') === 'plus' ? 'pro' : String(p ?? '')) || null;
export const planName = (p: unknown) => PLAN_NAMES[String(p ?? '')] ?? null;

/** The Calendly link for the onboarding call: name and email filled in, the account id for matching the booking. */
export function calendlyUrlFor(owner: Pick<Owner, 'id' | 'name' | 'email'>): string | null {
  const cal = process.env.CALENDLY_URL;
  if (!cal) return null;
  try {
    const u = new URL(cal);
    u.searchParams.set('name', owner.name);
    u.searchParams.set('email', owner.email);
    u.searchParams.set('utm_source', 'keyhelm');
    u.searchParams.set('utm_campaign', 'onboarding');
    u.searchParams.set('utm_content', owner.id); // comes back in the Calendly webhook, so the booking lands on the right account
    return u.toString();
  } catch {
    return null;
  }
}

/* ======================= decisions ======================= */

export interface Field {
  name: string;
  label: string;
  type: 'dollars' | 'months' | 'text' | 'date' | 'deductions';
  /** The choice this field belongs to (show it when that choice is picked). */
  forOption: string;
  /** 'data' (default): goes in data[name], or data[group][name]. 'note': goes in the top-level note. */
  in?: 'data' | 'note';
  group?: string;
  required: boolean;
  value?: unknown;
  min?: number;
  max?: number;
  readOnly?: boolean;
  help?: string;
}

const toDollars = (c: unknown) => (typeof c === 'number' ? c / 100 : undefined);
const humanize = (f: string) => cap(f.replace(/_/g, ' ').replace(/^blank (\d+)$/, 'blank $1'));

/** Renewal rent can't go up again within 12 months of the last increase (Colorado HB21-1121). Same test as the renewal workflow. */
function renewalLease(svc: Services, a: Approval) {
  const leaseId = svc.engine.getRun(a.runId)?.input?.leaseId as string | undefined;
  const lease = leaseId ? svc.store.get('leases', leaseId) : undefined;
  if (!lease) return undefined;
  const locked = !!lease.lastRentIncreaseAt && Date.parse(lease.lastRentIncreaseAt) > Date.parse(addDays(lease.endDate, 1)) - 365 * 86_400_000;
  return { lease, locked };
}

/** What the app shows to answer a decision, beyond the choice itself. */
export function approvalFields(svc: Services, a: Approval): Field[] {
  const d = a.data ?? {};
  switch (a.kind) {
    case 'renewal_terms': {
      const r = renewalLease(svc, a);
      return [
        { name: 'rent', label: 'Monthly rent', type: 'dollars', forOption: 'offer_renewal', required: false, value: toDollars(d.rent), min: 1, max: 100_000, readOnly: r?.locked || undefined, help: r?.locked ? 'Colorado allows one rent increase per 12 months, so the rent stays the same this time.' : 'Change it to set a new rent for the renewal.' },
        { name: 'months', label: 'Lease length in months', type: 'months', forOption: 'offer_renewal', required: false, value: d.months ?? 12, min: 1, max: 36 },
      ];
    }
    case 'deposit': case 'deposit-final': case 'deposit-list':
      return [{ name: 'deductions', label: 'Deductions', type: 'deductions', forOption: 'deductions_entered', required: true, value: ((d.deductions as { reason: string; amount: number }[] | undefined) ?? []).map((x) => ({ reason: x.reason, amount: x.amount / 100 })), help: 'List each one with its amount. Only damage beyond normal wear and tear, unpaid rent or unpaid utilities can be deducted.' }];
    case 'lease_fields':
      return ((d.missing as string[] | undefined) ?? []).map((f) => ({ name: f, group: 'values', label: humanize(f), type: 'text' as const, forOption: 'send', required: false, value: (d.values as Record<string, string> | undefined)?.[f] ?? '' }));
    case 'showing_request':
      return [{ name: 'note', in: 'note', label: 'When you will meet them (like Sat 10am)', type: 'text', forOption: 'confirm', required: true }];
    case 'rent_check':
      return [{ name: 'amount', label: 'Amount that arrived, if only part did', type: 'dollars', forOption: 'received', required: false, min: 0.01, max: 100_000, help: 'Leave blank if all of it arrived.' }];
    case 'application':
      return [
        { name: 'startDate', label: 'Lease start date', type: 'date', forOption: 'approve', required: false, help: 'Leave blank for 2 weeks from today.' },
        { name: 'months', label: 'Lease length in months', type: 'months', forOption: 'approve', required: false, value: 12, min: 1, max: 36 },
      ];
    default:
      return [];
  }
}

export function approvalView(svc: Services, a: Approval) {
  return { ...a, choices: a.options.map((o) => ({ value: o, label: optionLabel(o) })), decisionLabel: a.decision ? optionLabel(a.decision) : null, fields: a.status === 'pending' ? approvalFields(svc, a) : [] };
}

/** Checks a decision from the app. Only known, checked data reaches the workflow. */
export function checkDecision(svc: Services, a: Approval, b: Record<string, unknown>): { decision: string; note?: string; data?: Record<string, unknown> } {
  const decision = String(b.decision ?? '').trim();
  if (!a.options.includes(decision)) fail(`Pick one of: ${a.options.map((o) => `${o} (${optionLabel(o)})`).join(', ')}.`, 'decision');
  const note = text(b.note, { field: 'note', label: 'the note', max: 500, multiline: true }) || undefined;
  if (b.data !== undefined && b.data !== null && !isObj(b.data)) fail('data should be an object.', 'data');
  const d = (b.data ?? {}) as Record<string, unknown>;
  const today = svc.clock.now().toISOString().slice(0, 10);

  switch (`${a.kind}:${decision}`) {
    case 'renewal_terms:offer_renewal': {
      const out: Record<string, unknown> = {};
      const rent = dollars(d.rent, { field: 'rent', label: 'the renewal rent', min: 1, max: 100_000 });
      const months = int(d.months, { field: 'months', label: 'the lease length', min: 1, max: 36 });
      if (rent !== undefined) {
        const r = renewalLease(svc, a);
        if (r?.locked && rent !== r.lease.rent) fail('Colorado allows one rent increase per 12 months, so the renewal rent has to stay the same this time.', 'rent');
        out.rent = rent;
      }
      if (months !== undefined) out.months = months;
      return { decision, note, data: Object.keys(out).length ? out : undefined };
    }
    case 'deposit:deductions_entered': case 'deposit-final:deductions_entered': case 'deposit-list:deductions_entered': {
      const list = d.deductions;
      if (!Array.isArray(list) || !list.length) fail('List at least one deduction with its amount, or choose to return the full deposit.', 'deductions');
      if ((list as unknown[]).length > 30) fail('Deductions: 30 at most.', 'deductions');
      const deductions = (list as unknown[]).map((x) => {
        if (!isObj(x)) return fail('Each deduction needs a reason and an amount.', 'deductions');
        return {
          reason: text(x.reason, { field: 'deductions', label: 'the reason for each deduction', max: 120, required: true })!,
          amount: dollars(x.amount, { field: 'deductions', label: 'each deduction', min: 0.01, max: 100_000, required: true })!,
        };
      });
      return { decision, note, data: { deductions } };
    }
    case 'deposit:return_full': case 'deposit-final:return_full': case 'deposit-list:return_full':
      return { decision, note, data: { deductions: [] } };
    case 'lease_fields:send': {
      const missing = (a.data.missing as string[] | undefined) ?? [];
      const raw = d.values ?? {};
      if (!isObj(raw)) fail('values should be an object of blank names and what goes in them.', 'values');
      const values: Record<string, string> = { ...((a.data.values as Record<string, string> | undefined) ?? {}) };
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (!missing.includes(k)) fail(`"${k}" isn't one of the blanks in this lease.`, 'values');
        const s = text(v, { field: 'values', label: humanize(k), max: 300 });
        if (s) values[k] = s;
      }
      return { decision, note, data: { values } };
    }
    case 'showing_request:confirm': {
      if (!note) fail('Add when you will meet them, like Sat 10am.', 'note');
      if (!/\d|\b(today|tomorrow|tonight|morning|afternoon|evening|noon|mon|tue|wed|thu|fri|sat|sun)/i.test(note!)) fail('Add a day and time for the showing, like Sat 10am.', 'note');
      if (note!.length > 120) fail('Keep the showing time short (120 characters at most).', 'note');
      return { decision, note };
    }
    case 'rent_check:received': {
      const amount = dollars(d.amount, { field: 'amount', label: 'the amount that arrived', min: 0.01, max: 100_000 });
      return { decision, note, data: amount !== undefined ? { amount } : undefined };
    }
    case 'application:approve': {
      const out: Record<string, unknown> = {};
      const start = ymd(d.startDate, { field: 'startDate', label: 'the lease start date' });
      if (start !== undefined) {
        if (start < today) fail("The lease start date can't be in the past.", 'startDate');
        if (start > addDays(today, 365)) fail('The lease start date should be within a year.', 'startDate');
        out.startDate = start;
      }
      const months = int(d.months, { field: 'months', label: 'the lease length', min: 1, max: 36 });
      if (months !== undefined) out.months = months;
      return { decision, note, data: Object.keys(out).length ? out : undefined };
    }
    default:
      return { decision, note }; // nothing else takes extra data
  }
}

/* ======================= messages ======================= */

export interface Contact { role: 'tenant' | 'vendor' | 'prospect' | 'applicant' | 'owner' | 'unknown'; id?: string; name: string; propertyId?: string; propertyAddress?: string; email?: string; phone?: string }

/** Who this phone number or email is, for this owner only (never another owner's people). */
export function contactFor(store: Store, ownerId: string, key: string): Contact {
  const p = identify(store, key, ownerId);
  const addr = (id?: string) => (id ? store.get('properties', id)?.address : undefined);
  if (p.role === 'owner') return p.owner.id === ownerId ? { role: 'owner', id: ownerId, name: 'You' } : { role: 'unknown', name: key };
  if (p.role === 'tenant' && p.ownerId === ownerId) return { role: 'tenant', id: p.tenant.id, name: p.tenant.name, propertyId: p.tenant.propertyId, propertyAddress: addr(p.tenant.propertyId), phone: p.tenant.phone, email: p.tenant.email };
  if (p.role === 'vendor' && p.ownerId === ownerId) return { role: 'vendor', id: p.vendor.id, name: p.vendor.name, phone: p.vendor.phone, email: p.vendor.email };
  if (p.role === 'prospect' && p.ownerId === ownerId) return { role: 'prospect', id: p.prospect.id, name: p.prospect.name || 'Prospect', propertyId: p.prospect.interestedIn, propertyAddress: addr(p.prospect.interestedIn), phone: p.prospect.phone, email: p.prospect.email };
  const k = addressKey(key);
  const app = store.find('applications', (x) => x.ownerId === ownerId && ((!!x.phone && addressKey(x.phone) === k) || (!!x.email && x.email.toLowerCase() === k)));
  if (app) return { role: 'applicant', id: app.id, name: app.applicantName, propertyId: app.propertyId, propertyAddress: addr(app.propertyId), phone: app.phone, email: app.email };
  return { role: 'unknown', name: key };
}

const sentBy = (m: { direction: string; meta?: Record<string, unknown> }) => (m.direction === 'in' ? 'contact' : m.meta?.sentBy === 'owner' ? 'owner' : 'keyhelm');

export function threads(store: Store, ownerId: string, o: { includeOwner?: boolean } = {}) {
  const by = new Map<string, Message[]>();
  for (const m of store.list('messages', (x) => x.ownerId === ownerId)) {
    const list = by.get(m.threadKey) ?? [];
    list.push(m);
    by.set(m.threadKey, list);
  }
  const out = [];
  for (const [key, list] of by) {
    const msgs = list.sort((a, b) => a.at.localeCompare(b.at));
    const contact = contactFor(store, ownerId, key);
    if (contact.role === 'owner' && !o.includeOwner) continue;
    const last = msgs[msgs.length - 1];
    out.push({
      key, contact, channel: last.channel, count: msgs.length,
      last: { body: last.body, at: last.at, direction: last.direction, sentBy: sentBy(last) },
      needsReply: last.direction === 'in',
      textsOff: optedOut(store, key, 'sms'),
    });
  }
  return out.sort((a, b) => b.last.at.localeCompare(a.last.at));
}

export function threadMessages(store: Store, ownerId: string, key: string) {
  return store.list('messages', (m) => m.ownerId === ownerId && m.threadKey === key).sort((a, b) => a.at.localeCompare(b.at))
    .map((m) => ({ id: m.id, direction: m.direction, channel: m.channel, body: m.body, media: m.media, at: m.at, from: m.from ?? null, to: m.to ?? null, sentBy: sentBy(m) }));
}
