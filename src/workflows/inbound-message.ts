// FRONT DESK: every text, email or voice transcript comes in here.
//
//  message.received
//    → record it
//    → who sent it? owner / tenant / vendor / prospect / unknown
//    → owner:   "YES 4F2" / "NO 4F2" decides an approval
//    → vendor:  parse accept / time / quote / done / invoice → vendor.replied
//    → others:  guardrails first (emergency, accommodation, fair-housing, legal → owner)
//               then the communication AI classifies and drafts a reply
//               then guardrails check the draft
//               then hand the request to the right workflow (repair, showing, renewal...)
//
//  Repairs are a conversation first: the AI helps the tenant pin down the problem
//  and try safe fixes, and every reply carries the tenant's choices
//  (1 send a pro · 2 call me · 3 email me · 4 it's fixed · 9 emergency).
//  Emergencies skip the chat and dispatch at once.

import type { WorkflowDef } from '../engine/engine.ts';
import type { Services } from '../services.ts';
import type { Channel, Owner, Tenant, Urgency } from '../domain/types.ts';
import type { AIResult, Intent, SenderRole } from '../ai/types.ts';
import { SAFE_REPLY, postcheck, precheck } from '../ai/guardrails.ts';
import { guessTrade, summarize } from '../ai/rules.ts';
import { addressKey, buildFacts, firstName, identify, propertyName, send, tellOwner, type C } from './lib.ts';

export interface InboundPayload {
  from: string;
  to?: string;
  channel: Channel;
  body: string;
  media?: string[];
  ownerId?: string; // resolved from `to` by the API when possible
  providerMessageId?: string;
  subject?: string;
}

const ALLOWED: Record<SenderRole, Intent[]> = {
  tenant: ['emergency', 'maintenance_request', 'maintenance_update', 'rent_question', 'lease_question', 'renewal_response', 'move_out_notice', 'accommodation_request', 'fair_housing_sensitive', 'complaint_or_legal', 'general'],
  prospect: ['showing_request', 'listing_question', 'application_question', 'accommodation_request', 'fair_housing_sensitive', 'screening_decision_question', 'complaint_or_legal', 'general'],
  unknown: ['showing_request', 'listing_question', 'application_question', 'accommodation_request', 'fair_housing_sensitive', 'screening_decision_question', 'complaint_or_legal', 'general'],
  vendor: ['vendor_update', 'general'],
};

