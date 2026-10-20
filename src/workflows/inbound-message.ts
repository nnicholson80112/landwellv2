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
import type { Approval, Channel, Owner, Tenant, Urgency } from '../domain/types.ts';
import type { AIResult, Intent, SenderRole } from '../ai/types.ts';
import { SAFE_REPLY, postcheck, precheck } from '../ai/guardrails.ts';
import { guessTrade, summarize } from '../ai/rules.ts';
import { addressKey, buildFacts, contactOf, firstName, identify, money, propertyName, quote, send, tellOwner, type C } from './lib.ts';
import { optionLabel, replyHint } from './owner.ts';
import { fmtTime, slotPrefs } from './showings-listings.ts';
import { routeUnknownSender } from '../ops/lines.ts';

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
    let ownerId = party.role === 'owner' ? party.owner.id : party.role === 'unknown' ? m.ownerId : party.ownerId;
    if (ownerId) ctx.setOwner(ownerId);

    await ctx.step('record', () =>
      store.insert('messages', { ownerId, threadKey: addressKey(m.from), direction: 'in', channel: m.channel, from: m.from, to: m.to, body: m.body, media, at: svc.clock.now().toISOString(), meta: { role: party.role } }),
    );
    const reply = (body: string, meta?: Record<string, unknown>) => send(ctx, { label: 'reply', ownerId, to: m.from, channel: m.channel, body, subject: m.subject ? `Re: ${m.subject}` : undefined, meta });

    // Nothing to read (an empty text, or a blank call turn): nothing to answer.
    if (!m.body.trim() && !media.length && party.role !== 'owner') return { empty: true };

    /* ---------------- STOP / START ---------------- */
    // Carriers handle the confirmation text; we stop (or restart) our own texts to this number.
    const kw = m.channel === 'sms' ? textingKeyword(m.body) : undefined;
    if (kw) return optOutChange(ctx, kw, party, ownerId, m.from);

    /* ---------------- owner commands ---------------- */
    // One phone can be both the owner and a vendor (an owner who runs a trade business).
    // Approval codes go to the owner; replies about an open job go to the vendor side.
    let sharedVendor: ReturnType<typeof vendorWithOpenJob> = undefined;
    if (party.role === 'owner') {
      sharedVendor = isApprovalCommand(store, party.owner.id, m.body) ? undefined : vendorWithOpenJob(store, m.from, party.owner.id);
      if (!sharedVendor) return ownerCommand(ctx, party.owner.id, m, reply);
    }

    if (!ownerId) {
      // Shared number, new sender: the home they name picks the owner; otherwise ask once, then alert the admin (src/ops/lines.ts).
      const routed = await routeUnknownSender(ctx, m, (body) => reply(body));
      if (!routed) return { routed: false };
      ownerId = routed.ownerId;
      if (routed.body) m = { ...m, body: routed.body }; // answering our "which home?": their first question plus the address
    }
    const owner = store.get('owners', ownerId)!;
    const rules = store.get('rules', ownerId);
    const ownerFirst = firstName(owner.name);

    /* ---------------- vendors ---------------- */
    if (party.role === 'vendor' || sharedVendor) {
      const vendor = party.role === 'vendor' ? party.vendor : sharedVendor!;
      const ai = await ctx.step('ai', () => svc.ai.respond({ ownerId, channel: m.channel, senderRole: 'vendor', senderName: vendor.name, message: m.body, mediaCount: media.length, history: [], facts: [], allowedIntents: ALLOWED.vendor, ownerFirstName: ownerFirst, brandName: svc.brand.name }));
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

    // Move-out: "please reply with your forwarding address" (often after they've moved out).
    if (tenant) {
      if (store.kvGet('forwarding', tenant.id) && looksLikeAddress(m.body) && !precheck(m.body).emergency) {
        const address = stripAddressIntro(m.body);
        await ctx.step('forwarding', () => { store.update('tenants', tenant.id, { forwardingAddress: address }); store.kvDelete('forwarding', tenant.id); });
        await reply(`Thanks, ${firstName(tenant.name)}! I've saved ${address} for your deposit statement and refund.`);
        await ctx.log('tenant.forwarding', `${tenant.name} gave a forwarding address: ${address}`, { actor: 'tenant' });
        return { forwardingAddress: address };
      }
    }
    // Former tenants write about their deposit or move-out: that's the owner's to answer.
    if (tenant?.status === 'former') {
      await reply(`Thanks, ${firstName(tenant.name)}. I've passed this to ${ownerFirst}, who will reply to you directly.`);
      await routeToOwner(ctx, ownerId, `${tenant.name}, a former tenant (${m.from})`, m.body, 'Former tenants (deposit and move-out questions) go to you.');
      return { role: 'former_tenant', routed: true };
    }

    // A tenant sending the photo we asked for → attach it to the open repair.
    if (tenant && media.length) {
      const waitingWo = store.kvGet<string>('awaitingPhoto', tenant.id);
      if (waitingWo) {
        await ctx.emit('maintenance.photo', { tenantId: tenant.id, workOrderId: waitingWo, photos: media });
        await reply('Got the photo, thank you! Booking the repair now.');
        return { attachedPhotoTo: waitingWo };
      }
      // A photo a little later, for a repair that's already moving → add it and pass it to the vendor.
      // Only when the text doesn't describe a different problem ("the dryer is broken too" starts a new repair).
      const wo = recentOpenRepair(store, tenant.id, svc.clock.now());
      const about = guessTrade(m.body);
      if (wo && (about === 'general' || about === wo.trade) && m.body.trim().split(/\s+/).filter(Boolean).length <= 12) {
        await ctx.step('photo-add', () => store.update('workOrders', wo.id, { photos: [...wo.photos, ...media] }));
        const vendor = wo.vendorId && ['awaiting_vendor', 'awaiting_owner', 'scheduled', 'in_progress'].includes(wo.status) ? store.get('vendors', wo.vendorId) : undefined;
        const vc = vendor && contactOf(vendor);
        if (vc) await send(ctx, { label: 'photo-forward', ownerId, ...vc, body: `Photo from the resident for "${wo.summary}" at ${propertyName(store, wo.propertyId)}: ${media.join(' ')}` });
        await reply(`Thanks! I added the photo to your repair${vendor ? ` and sent it to ${vendor.name}` : ''}.`);
        return { attachedPhotoTo: wo.id };
      }
    }
    // A tenant picking one of the repair choices ("1", "call me", "9"...).
    const chat = tenant ? openRepairChat(store, tenant.id, svc.clock.now()) : undefined;
    const choice = chat ? menuChoice(m.body) : undefined;
    if (tenant && chat && choice) return repairChoice(ctx, choice, chat, tenant, owner, m, reply);

    // A prospect choosing a showing slot ("2"), or asking for another day ("Saturday instead?").
    const showingId = prospectId ? store.kvGet<string>('showingChoice', prospectId) : undefined;
    if (showingId) {
      const n = m.body.trim().match(/^#?([1-3])[.)!]*$/);
      const p = slotPrefs(m.body, svc.clock.now().toISOString(), svc.cfg.tz);
      if (n || p.days || p.part || p.afterHour !== undefined) {
        await ctx.emit('showing.slot_chosen', { showingId, choice: n ? Number(n[1]) : 0, request: m.body });
        return { showingChoice: n ? n[1] : 'other day' };
      }
    }
    // First contact from an unknown number → remember them as a prospect.
    const mentioned = role === 'tenant' ? undefined : mentionedHome(store, ownerId, m.body);
    if (role === 'unknown') {
      const p = await ctx.step('new-prospect', () =>
        store.insert('prospects', { ownerId, phone: m.channel === 'sms' || m.channel === 'voice' ? m.from : undefined, email: m.channel === 'email' ? m.from : undefined, interestedIn: mentioned, optInUpdates: false, createdAt: svc.clock.now().toISOString() }),
      );
      prospectId = p.id;
      role = 'prospect';
    } else if (prospectId && mentioned && store.get('prospects', prospectId)?.interestedIn !== mentioned) {
      await ctx.step('prospect-home', () => store.update('prospects', prospectId!, { interestedIn: mentioned }));
    }

    // "Thanks!" or a thumbs-up closes the loop; no reply needed and nothing for the owner.
    if (!media.length && /^(thanks?|thank you|thank u|thx|ty|tysm|thanks so much|thank you so much|much appreciated|appreciate it|got it|great|perfect|awesome|cool|sounds good|will do|👍|🙏|🙂|😊|❤️)[\s.!,]*(thanks?|thank you)?[\s.!]*$/iu.test(m.body.trim())) {
      await ctx.log('message.thanks', `${tenant ? tenant.name : 'A prospect'} said ${quote(m.body)}`, { actor: tenant ? 'tenant' : 'prospect' });
      if (m.channel === 'voice') await reply("You're welcome!"); // a call can't just go quiet
      return { acknowledged: true };
    }

    // A prospect asking about one of the owner's homes that isn't for rent: say so plainly, and point to what is.
    const unlisted = prospectId ? namedHome(store, ownerId, m.body) : undefined;
    if (prospectId && unlisted && !listedHomes(store, ownerId).some((h) => h.id === unlisted.id) && !precheck(m.body).route) {
      const open = listedHomes(store, ownerId);
      if (!open.length) await ctx.step('ask-updates', () => store.kvSet('prospectAsk', prospectId!, { kind: 'updates', until: new Date(svc.clock.now().getTime() + 14 * 24 * 3600_000).toISOString() }));
      await reply(`Thanks for asking! ${unlisted.address} isn't available right now.${open.length ? ` Available now: ${open.map((h) => `${h.address} (${h.beds} bed, ${money(h.rent)}/month)`).join('; ')}. Want details or a tour?` : " Want a text when a home opens up? Reply YES."}`);
      return { intent: 'listing_question', unlisted: unlisted.id };
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

    /* ---------------- answers to something we asked ---------------- */
    if (tenant) {
      // Late rent: the owner offered a payment plan and asked what the tenant can do.
      const plan = store.kvGet<{ at: string }>('paymentPlan', tenant.id);
      if (plan && svc.clock.now().getTime() - Date.parse(plan.at) < 14 * 24 * 3600_000 && /\b(pay\w*|rent|plan|owe|balance|amount|check|zelle|venmo|cash|week|month|friday|payday|paycheck|can)\b|\$\s?\d|\b\d{1,2}(st|nd|rd|th)\b/i.test(m.body)) {
        await ctx.step('plan-flag', () => store.kvDelete('paymentPlan', tenant.id));
        await reply(`Thanks, ${firstName(tenant.name)}. I've sent this to ${ownerFirst}, who will reply to you about the payment plan.`);
        await routeToOwner(ctx, ownerId, `${tenant.name} (${m.from})`, m.body, 'Reply to the payment plan you offered.');
        return { intent: 'payment_plan_reply', routed: true };
      }
      // Renewal offer: "Reply YES to renew or NO if you're moving out."
      const renewing = waitingRenewal(ctx, tenant);
      const yn = yesNo(m.body);
      if (renewing && yn && !pre.route) {
        await ctx.emit('renewal.response', { leaseId: renewing.id, tenantId: tenant.id, answer: yn === 'yes' ? 'accept' : 'decline', body: m.body });
        await reply(yn === 'yes' ? `Wonderful, ${firstName(tenant.name)}! Your renewal lease will arrive here for e-signature shortly.` : `Thanks for letting us know, ${firstName(tenant.name)}. I've told ${ownerFirst}, and I'll send your move-out steps next.`);
        return { intent: 'renewal_response', answer: yn };
      }
    }
    if (prospectId && !pre.route) {
      const ask = store.kvGet<ProspectAsk>('prospectAsk', prospectId);
      const yn = ask && Date.parse(ask.until) > svc.clock.now().getTime() ? yesNo(m.body) : undefined;
      if (ask && yn) {
        await ctx.step('ask-done', () => store.kvDelete('prospectAsk', prospectId!));
        if (yn === 'no') {
          await reply('No problem, thanks for letting me know!');
        } else if (ask.kind === 'updates') {
          await ctx.step('opt-in', () => store.update('prospects', prospectId!, { optInUpdates: true }));
          await reply("You're on the list. I'll text you when a home opens up. Reply STOP anytime to opt out.");
        } else {
          await ctx.step('tour-home', () => store.update('prospects', prospectId!, { interestedIn: ask.propertyId }));
          await ctx.emit('showing.requested', { ownerId, propertyId: ask.propertyId, prospectId, preferredTimes: [], request: m.body });
        }
        return { prospectAnswer: ask.kind, yn };
      }
    }

    if (pre.route) {
      const text = (pre.intent && SAFE_REPLY[pre.intent]) || `Thanks for your message. I've passed it to ${ownerFirst}, who will follow up with you directly.`;
      await reply(text);
      await routeToOwner(ctx, ownerId, `${tenant ? tenant.name : 'A prospect'} (${m.from})`, m.body, pre.reason ?? 'You asked to handle this topic personally.', pre.intent === 'fair_housing_sensitive');
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
      for (const w of open) {
        const v = w.vendorId ? store.get('vendors', w.vendorId) : undefined;
        facts.push({ label: `Open repair: ${w.summary.slice(0, 60)}`, value: w.status === 'scheduled' && v ? `booked with ${v.name}${w.scheduledFor ? `, ${w.scheduledFor}` : ''}` : `status: ${w.status.replace(/_/g, ' ')}` });
      }
      if (chat) facts.push({ label: 'Problem we are talking through now (no pro booked yet)', value: chat.summary });
      // What the owner has marked, so "did my landlord get my rent?" has a true answer.
      const lease = store.find('leases', (l) => l.status === 'active' && l.tenantIds.includes(tenant.id));
      const charges = lease ? store.list('charges', (c) => c.leaseId === lease.id && c.status !== 'void').sort((a, b) => a.dueDate.localeCompare(b.dueDate)) : [];
      const latestRent = charges.filter((c) => c.kind === 'rent').pop();
      if (latestRent) facts.push({ label: `Rent due ${latestRent.dueDate}`, value: latestRent.status === 'paid' ? `${money(latestRent.amount)}, marked received by your landlord` : latestRent.paid ? `${money(latestRent.paid)} marked received by your landlord, ${money(latestRent.amount - latestRent.paid)} not marked received yet` : `${money(latestRent.amount)}, not marked received by your landlord yet` });
      for (const c of charges.filter((x) => x.kind !== 'rent' && x.status === 'open')) facts.push({ label: `${c.kind === 'late_fee' ? 'Late fee' : c.kind === 'deposit' ? 'Security deposit' : 'Charge'} due ${c.dueDate}`, value: `${money(c.amount - c.paid)}, not marked received by your landlord yet` });
    }

    const ai: AIResult = await ctx.step('ai', () =>
      svc.ai.respond({ ownerId, channel: m.channel, senderRole: role, senderName: tenant?.name, message: m.body, mediaCount: media.length, history, facts, allowedIntents: ALLOWED[role], ownerFirstName: ownerFirst, brandName: svc.brand.name }),
    );
    let text = ai.reply;
    const check = postcheck(text, facts);
    let handoff = ai.handoff;
    let reason = ai.handoffReason;
    let fyi = false;
    if (!check.ok) {
      text = `Thanks for your message! I've passed it to ${ownerFirst}, who will follow up with you shortly.`;
      handoff = true;
      reason = `AI draft blocked by guardrails: ${check.problems.join('; ')}`;
    }
    // A model may also flag sensitive intents itself.
    if (['accommodation_request', 'fair_housing_sensitive', 'screening_decision_question', 'complaint_or_legal'].includes(ai.intent)) {
      text = SAFE_REPLY[ai.intent] ?? text;
      handoff = true;
      fyi = ai.intent === 'fair_housing_sensitive';
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
      case 'showing_request': {
        const booked = prospectId ? activeShowing(store, prospectId, svc.clock.now()) : undefined;
        if (booked) {
          text = booked.status === 'confirmed'
            ? `You're booked for ${fmtTime(booked.at, svc.cfg.tz)} at ${propertyName(store, booked.propertyId)}. Your door code arrives 15 minutes before.`
            : `You're almost set for ${propertyName(store, booked.propertyId)}: finish the quick ID check from my earlier text, and I'll send tour times right after.`;
        } else if (prospectId && propertyId) await ctx.emit('showing.requested', { ownerId, propertyId, prospectId, preferredTimes: ai.entities.preferredTimes ?? [], request: m.body });
        else if (prospectId && listedHomes(store, ownerId).length > 1) text = `Happy to set up a tour! Which home would you like to see: ${listedHomes(store, ownerId).map((h) => h.address).join(' or ')}?`;
        else { handoff = true; reason ??= 'Showing request but no specific home on file.'; }
        break;
      }
      case 'renewal_response': {
        if (!tenant) break;
        const renewing = waitingRenewal(ctx, tenant);
        if (renewing) await ctx.emit('renewal.response', { leaseId: renewing.id, tenantId: tenant.id, answer: ai.entities.renewalAnswer ?? 'question', body: m.body });
        else {
          // No offer is out yet: don't promise a lease. Let the owner know what they said.
          text = ai.entities.renewalAnswer === 'decline'
            ? `Thanks for letting us know, ${firstName(tenant.name)}. I've passed this to ${ownerFirst}, who will confirm your move-out date with you.`
            : `Great to hear, ${firstName(tenant.name)}! I've let ${ownerFirst} know you'd like to stay. They'll follow up about renewal terms.`;
          handoff = true;
          reason = ai.entities.renewalAnswer === 'decline' ? 'Tenant says they will not renew (no renewal offer is out yet).' : 'Tenant would like to renew (no renewal offer is out yet).';
        }
        break;
      }
      case 'move_out_notice':
        if (tenant) await ctx.emit('moveout.notice', { ownerId, tenantId: tenant.id, leaseId: store.find('leases', (l) => l.status === 'active' && l.tenantIds.includes(tenant.id))?.id, date: ai.entities.moveOutDate });
        break;
      case 'listing_question':
        if (prospectId && (ai.entities.beds || ai.entities.maxRent)) {
          await ctx.step('prospect-wants', () => store.update('prospects', prospectId!, { wants: { beds: ai.entities.beds, maxRent: ai.entities.maxRent ? ai.entities.maxRent * 100 : undefined } }));
        }
        break;
    }

    if (text) await reply(text);
    if (handoff) await routeToOwner(ctx, ownerId, `${tenant ? tenant.name : 'A prospect'} (${m.from})`, m.body, reason ?? 'Needs a person.', fyi);
    await ctx.log('message.answered', `${role} → ${ai.intent} (${ai.provider})${handoff ? ' · routed to owner' : ''}`, { actor: 'ai', data: { from: m.from, intent: ai.intent } });
    return { intent: ai.intent, handoff };
  },
};

/** Tell the owner. FYI items (a neutral fair-housing reply already went out) skip the to-do list. */
async function routeToOwner(ctx: C, ownerId: string, who: string, body: string, reason: string, fyi = false) {
  if (fyi) {
    await ctx.log('message.fyi', `${who} asked ${quote(body)}. ${reason}`);
    await tellOwner(ctx, 'owner-fyi', ownerId, `${ctx.svc.brand.name} FYI: ${who} asked ${quote(body)} That's a fair-housing topic, so I sent a neutral reply about the home only. Nothing for you to do.`);
    return;
  }
  await ctx.step('owner-task', () =>
    ctx.store.insert('tasks', { ownerId, title: `Reply to ${who}`, detail: `"${body}"\n\nWhy you: ${reason}`, status: 'open', dueAt: new Date(ctx.svc.clock.now().getTime() + 24 * 3600_000).toISOString() }),
  );
  await tellOwner(ctx, 'owner-routed', ownerId, `${ctx.svc.brand.name}: ${who} wrote ${quote(body)} ${reason} Please reply to them directly.`);
}

/* ---------------- owner texts ---------------- */

const YES = /^(yes|y|yep|yeah|yup|ok|okay|sure|approve|approved|go ahead|do it)$/i;
const NO = /^(no|n|nope|nah|decline|declined|deny|denied)$/i;

/** Which option an answer word picks. YES/NO only work when there are exactly two choices. */
export function pickOption(options: string[], word: string): string | undefined {
  const w = word.toLowerCase();
  if (/^\d$/.test(w)) return options[Number(w) - 1];
  if (options.length === 2 && YES.test(w)) return options[0];
  if (options.length === 2 && NO.test(w)) return options[1];
  return options.find((o) => o.toLowerCase() === w) ?? (w.length >= 3 ? options.find((o) => o.toLowerCase().startsWith(w)) : undefined);
}

/** Extra details an owner can add after the code: "YES K4P $2,850" (renewal rent), "NO K4P carpet $150, blinds $40" (deposit deductions). */
export function noteData(kind: string, decision: string, note: string): Record<string, unknown> | undefined {
  if (!note.trim()) return undefined;
  if (kind === 'renewal_terms' && decision === 'offer_renewal') {
    const out: Record<string, unknown> = {};
    const rent = note.match(/\$?\s?(\d{1,2},?\d{3}(?:\.\d{2})?)(?!\s*(?:mo|month))/i);
    if (rent) out.rent = Math.round(Number(rent[1].replace(/,/g, '')) * 100);
    const months = note.match(/\b(\d{1,2})\s*(?:mo|months?)\b/i);
    if (months) out.months = Number(months[1]);
    return Object.keys(out).length ? out : undefined;
  }
  if (kind === 'rent_check' && decision === 'received') {
    const amt = note.match(/\$?\s?(\d[\d,]*(?:\.\d{1,2})?)/);
    return amt ? { amount: Math.round(Number(amt[1].replace(/,/g, '')) * 100) } : undefined;
  }
  if (kind.startsWith('deposit') && decision === 'deductions_entered') {
    const deductions = note.split(/[,;\n]+|\band\b/i).map((part) => {
      const amt = part.match(/\$?\s?(\d[\d,]*(?:\.\d{1,2})?)/);
      const reason = part.replace(/\$?\s?\d[\d,]*(?:\.\d{1,2})?/, '').replace(/^[\s:-]+|[\s:-]+$/g, '');
      return amt && reason ? { reason, amount: Math.round(Number(amt[1].replace(/,/g, '')) * 100) } : undefined;
    }).filter(Boolean);
    return deductions.length ? { deductions } : undefined;
  }
  return undefined;
}

/** Owners decide by text: "YES K4P", "NO K4P", "2 K4P", or a bare "yes" when only one decision is open. */
async function ownerCommand(ctx: C, ownerId: string, m: InboundPayload, reply: (b: string) => Promise<void>) {
  const svc = ctx.svc;
  const store = ctx.store;
  const pending = store.list('approvals', (a) => a.ownerId === ownerId && a.status === 'pending').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const t = m.body.trim();
  let a: Approval | undefined;
  let word = '';
  let note = '';
  const coded = t.match(/^([\w']+)[\s,:.-]+([A-Z0-9]{3})\b[\s,:.-]*([\s\S]*)$/i);
  if (coded) {
    const id = store.kvGet<string>('approvalCode', coded[2].toUpperCase());
    const found = id ? store.get('approvals', id) : undefined;
    if (found && found.ownerId === ownerId) [a, word, note] = [found, coded[1], coded[3]];
  }
  const bare = !a && t.match(/^([\w']+)[.!]*$/);
  if (bare && (YES.test(bare[1]) || NO.test(bare[1]) || /^\d$/.test(bare[1]))) {
    if (pending.length === 1) [a, word] = [pending[0], bare[1]];
    else if (pending.length > 1) {
      await reply(`Which one? ${pending.length} decisions are open:\n${pending.slice(0, 3).map((p) => `• ${p.title}: ${replyHint(p)}`).join('\n')}`);
      return { ownerDecision: null };
    }
  }
  if (a) {
    if (a.status !== 'pending') {
      await reply(`That one's already decided: ${a.title} → ${optionLabel(a.decision ?? a.status)}.`);
      return { ownerDecision: null };
    }
    const decision = pickOption(a.options, word);
    if (!decision) {
      await reply(`I didn't catch that. ${a.title}: ${replyHint(a)}`);
      return { ownerDecision: null };
    }
    const data = noteData(a.kind, decision, note);
    await ctx.step('decide', () => svc.engine.decide(a!.id, decision, note.trim() || undefined, data));
    await reply(`Got it: ${optionLabel(decision)}. (${a.title})`);
    return { ownerDecision: decision };
  }
  await reply(pending.length
    ? `${pending.length} decision${pending.length > 1 ? 's' : ''} waiting on you:\n${pending.slice(0, 3).map((p) => `• ${p.title}: ${replyHint(p)}`).join('\n')}`
    : "Nothing needs you right now. I'll text you when something does.");
  return { ownerStatus: pending.length };
}

function isApprovalCommand(store: C['store'], ownerId: string, body: string): boolean {
  const m = body.trim().match(/^([\w']+)[\s,:.-]+([A-Z0-9]{3})\b/i);
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

/* ---------------- texting keywords ---------------- */

export function textingKeyword(body: string): 'stop' | 'start' | undefined {
  const t = body.trim().toLowerCase().replace(/[.!]+$/, '');
  if (/^(stop|stopall|stop all|unsubscribe|cancel|end|quit|opt ?out|optout|revoke)$/.test(t)) return 'stop';
  if (/^(start|unstop|resume|opt ?in)$/.test(t)) return 'start';
  return undefined;
}

async function optOutChange(ctx: C, kw: 'stop' | 'start', party: ReturnType<typeof identify>, ownerId: string | undefined, from: string) {
  const store = ctx.store;
  await ctx.step('opt-out', () => (kw === 'stop' ? store.kvSet('optOut', addressKey(from), ctx.svc.clock.now().toISOString()) : store.kvDelete('optOut', addressKey(from))));
  if (party.role === 'owner') {
    // Owner alerts switch to email while texts are off.
    await ctx.step('owner-consent', () => store.update('owners', party.owner.id, { consents: { ...party.owner.consents, smsConsent: kw === 'start', smsConsentAt: ctx.svc.clock.now().toISOString() } }));
  } else if (party.role === 'prospect' && kw === 'stop') {
    await ctx.step('prospect-optout', () => store.update('prospects', party.prospect.id, { optInUpdates: false }));
  } else if (party.role === 'tenant' && ownerId) {
    const t = party.tenant;
    await tellOwner(ctx, 'tenant-optout', ownerId, kw === 'stop'
      ? `${ctx.svc.brand.name}: ${t.name} replied STOP, so we've stopped texting them. ${t.email ? `Reminders and notices will go to ${t.email} instead.` : 'Add an email for them so rent reminders and notices still reach them.'}`
      : `${ctx.svc.brand.name}: ${t.name} turned texts back on.`);
  }
  await ctx.log(kw === 'stop' ? 'texts.opted-out' : 'texts.opted-in', `${party.role === 'tenant' ? party.tenant.name : from} ${kw === 'stop' ? 'replied STOP: no more texts to this number' : 'replied START: texts back on'}.`);
  return { keyword: kw };
}

/* ---------------- helpers for the front desk ---------------- */

interface ProspectAsk { kind: 'tour' | 'updates'; propertyId?: string; until: string }

/** A clear yes or no at the start of a message ("Yes! We'd love to", "No, we're moving"). */
// "No hot water" is not a no, and "Yes the sink is leaking again" is not a yes: the word has to stand on its own.
export function yesNo(body: string): 'yes' | 'no' | undefined {
  const t = body.trim().toLowerCase();
  const alone = '(?=$|[.!,;:)]|\\s+(thanks?|thank you|please|we|we\'?d|we\'?re|we\'?ll|i|i\'?d|i\'?m|i\'?ll|let\'?s|sounds|definitely|absolutely|that works|not)\\b)';
  if (new RegExp(`^(yes|yep|yeah|yup|y|sure|ok|okay|absolutely|definitely|of course)${alone}`).test(t) || /^(we'?d love to|count us in)\b/.test(t)) return 'yes';
  if (new RegExp(`^(no|nope|nah|n|no thanks|not this time)${alone}`).test(t)) return 'no';
  return undefined;
}

/** Looks like a mailing address: a street number and a street word, or a ZIP code. */
export function looksLikeAddress(body: string): boolean {
  if (body.includes('?')) return false;
  const t = stripAddressIntro(body);
  if (/^p\.?\s?o\.?\s?box\s*\d+/i.test(t)) return true;
  // Starts with a street number, then a street word or a ZIP code soon after.
  return /^\d{1,6}\s+\S+/.test(t) && t.split(/\s+/).length <= 16 && (/\b(st|street|ave|avenue|rd|road|dr|drive|ln|lane|ct|court|cir|circle|blvd|boulevard|way|pl|place|pkwy|parkway|ter|terrace|trl|trail|apt|unit|suite|hwy|highway)\b/i.test(t) || /\b\d{5}(-\d{4})?\b/.test(t));
}
function stripAddressIntro(body: string): string {
  return body.trim().replace(/\s+/g, ' ').replace(/^((here'?s|here is|it'?s|it is|my|our|the|new|forwarding|mailing|address|is|send (it|them|the deposit) to|you can (send|mail) (it|them) to|please (send|mail) (it|them) to)[:,\s-]*)+/i, '').replace(/[.!]+$/, '');
}

function listedHomes(store: C['store'], ownerId: string) {
  return store.list('properties', (p) => p.ownerId === ownerId && (p.status === 'listed' || p.status === 'vacant'));
}

/** The owner's home whose street name appears in the message ("Aspen"), listed or not. */
function namedHome(store: C['store'], ownerId: string, body: string) {
  const t = body.toLowerCase();
  return store.list('properties', (p) => p.ownerId === ownerId).find((h) => h.address.toLowerCase().split(/\s+/).filter((w) => w.length >= 4 && !/^\d/.test(w) && !/^(street|avenue|court|drive|circle|road|lane|place|boulevard|parkway|trail|unit)$/.test(w)).some((w) => new RegExp(`\\b${w}\\b`).test(t)));
}

/** Which available home a prospect means: the one whose street name they used ("Aspen"), or the only one. */
export function mentionedHome(store: C['store'], ownerId: string, body: string): string | undefined {
  const homes = listedHomes(store, ownerId);
  const named = namedHome(store, ownerId, body);
  if (named) return homes.some((h) => h.id === named.id) ? named.id : undefined;
  return homes.length === 1 ? homes[0].id : undefined;
}

function activeShowing(store: C['store'], prospectId: string, now: Date) {
  return store.list('showings', (s) => s.prospectId === prospectId && (s.status === 'requested' || (s.status === 'confirmed' && Date.parse(s.at) > now.getTime()))).pop();
}

/** The lease whose renewal offer is waiting on this tenant's answer, if any. */
function waitingRenewal(ctx: C, tenant: Tenant) {
  const lease = ctx.store.find('leases', (l) => l.status === 'active' && l.tenantIds.includes(tenant.id));
  if (!lease) return undefined;
  const run = ctx.svc.engine.runs((r) => r.workflow === 'renewal' && r.status === 'waiting' && r.input?.leaseId === lease.id && r.wait?.kind === 'event' && r.wait.event === 'renewal.response');
  return run.length ? lease : undefined;
}

function recentOpenRepair(store: C['store'], tenantId: string, now: Date) {
  return store
    .list('workOrders', (w) => w.tenantId === tenantId && !['paid', 'cancelled', 'completed'].includes(w.status) && now.getTime() - Date.parse(w.createdAt) < 14 * 24 * 3600_000)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .pop();
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
  if (channel === 'voice') return `${text} You can also say: send a pro, call me, it's fixed, or emergency.`;
  const menu = MENU.map((o) => `${o.key} ${o.label}`).join(' · ');
  return `${text}\n\n${channel === 'email' ? 'Reply with a number:' : 'Reply'} ${menu}`;
}

function openRepairChat(store: C['store'], tenantId: string, now: Date): RepairChat | undefined {
  const chat = store.kvGet<RepairChat>('repairChat', tenantId);
  return chat && now.getTime() - new Date(chat.startedAt).getTime() < CHAT_TTL_MS ? chat : undefined;
}

export function menuChoice(body: string): Choice | undefined {
  // Also what people say on a call ("One.", "Please send someone", "Yeah, call me").
  const t = body.trim().toLowerCase().replace(/[.!,]+/g, '').replace(/^(please|yes|yeah|yep|ok|okay|um|uh)\s+/, '').replace(/\s+please$/, '').trim();
  if (/^(1|one|send (a |someone|somebody|a pro|a plumber|help|over)\b.*|book (a pro|someone|it)|get (a pro|someone) (out|over)( here)?)$/.test(t)) return 'dispatch';
  if (/^(2|two|call me( instead| back)?|can you call me|have (him|her|them|the owner|the landlord) call me)$/.test(t)) return 'call';
  if (/^(3|three|email me( instead)?)$/.test(t)) return 'email';
  if (/^(4|four|fixed|it'?s fixed( now)?|it'?s working( now)?|all good( now)?|never ?mind( it'?s fixed)?|that (fixed|did) it|that worked)$/.test(t)) return 'fixed';
  if (/^(9|nine|emergency|it'?s an emergency)$/.test(t)) return 'emergency';
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
