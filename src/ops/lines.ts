// ONE TEXTING NUMBER FOR EVERYONE (shared-number mode).
//
// KeyHelm launches with one Twilio number, TWILIO_FROM, shared by every owner. An owner can also
// get a dedicated number later (bought by hand in Twilio, then set with
// POST /api/admin/owners/:id/line; see docs/notes/ops.md).
//
//   Message to an owner's own number (owner.lineNumber that isn't TWILIO_FROM) → that owner.
//   Message to the shared number (or to any number no owner has):
//     - only one active owner is on it (active = not canceled, has a home) → that owner;
//     - otherwise no owner is picked at the door, and the front desk works it out:
//       known tenants, vendors and prospects by who sent it (src/workflows/lib.ts identify());
//       new people by the home they name (street name, plus the house number when given) across
//       every sharing owner's homes, listed or vacant homes first; if still unclear, one reply
//       asking which home address (no owner names), and an admin alert if they still can't be matched.

import type { Channel, Owner, Property } from '../domain/types.ts';
import type { Store } from '../store/store.ts';
import type { C } from '../workflows/lib.ts';
import { addressKey, normalizePhone, propertyName, quote } from '../workflows/lib.ts';
import { precheck, type PreCheck } from '../ai/guardrails.ts';
import { DAY } from '../engine/clock.ts';
import { alertAdmin } from './alerts.ts';
import { ops, track, type Env } from './state.ts';

const ASK = 'lineAsk';
const ASK_TTL_MS = 7 * DAY;

const isPhone = (s: string) => /^\+\d{8,15}$/.test(normalizePhone(s));

/** The shared texting number (TWILIO_FROM), when it is a phone number (not a Messaging Service id). */
export function sharedNumber(env: Env = process.env): string | undefined {
  const f = env.TWILIO_FROM?.trim();
  return f && isPhone(f) ? normalizePhone(f) : undefined;
}

/** True when the owner uses the shared number: no number of their own, or theirs is TWILIO_FROM. */
export function onSharedNumber(o: Pick<Owner, 'lineNumber'>, env: Env = process.env): boolean {
  const shared = env.TWILIO_FROM?.trim();
  return !o.lineNumber || !isPhone(o.lineNumber) || (!!shared && addressKey(o.lineNumber) === addressKey(shared));
}

/** An owner who can be messaged about a home: not canceled, with at least one home. */
export function activeOwner(store: Store, o: Owner): boolean {
  return o.billing?.status !== 'canceled' && !!store.find('properties', (p) => p.ownerId === o.id);
}

/**
 * The owners a message to `to` (not an owner's own number) could be for: the active owners on the
 * shared number (owners without their own inbox, for email). If none of them is active, any active
 * owner (an old placeholder line on the demo owner must not hide them); then anyone on the shared
 * number; then everyone.
 */
export function lineCandidates(store: Store, to: string | undefined, env: Env = process.env): Owner[] {
  const owners = store.list('owners');
  const email = !!to && to.includes('@');
  const sharing = !to ? owners : owners.filter((o) => (email ? !o.lineEmail : onSharedNumber(o, env)));
  const active = (list: Owner[]) => list.filter((o) => activeOwner(store, o));
  for (const pool of [active(sharing), active(owners), sharing]) if (pool.length) return pool;
  return owners;
}

/** Which owner a message is for, from the number (or inbox) it was sent to. Undefined: the front desk decides. */
export function ownerForLine(store: Store, to: string | undefined, env: Env = process.env): string | undefined {
  if (to) {
    const k = addressKey(to);
    const own = store.find('owners', (o) => (!onSharedNumber(o, env) && addressKey(o.lineNumber!) === k) || (!!o.lineEmail && o.lineEmail.toLowerCase() === k));
    if (own) return own.id;
  }
  const pool = lineCandidates(store, to, env);
  return pool.length === 1 ? pool[0].id : undefined;
}

/* ---------------- the home a message names ---------------- */