export const inboundMessage: WorkflowDef<Services, InboundPayload> = {
  name: 'inbound-message',
  title: 'Incoming message',
  description: 'Answers tenants, prospects and vendors 24/7, routes sensitive topics to the owner, and starts the right workflow.',
  trigger: { event: 'message.received', dedupeKey: (p) => p.providerMessageId ?? `${p.from}|${p.body}|${p.media?.length ?? 0}|${Date.now()}` },

  async run(ctx, m) {
    const store = ctx.store;
    const svc = ctx.svc;
    const media = m.media ?? [];
    const party = identify(store, m.from, m.ownerId);
    const ownerId = party.role === 'owner' ? party.owner.id : party.role === 'unknown' ? m.ownerId : party.ownerId;
    if (ownerId) ctx.setOwner(ownerId);

    await ctx.step('record', () =>
      store.insert('messages', { ownerId, threadKey: addressKey(m.from), direction: 'in', channel: m.channel, from: m.from, to: m.to, body: m.body, media, at: svc.clock.now().toISOString(), meta: { role: party.role } }),
    );
    const reply = (body: string, meta?: Record<string, unknown>) => send(ctx, { label: 'reply', ownerId, to: m.from, channel: m.channel, body, subject: m.subject ? `Re: ${m.subject}` : undefined, meta });

    /* ---------------- owner commands ---------------- */
    // One phone can be both the owner and a vendor (an owner who runs a trade business).
    // Approval codes go to the owner; replies about an open job go to the vendor side.
    let sharedVendor: ReturnType<typeof vendorWithOpenJob> = undefined;
    if (party.role === 'owner') {
      sharedVendor = isApprovalCommand(store, party.owner.id, m.body) ? undefined : vendorWithOpenJob(store, m.from, party.owner.id);
      if (!sharedVendor) return ownerCommand(ctx, party.owner.id, m, reply);
    }

    if (!ownerId) {
      await ctx.log('message.unrouted', `Message from ${m.from} could not be matched to an owner.`);
      return { routed: false };
    }
    const owner = store.get('owners', ownerId)!;
    const rules = store.get('rules', ownerId);

    /* ---------------- vendors ---------------- */
    if (party.role === 'vendor' || sharedVendor) {
      const vendor = party.role === 'vendor' ? party.vendor : sharedVendor!;
      const ai = await ctx.step('ai', () => svc.ai.respond({ ownerId, channel: m.channel, senderRole: 'vendor', senderName: vendor.name, message: m.body, mediaCount: media.length, history: [], facts: [], allowedIntents: ALLOWED.vendor, ownerFirstName: firstName(owner.name), brandName: svc.brand.name }));
      const workOrderId = store.kvGet<string>('vendorLast', vendor.id);
      const e = ai.entities;
      await ctx.emit('vendor.replied', {
        ownerId, vendorId: vendor.id, workOrderId,
        accept: e.vendorAccept, window: e.vendorWindow,
        quote: e.vendorQuote !== undefined ? Math.round(e.vendorQuote * 100) : undefined,
        done: e.vendorDone === true, invoice: e.vendorInvoice !== undefined ? Math.round(e.vendorInvoice * 100) : undefined,
        photos: media, body: m.body,
      });
      if (ai.reply) await reply(ai.reply);
      return { role: 'vendor', workOrderId };
    }

    /* ---------------- tenants & prospects ---------------- */
    let role: SenderRole = party.role === 'tenant' ? 'tenant' : party.role === 'prospect' ? 'prospect' : 'unknown';
    let prospectId = party.role === 'prospect' ? party.prospect.id : undefined;
    const tenant = party.role === 'tenant' ? party.tenant : undefined;

    // A tenant sending the photo we asked for → attach it to the open repair.
    if (tenant && media.length) {
      const waitingWo = store.kvGet<string>('awaitingPhoto', tenant.id);
      if (waitingWo) {
        await ctx.emit('maintenance.photo', { tenantId: tenant.id, workOrderId: waitingWo, photos: media });
        await reply('Got the photo, thank you! Booking the repair now.');
        return { attachedPhotoTo: waitingWo };
      }
    }
    // A tenant picking one of the repair choices ("1", "call me", "9"...).
    const chat = tenant ? openRepairChat(store, tenant.id, svc.clock.now()) : undefined;
    const choice = chat ? menuChoice(m.body) : undefined;
    if (tenant && chat && choice) return repairChoice(ctx, choice, chat, tenant, owner, m, reply);

    // A prospect choosing a showing slot ("2").
    if (prospectId && /^\s*[1-3]\s*$/.test(m.body)) {
      const showingId = store.kvGet<string>('showingChoice', prospectId);
      if (showingId) {
        await ctx.emit('showing.slot_chosen', { showingId, choice: Number(m.body.trim()) });
        return { showingChoice: m.body.trim() };
      }
    }
    // First contact from an unknown number → remember them as a prospect.
    if (role === 'unknown') {
      const listed = store.list('properties', (p) => p.ownerId === ownerId && (p.status === 'listed' || p.status === 'vacant'));
      const p = await ctx.step('new-prospect', () =>
        store.insert('prospects', { ownerId, phone: m.channel === 'sms' || m.channel === 'voice' ? m.from : undefined, email: m.channel === 'email' ? m.from : undefined, interestedIn: listed.length === 1 ? listed[0].id : undefined, optInUpdates: false, createdAt: svc.clock.now().toISOString() }),
      );
      prospectId = p.id;
      role = 'prospect';
    }

    const pre = precheck(m.body, rules?.alwaysRouteToOwner ?? []);
    const propertyId = tenant?.propertyId ?? (prospectId ? store.get('prospects', prospectId)?.interestedIn : undefined);

    if (pre.emergency && tenant) {
      const water = /\b(flood\w*|burst pipe|water|leak\w*|sewage)\b/i.test(m.body);
      await reply(/\bgas\b|carbon monoxide/i.test(m.body) ? SAFE_REPLY.gas! : pre.danger ? SAFE_REPLY.emergency! : water ? SAFE_REPLY.water! : SAFE_REPLY.urgent_repair!);
      if (chat) await ctx.step('chat-close', () => store.kvDelete('repairChat', tenant.id));
      await ctx.emit('maintenance.requested', { ownerId, propertyId: tenant.propertyId, tenantId: tenant.id, summary: summarize(m.body), trade: guessTrade(m.body), urgency: 'emergency', photos: media });
      await ctx.log('message.emergency', `Emergency reported by ${tenant.name}: "${m.body}"`, { actor: 'tenant' });
      return { intent: 'emergency' };
    }
    if (pre.route) {
      const text = (pre.intent && SAFE_REPLY[pre.intent]) || "Thanks for your message. I've passed it to the owner, who will follow up with you directly.";
      await reply(text);
      await routeToOwner(ctx, ownerId, `${tenant ? tenant.name : 'A prospect'} (${m.from})`, m.body, pre.reason ?? 'Owner asked to handle this topic.');
      return { intent: pre.intent ?? 'general', routed: true };
    }

    // History + facts for the AI.
    const history = store
      .list('messages', (x) => x.threadKey === addressKey(m.from))
      .sort((a, b) => a.at.localeCompare(b.at))
      .slice(-9, -1)
      .map((x) => ({ direction: x.direction, body: x.body }));
    const facts = buildFacts(store, ownerId, propertyId, svc.cfg.publicUrl);
    if (tenant) {
      const open = store.list('workOrders', (w) => w.tenantId === tenant.id && !['paid', 'cancelled', 'completed'].includes(w.status));
      for (const w of open) facts.push({ label: `Open repair: ${w.summary.slice(0, 60)}`, value: w.scheduledFor ? `scheduled ${w.scheduledFor}` : `status: ${w.status.replace(/_/g, ' ')}` });
      if (chat) facts.push({ label: 'Problem we are talking through now (no pro booked yet)', value: chat.summary });
    }

    const ai: AIResult = await ctx.step('ai', () =>
      svc.ai.respond({ ownerId, channel: m.channel, senderRole: role, senderName: tenant?.name, message: m.body, mediaCount: media.length, history, facts, allowedIntents: ALLOWED[role], ownerFirstName: firstName(owner.name), brandName: svc.brand.name }),
    );
    let text = ai.reply;
    const check = postcheck(text, facts);
    let handoff = ai.handoff;
    let reason = ai.handoffReason;
    if (!check.ok) {
      text = "Thanks for your message! I've passed it to the owner, who will follow up with you shortly.";
      handoff = true;
      reason = `AI draft blocked by guardrails: ${check.problems.join('; ')}`;
    }
    // A model may also flag sensitive intents itself.
    if (['accommodation_request', 'fair_housing_sensitive', 'screening_decision_question', 'complaint_or_legal'].includes(ai.intent)) {
      text = SAFE_REPLY[ai.intent] ?? text;
      handoff = true;
      reason ??= `Sensitive topic (${ai.intent}).`;
    }

    switch (ai.intent) {
      case 'maintenance_request':
      case 'maintenance_update': {
        if (!tenant) break;
        const action = ai.entities.repairAction ?? (ai.intent === 'maintenance_request' ? 'dispatch' : chat ? 'troubleshoot' : undefined);
        const summary = ai.entities.summary ?? chat?.summary ?? summarize(m.body);
        if (action === 'troubleshoot') {
          const next: RepairChat = { summary, trade: ai.entities.trade ?? chat?.trade ?? guessTrade(m.body), urgency: ai.entities.urgency === 'urgent' ? 'urgent' : chat?.urgency ?? 'routine', photos: [...(chat?.photos ?? []), ...media], startedAt: chat?.startedAt ?? svc.clock.now().toISOString() };
          await ctx.step('chat-open', () => store.kvSet('repairChat', tenant.id, next));
          if (!handoff) {
            await reply(withMenu(text, m.channel), { options: MENU });
            text = '';
          }
        } else if (action === 'resolved') {
          if (chat) await ctx.step('chat-close', () => store.kvDelete('repairChat', tenant.id));
          await ctx.log('repair.self-fixed', `${tenant.name} fixed it without a pro: "${summary}"`, { actor: 'tenant' });
        } else if (action === 'dispatch') {
          if (chat) await ctx.step('chat-close', () => store.kvDelete('repairChat', tenant.id));
          await ctx.emit('maintenance.requested', { ownerId, propertyId: tenant.propertyId, tenantId: tenant.id, summary, trade: ai.entities.trade ?? chat?.trade ?? 'general', urgency: ai.entities.urgency ?? chat?.urgency ?? 'routine', photos: [...(chat?.photos ?? []), ...media] });
        }
        break;
      }
      case 'emergency':
        if (tenant) {
          if (chat) await ctx.step('chat-close', () => store.kvDelete('repairChat', tenant.id));
          await ctx.emit('maintenance.requested', { ownerId, propertyId: tenant.propertyId, tenantId: tenant.id, summary: summarize(m.body), trade: ai.entities.trade ?? guessTrade(m.body), urgency: 'emergency', photos: [...(chat?.photos ?? []), ...media] });
        }
        // Danger gets the fixed 911 wording; property emergencies keep the AI's checked reply.
        if (precheck(m.body).danger || /\b911\b/.test(text) || !text) text = precheck(m.body).danger ? SAFE_REPLY.emergency! : SAFE_REPLY.urgent_repair!;
        break;
      case 'showing_request':
        if (prospectId && propertyId) await ctx.emit('showing.requested', { ownerId, propertyId, prospectId, preferredTimes: ai.entities.preferredTimes ?? [] });
        else { handoff = true; reason ??= 'Showing request but no specific home on file.'; }
        break;
      case 'renewal_response':
        if (tenant) await ctx.emit('renewal.response', { tenantId: tenant.id, answer: ai.entities.renewalAnswer ?? 'question', body: m.body });
        break;
      case 'move_out_notice':
        if (tenant) await ctx.emit('moveout.notice', { ownerId, tenantId: tenant.id, date: ai.entities.moveOutDate });
        break;
      case 'listing_question':
        if (prospectId && (ai.entities.beds || ai.entities.maxRent)) {
          await ctx.step('prospect-wants', () => store.update('prospects', prospectId!, { wants: { beds: ai.entities.beds, maxRent: ai.entities.maxRent ? ai.entities.maxRent * 100 : undefined } }));
        }
        break;
    }

    if (text) await reply(text);
    if (handoff) await routeToOwner(ctx, ownerId, `${tenant ? tenant.name : 'A prospect'} (${m.from})`, m.body, reason ?? 'Needs a person.');
    await ctx.log('message.answered', `${role} → ${ai.intent} (${ai.provider})${handoff ? ' · routed to owner' : ''}`, { actor: 'ai', data: { from: m.from, intent: ai.intent } });
    return { intent: ai.intent, handoff };
  },
};

async function routeToOwner(ctx: C, ownerId: string, who: string, body: string, reason: string) {
  await ctx.step('owner-task', () =>
    ctx.store.insert('tasks', { ownerId, title: `Reply to ${who}`, detail: `"${body}"\n\nWhy you: ${reason}`, status: 'open', dueAt: new Date(ctx.svc.clock.now().getTime() + 24 * 3600_000).toISOString() }),
  );
  await tellOwner(ctx, 'owner-routed', ownerId, `${ctx.svc.brand.name}: ${who} wrote "${body.slice(0, 120)}". ${reason} It's in your inbox to answer.`);
}

/** Owners can approve by text: "YES 4F2", "NO 4F2", or any listed option word plus the code. */
async function ownerCommand(ctx: C, ownerId: string, m: InboundPayload, reply: (b: string) => Promise<void>) {
  const svc = ctx.svc;
  const match = m.body.trim().match(/^(\w+)\s+([A-Z0-9]{3})\b\s*(.*)$/i);
  if (match) {
    const [, word, code, note] = match;
    const approvalId = ctx.store.kvGet<string>('approvalCode', code.toUpperCase());
    const a = approvalId ? ctx.store.get('approvals', approvalId) : undefined;
    if (a && a.status === 'pending' && a.ownerId === ownerId) {
      const w = word.toLowerCase();
      const decision = ['yes', 'y', 'approve', 'ok'].includes(w) ? a.options[0] : ['no', 'n', 'decline', 'deny'].includes(w) ? a.options[a.options.length - 1] : a.options.find((o) => o.toLowerCase().startsWith(w));
      if (decision) {
        await ctx.step('decide', () => svc.engine.decide(a.id, decision, note || undefined));
        await reply(`Done: "${a.title}" → ${decision.replace(/_/g, ' ')}.`);
        return { ownerDecision: decision };
      }
    }
    if (/^(yes|y|no|n|ok|approve|decline|deny)$/i.test(word)) {
      await reply(`I couldn't match code ${code.toUpperCase()} to an open decision. Open the app to see everything waiting for you.`);
      return { ownerDecision: null };
    }
  }
  const pending = ctx.store.list('approvals', (a) => a.ownerId === ownerId && a.status === 'pending');
  await reply(pending.length ? `You have ${pending.length} decision${pending.length > 1 ? 's' : ''} waiting: ${pending.slice(0, 3).map((a) => a.title).join('; ')}. Open the app or reply with the YES/NO code from each text.` : 'Nothing needs you right now.');
  return { ownerStatus: pending.length };
}