const GENERIC = /^(street|avenue|court|drive|circle|road|lane|place|boulevard|parkway|trail|unit|north|south|east|west|apartment|suite|highway|terrace)$/;
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const streetWords = (address: string) => address.toLowerCase().split(/[\s,.#]+/).filter((w) => w.length >= 4 && !/^\d/.test(w) && !GENERIC.test(w));

/** These owners' homes whose street name is in the message; a matching house number ranks higher. Best matches only. */
export function homesNamed(store: Store, owners: Owner[], body: string, statuses?: readonly Property['status'][]): Property[] {
  const t = body.toLowerCase();
  const ids = new Set(owners.map((o) => o.id));
  let best = 0;
  let out: Property[] = [];
  for (const h of store.list('properties', (p) => ids.has(p.ownerId) && (!statuses || statuses.includes(p.status)))) {
    if (!streetWords(h.address).some((w) => new RegExp(`\\b${escRe(w)}\\b`).test(t))) continue;
    const n = h.address.trim().match(/^\d+/)?.[0];
    const score = n && new RegExp(`(^|\\D)${n}(\\D|$)`).test(t) ? 2 : 1;
    if (score > best) [best, out] = [score, [h]];
    else if (score === best) out.push(h);
  }
  return out;
}

/** The one owner whose home the message names (listed or vacant homes first, then any home). Undefined if none, or if two owners match. */
export function ownerByHome(store: Store, owners: Owner[], body: string): { ownerId: string; propertyId: string } | undefined {
  for (const statuses of [['listed', 'vacant'] as const, undefined]) {
    const homes = homesNamed(store, owners, body, statuses);
    const who = new Set(homes.map((h) => h.ownerId));
    if (who.size === 1) return { ownerId: homes[0].ownerId, propertyId: homes[0].id };
    if (who.size > 1) return undefined;
  }
  return undefined;
}

/* ---------------- the front desk's "no owner yet" branch ---------------- */

/** We asked this sender which home they mean (kv "lineAsk", by phone or email). */
interface LineAsk { key: string; at: string; channel: Channel; body: string; alertedAt?: string }

/** Forget questions older than 7 days (run by the ops check), so the list doesn't grow forever. */
export function pruneLineAsks(store: Store, now: Date): number {
  let n = 0;
  for (const a of store.kvList<LineAsk>(ASK)) {
    if (a.key && now.getTime() - Date.parse(a.at) >= ASK_TTL_MS) {
      store.kvDelete(ASK, a.key);
      n++;
    }
  }
  return n;
}

/**
 * Called by the front desk (src/workflows/inbound-message.ts) for a new sender when the number
 * they wrote to didn't pick an owner. Returns the owner to continue with (and, when they are
 * answering our "which home?" question, their first question joined to the answer, so that is
 * what gets answered), or undefined when the message stays unrouted.
 */
export async function routeUnknownSender(ctx: C, m: { from: string; to?: string; channel: Channel; body: string }, reply: (body: string) => Promise<void>): Promise<{ ownerId: string; body?: string } | undefined> {
  const store = ctx.store;
  const svc = ctx.svc;
  const env = ops(svc).env;
  const key = addressKey(m.from);

  const found = await ctx.step('line-route', () => {
    const pool = lineCandidates(store, m.to, env);
    if (pool.length === 1) return { ownerId: pool[0].id, propertyId: null };
    // The owners on this number first; then any active owner (someone texting the shared number about a home whose owner has their own number).
    const everyone = store.list('owners', (o) => activeOwner(store, o));
    return ownerByHome(store, pool, m.body) ?? (everyone.length > pool.length ? ownerByHome(store, everyone, m.body) : undefined) ?? null;
  });
  if (found) {
    ctx.setOwner(found.ownerId);
    // Their earlier messages (and our question) now belong to this owner's conversation.
    const earlier = await ctx.step('line-claim', () => {
      const now = svc.clock.now().getTime();
      for (const x of store.list('messages', (x) => !x.ownerId && x.threadKey === key && Date.parse(x.at) >= now - ASK_TTL_MS)) store.update('messages', x.id, { ownerId: found.ownerId });
      const ask = store.kvGet<LineAsk>(ASK, key);
      store.kvDelete(ASK, key);
      return ask?.body && found.propertyId && now - Date.parse(ask.at) < ASK_TTL_MS ? ask.body : null;
    });
    if (found.propertyId) await ctx.log('message.routed', `A new contact (${m.from}) wrote to the shared number about ${propertyName(store, found.propertyId)}, so it came to you.`);
    return { ownerId: found.ownerId, body: earlier ? `${earlier}\n${m.body}` : undefined };
  }

  const where = `${m.channel} from ${m.from}${m.to ? ` to ${m.to}` : ''}`;
  // A reply to one of our own alert texts: nothing to route.
  if ((env.ADMIN_ALERT_PHONE && addressKey(env.ADMIN_ALERT_PHONE) === key) || (env.ADMIN_ALERT_EMAIL && env.ADMIN_ALERT_EMAIL.trim().toLowerCase() === key)) {
    await ctx.log('message.unrouted', `Reply from the admin alert contact (${where}); not sent to any owner.`);
    return undefined;
  }
  const pre = precheck(m.body);
  // Ask once (per sender, per 7 days); after that, tell the admin once. Emergencies always reach the admin.
  const plan = await ctx.step('line-plan', () => {
    const now = svc.clock.now().toISOString();
    const asked = store.kvGet<LineAsk>(ASK, key);
    const first = !asked || Date.parse(now) - Date.parse(asked.at) >= ASK_TTL_MS;
    const alert = pre.emergency || (!first && !asked!.alertedAt);
    store.kvSet<LineAsk>(ASK, key, first ? { key, at: now, channel: m.channel, body: m.body.slice(0, 500), alertedAt: alert ? now : undefined } : { ...asked!, alertedAt: alert ? now : asked!.alertedAt });
    return { ask: first, alert };
  });
  if (plan.ask) await reply(askWhichHome(svc.brand.name, m.channel, pre, m.body));
  if (plan.alert) {
    // Sent in the background (once per run), so a slow provider never holds up the reply.
    await ctx.step('line-alert', () => {
      track(svc, alertAdmin(svc, 'unrouted_message', `${pre.emergency ? 'Possible EMERGENCY, no' : 'No'} owner matched: ${m.from}`,
        `${where}: ${quote(m.body, 300)}\n${plan.ask
          ? `I asked which home address it's about${pre.danger ? ' and gave them the 911 safety line' : ''}. Find the owner and call them.`
          : "They were asked which home address it's about and still couldn't be matched. Find the owner and pass it on (adding them as a tenant, vendor or prospect makes their next message route by itself)."}`));
      return true;
    });
  }
  await ctx.log('message.unrouted', `Message (${where}) could not be matched to an owner${plan.ask ? " yet; asked which home it's about" : ''}.`);
  return undefined;
}

/** The one question we ask an unmatched sender. Never names an owner. */
function askWhichHome(brand: string, channel: Channel, pre: PreCheck, body: string): string {
  const safety = /\bgas\b|carbon monoxide/i.test(body)
    ? "Please leave the home right away and, once you're outside, call 911 or the gas company's emergency line. "
    : pre.danger ? 'If anyone is in danger, please call 911 first. '
    : pre.emergency && /\b(flood\w*|burst pipe|water|leak\w*|sewage)\b/i.test(body) ? "If you can do it safely, turn off the home's main water shut-off. " : '';
  const question = pre.emergency ? 'Which home address is this about, so I can reach the right person right away?' : `Which home address are you ${channel === 'voice' ? 'calling' : 'asking'} about?`;
  const intro = channel === 'voice'
    ? 'This line answers for several rental homes.'
    : `Hi! This is the ${brand} automated assistant. This ${channel === 'email' ? 'inbox' : 'number'} answers for several rental homes.`;
  return `${safety}${intro} ${question}`;
}

/** Shared number, phone call: the owner of the emergency this caller just reported (to transfer the call). */
export function callerEmergencyOwner(store: Store, from: string | undefined, since: string): Owner | undefined {
  if (!from) return undefined;
  const k = addressKey(from);
  const wo = store.list('workOrders', (w) => w.urgency === 'emergency' && w.createdAt >= since && !!w.tenantId && !!k && addressKey(store.get('tenants', w.tenantId)?.phone ?? '') === k).pop();
  return wo ? store.get('owners', wo.ownerId) : undefined;
}