function isApprovalCommand(store: C['store'], ownerId: string, body: string): boolean {
  const m = body.trim().match(/^(\w+)\s+([A-Z0-9]{3})\b/i);
  if (!m) return false;
  const id = store.kvGet<string>('approvalCode', m[2].toUpperCase());
  const a = id ? store.get('approvals', id) : undefined;
  return !!a && a.status === 'pending' && a.ownerId === ownerId;
}

function vendorWithOpenJob(store: C['store'], from: string, ownerId: string) {
  const k = addressKey(from);
  const v = store.find('vendors', (x) => x.ownerId === ownerId && !!x.phone && addressKey(x.phone) === k);
  if (!v) return undefined;
  const woId = store.kvGet<string>('vendorLast', v.id);
  const wo = woId ? store.get('workOrders', woId) : undefined;
  return wo && ['awaiting_vendor', 'awaiting_owner', 'scheduled', 'in_progress'].includes(wo.status) ? v : undefined;
}

/* ---------------- repair conversations ---------------- */

interface RepairChat { summary: string; trade: string; urgency: Urgency; photos: string[]; startedAt: string }
type Choice = 'dispatch' | 'call' | 'email' | 'fixed' | 'emergency';

/** The tenant's choices, shown on every troubleshooting reply. /play shows them as buttons. */
const MENU = [
  { key: '1', label: 'Send a pro' },
  { key: '2', label: 'Call me' },
  { key: '3', label: 'Email me' },
  { key: '4', label: "It's fixed" },
  { key: '9', label: 'Emergency' },
];
const CHAT_TTL_MS = 3 * 24 * 3600_000;

function withMenu(text: string, channel: Channel): string {
  const menu = MENU.map((o) => `${o.key} ${o.label}`).join(' · ');
  return `${text}\n\n${channel === 'email' ? 'Reply with a number:' : 'Reply'} ${menu}`;
}

function openRepairChat(store: C['store'], tenantId: string, now: Date): RepairChat | undefined {
  const chat = store.kvGet<RepairChat>('repairChat', tenantId);
  return chat && now.getTime() - new Date(chat.startedAt).getTime() < CHAT_TTL_MS ? chat : undefined;
}

export function menuChoice(body: string): Choice | undefined {
  const t = body.trim().toLowerCase().replace(/[.!]+$/, '');
  if (/^(1|send (a |someone|somebody|a pro|a plumber|help)\b.*|book (a pro|someone|it))$/.test(t)) return 'dispatch';
  if (/^(2|call me( instead)?|please call me)$/.test(t)) return 'call';
  if (/^(3|email me( instead)?|please email me)$/.test(t)) return 'email';
  if (/^(4|fixed|it'?s fixed|it'?s working( now)?|all good( now)?)$/.test(t)) return 'fixed';
  if (/^(9|emergency)$/.test(t)) return 'emergency';
  return undefined;
}

async function repairChoice(ctx: C, choice: Choice, chat: RepairChat, tenant: Tenant, owner: Owner, m: InboundPayload, reply: (b: string, meta?: Record<string, unknown>) => Promise<void>) {
  const store = ctx.store;
  const who = firstName(owner.name);
  const address = propertyName(store, tenant.propertyId);
  const close = () => ctx.step('chat-close', () => store.kvDelete('repairChat', tenant.id));
  const request = (urgency: Urgency) => ctx.emit('maintenance.requested', { ownerId: owner.id, propertyId: tenant.propertyId, tenantId: tenant.id, summary: chat.summary, trade: chat.trade, urgency, photos: [...chat.photos, ...(m.media ?? [])] });
  const task = (title: string, detail: string) => ctx.step('owner-task', () => store.insert('tasks', { ownerId: owner.id, title, detail, status: 'open', dueAt: new Date(ctx.svc.clock.now().getTime() + 4 * 3600_000).toISOString() }));

  switch (choice) {
    case 'dispatch':
      await close();
      await request(chat.urgency);
      await reply(`Booking a pro for "${chat.summary}" now.${chat.photos.length ? '' : ' If you can, text a photo of it; it helps them bring the right parts.'}`);
      break;
    case 'call':
      await task(`Call ${tenant.name}`, `About "${chat.summary}" at ${address}. ${tenant.phone ?? ''}`);
      await tellOwner(ctx, 'call-request', owner.id, `${ctx.svc.brand.name}: ${tenant.name} asked for a call about "${chat.summary}" at ${address}. Please call ${tenant.phone ?? 'them'}.`);
      await reply(`No problem. I've asked ${who} to give you a call${tenant.phone ? ` at ${tenant.phone}` : ''}. If it gets worse before then, reply 9.`);
      break;
    case 'email':
      if (!tenant.email) {
        await task(`Add an email for ${tenant.name}`, `They asked to switch to email about "${chat.summary}".`);
        await reply(`I don't have an email on file for you yet, so I've asked ${who} to add it. We can keep going here by text in the meantime.`);
        break;
      }
      await send(ctx, { label: 'email-switch', ownerId: owner.id, to: tenant.email, channel: 'email', subject: `Your repair: ${chat.summary}`, body: withMenu(`Hi ${firstName(tenant.name)}, picking up here by email about "${chat.summary}" at ${address}. Just reply to this email with any details or questions.`, 'email'), meta: { options: MENU } });
      await reply(`Sent! Check your email at ${tenant.email} and reply there anytime.`);
      break;
    case 'fixed':
      await close();
      await ctx.log('repair.self-fixed', `${tenant.name} fixed it without a pro: "${chat.summary}"`, { actor: 'tenant' });
      await reply(`Great news, glad it's working! If it acts up again, just text me.`);
      break;
    case 'emergency':
      await close();
      await task(`URGENT: call ${tenant.name}`, `Pressed EMERGENCY about "${chat.summary}" at ${address}. ${tenant.phone ?? ''}`);
      await tellOwner(ctx, 'emergency-button', owner.id, `URGENT: ${tenant.name} pressed EMERGENCY about "${chat.summary}" at ${address}. Please call them now${tenant.phone ? ` at ${tenant.phone}` : ''}.`);
      await request('emergency');
      await reply(`Getting a person on this right now. I've asked ${who} to call you and I'm contacting the emergency repair vendor. If anyone is in danger, call 911.`);
      break;
  }
  await ctx.log('repair.choice', `${tenant.name} chose "${choice}" for "${chat.summary}"`, { actor: 'tenant' });
  return { repairChoice: choice };
}
