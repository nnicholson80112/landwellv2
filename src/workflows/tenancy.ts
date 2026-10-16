// RENEWALS, MOVE-OUTS and NEW-TENANT WELCOME.
//
// Renewal: N days before the lease ends, the owner sets the terms (or picks a
// Colorado for-cause reason not to renew) → offer to tenant → yes = renewal
// lease, no = move-out.
// Move-out: confirm → list early → owner walkthrough → deposit itemized and
// returned within Colorado's 30 days.

import type { WorkflowDef } from '../engine/engine.ts';
import type { Services } from '../services.ts';
import { DAY } from '../engine/clock.ts';
import { addDays, daysBetween } from '../engine/clock.ts';
import { CO } from '../config/colorado.ts';
import { firstName, money, niceDate, noticeTenant, propertyName, quote, tellOwner, tellTenant } from './lib.ts';

export const renewalSweep: WorkflowDef<Services, { localDate: string }> = {
  name: 'renewal-sweep',
  title: 'Daily renewal check',
  description: 'Starts a renewal for every lease that reaches the owner\'s renewal lead time.',
  trigger: { schedule: { every: 'day', at: '07:00' } },
  async run(ctx, { localDate }) {
    const store = ctx.store;
    let started = 0;
    for (const l of store.list('leases', (x) => x.status === 'active')) {
      const rules = store.get('rules', l.ownerId);
      if (!rules) continue;
      const left = daysBetween(localDate, l.endDate);
      const hasNext = store.find('leases', (n) => n.renewalOf === l.id);
      if (left <= rules.renewalLeadDays && left > 0 && !hasNext && l.startDate <= localDate) {
        // renewal.due is de-duplicated per lease, so daily sweeps start it once.
        await ctx.emit('renewal.due', { leaseId: l.id, ownerId: l.ownerId });
        started++;
      }
    }
    return { started };
  },
};

export const renewal: WorkflowDef<Services, { leaseId: string; ownerId: string }> = {
  name: 'renewal',
  title: 'Lease renewal',
  description: 'Owner sets renewal terms (or a Colorado for-cause reason), tenant accepts or declines, then a renewal lease or a move-out.',
  trigger: { event: 'renewal.due', dedupeKey: (p) => p.leaseId },

  async run(ctx, { leaseId, ownerId }) {
    const store = ctx.store;
    ctx.setOwner(ownerId);
    const lease = store.get('leases', leaseId)!;
    const address = propertyName(store, lease.propertyId);
    const tenants = lease.tenantIds.map((id) => store.get('tenants', id)!).filter(Boolean);
    const today = (await ctx.now()).toISOString().slice(0, 10);
    const daysLeft = daysBetween(today, lease.endDate);
    const canRaise = !lease.lastRentIncreaseAt || Date.parse(lease.lastRentIncreaseAt) <= Date.parse(addDays(lease.endDate, 1)) - 365 * DAY;

    const terms = await ctx.approval({
      kind: 'renewal_terms',
      title: `Renewal: ${address} (lease ends ${niceDate(lease.endDate, today)})`,
      body: `${tenants.map((t) => t.name).join(' and ')} pay${tenants.length > 1 ? '' : 's'} ${money(lease.rent)}/month. Offer a 12-month renewal at the same rent?${canRaise ? ' To change the rent or term, add it after your YES (like "YES code $2,850 12 months").' : ' Colorado allows one rent increase per 12 months, so the rent stays the same this time.'}`,
      options: ['offer_renewal', 'do_not_renew'],
      data: { rent: lease.rent, months: 12 },
    });
    if (!terms) return { status: 'no_decision' };

    if (terms.decision === 'do_not_renew') {
      const why = await ctx.approval({ kind: 'non_renewal_reason', title: `Reason for not renewing: ${address}`, body: `Colorado's for-cause law (HB24-1098) requires a qualifying reason and generally ${CO.nonRenewalNoticeDays} days' notice for most tenancies. Pick the reason, "exempt" only if your attorney confirmed the tenancy is exempt, or cancel to keep things as they are.`, options: [...CO.forCauseNonRenewalReasons, 'exempt_tenancy_confirmed_by_attorney', 'cancel'] });
      if (!why || why.decision === 'cancel') return { status: 'cancelled' };
      if (daysLeft < CO.nonRenewalNoticeDays && why.decision !== 'exempt_tenancy_confirmed_by_attorney') {
        await tellOwner(ctx, 'late-notice', ownerId, `Heads up: only ${daysLeft} days remain on ${address}, fewer than the ${CO.nonRenewalNoticeDays} days Colorado generally requires. Talk to an attorney before sending a non-renewal.`);
        await ctx.step('task', () => store.insert('tasks', { ownerId, title: `Non-renewal timing: ${address}`, detail: `Reason chosen: ${why.decision}. Notice period may be too short.`, status: 'open' }));
        return { status: 'needs_attorney' };
      }
      for (const t of tenants) await noticeTenant(ctx, `nonrenew:${t.id}`, t, `Hi ${firstName(t.name)}, a notice about your lease at ${address}: the owner will not be renewing when it ends ${niceDate(lease.endDate, today)}. Reason: ${why.decision.replace(/_/g, ' ')}. A written notice will also be delivered. I'll send move-out steps closer to the date.`);
      await ctx.step('nonrenew-task', () => store.insert('tasks', { ownerId, title: `Deliver written non-renewal notice: ${address}`, detail: `Reason: ${why.decision}. Colorado generally requires written notice at least ${CO.nonRenewalNoticeDays} days before ${lease.endDate}. Have it delivered the way your attorney recommends.`, status: 'open' }));
      await ctx.emit('moveout.notice', { ownerId, tenantId: tenants[0]?.id, leaseId, date: lease.endDate, fromOwner: true });
      return { status: 'not_renewing' };
    }

    const rent = canRaise ? Number(terms.data.rent ?? lease.rent) : lease.rent;
    const months = Number(terms.data.months ?? 12);
    const first = tenants.map((t) => firstName(t.name)).join(' and ');
    for (const t of tenants) await noticeTenant(ctx, `offer:${t.id}`, t, `Good news, ${firstName(t.name)}: the owner would like to renew your lease at ${address}. New term: ${months} months from ${niceDate(addDays(lease.endDate, 1), today)}, rent ${money(rent)}/month. Reply YES to renew or NO if you're moving out. Questions are welcome too.`);

    // Wait for a yes or no. Questions go to the owner and we keep waiting; one reminder after 2 weeks.
    let ans: { answer: string; body?: string; tenantId?: string } | null = null;
    let reminded = false;
    for (let round = 0; round < 6; round++) {
      ans = await ctx.waitFor('renewal.response', { leaseId }, { timeoutMs: 14 * DAY, label: 'Waiting for the tenant to answer the renewal offer' });
      if (!ans) {
        if (reminded) break;
        reminded = true;
        for (const t of tenants) await noticeTenant(ctx, `offer-remind:${t.id}`, t, `Reminder: please reply YES to renew your lease at ${address}, or NO if you're moving out.`);
        continue;
      }
      if (ans.answer === 'accept' || ans.answer === 'decline') break;
      await tellOwner(ctx, `renewal-question-${round}`, ownerId, `${first} asked about the renewal for ${address}: ${quote(ans.body ?? '')} Please reply to them directly. I'll keep the offer open.`);
    }
    if (ans?.answer === 'accept') {
      await tellOwner(ctx, 'renewal-yes', ownerId, `${first} accepted the renewal for ${address} (${money(rent)}/month, ${months} months). The lease is going out for signatures now.`);
      await ctx.emit('lease.requested', { ownerId, propertyId: lease.propertyId, renewalOf: lease.id, tenantIds: lease.tenantIds, startDate: addDays(lease.endDate, 1), months, rent, deposit: lease.deposit });
      return { status: 'accepted' };
    }
    if (ans?.answer === 'decline') {
      await tellOwner(ctx, 'renewal-no', ownerId, `${first} won't be renewing at ${address}. The lease ends ${niceDate(lease.endDate, today)}; I'll handle the move-out steps and get the listing ready.`);
      await ctx.emit('moveout.notice', { ownerId, tenantId: ans.tenantId ?? tenants[0]?.id, leaseId, date: lease.endDate });
      return { status: 'declined' };
    }
    await ctx.step('no-answer', () => store.insert('tasks', { ownerId, title: `No renewal answer: ${address}`, detail: `${first} hasn't answered the renewal offer. Lease ends ${lease.endDate}.`, status: 'open' }));
    await tellOwner(ctx, 'renewal-silent', ownerId, `${first} hasn't answered the renewal offer for ${address} after 4 weeks. You may want to call them. The lease ends ${niceDate(lease.endDate, today)}.`);
    return { status: 'no_answer' };
  },
};

export const moveOut: WorkflowDef<Services, { ownerId: string; tenantId: string; leaseId?: string; date?: string; fromOwner?: boolean }> = {
  name: 'move-out',
  title: 'Move-out and deposit',
  description: 'Confirms the date, lists the home early, prompts the owner walkthrough, and gets the itemized deposit statement out before Colorado\'s deadline (the owner sends the refund).',
  trigger: { event: 'moveout.notice', dedupeKey: (p) => p.leaseId ?? p.tenantId },

  async run(ctx, input) {
    const store = ctx.store;
    ctx.setOwner(input.ownerId);
    // Recorded once: the lease ends partway through this run, and replays must still find it.
    const leaseId = await ctx.step('lease', () => {
      const l = (input.leaseId && store.get('leases', input.leaseId)) || store.find('leases', (x) => x.status === 'active' && x.tenantIds.includes(input.tenantId));
      return l && l.status === 'active' ? l.id : null;
    });
    const lease = leaseId ? store.get('leases', leaseId) : undefined;
    if (!lease) {
      const t = store.get('tenants', input.tenantId);
      await tellOwner(ctx, 'no-lease', input.ownerId, `${t?.name ?? 'A tenant'} sent a move-out notice, but I couldn't find their active lease. Please follow up with them directly.`);
      return { status: 'no_lease' };
    }
    const tenants = lease.tenantIds.map((id) => store.get('tenants', id)!).filter(Boolean);
    const names = tenants.map((t) => t.name).join(' and ');
    const address = propertyName(store, lease.propertyId);
    const today = (await ctx.now()).toISOString().slice(0, 10);
    const date = input.date && input.date <= lease.endDate && input.date >= today ? input.date : lease.endDate;

    for (const t of tenants) await ctx.step(`forwarding-flag:${t.id}`, () => store.kvSet('forwarding', t.id, true));
    for (const t of tenants) await noticeTenant(ctx, `confirm:${t.id}`, t, `Got it, ${firstName(t.name)}: move-out from ${address} is ${niceDate(date, today)}. Before then: clean, remove all belongings, and return keys. Please reply with your forwarding address so your landlord can send your deposit statement and refund.`);
    if (!input.fromOwner) await tellOwner(ctx, 'owner', input.ownerId, `${names} ${tenants.length > 1 ? 'are' : 'is'} moving out of ${address} on ${niceDate(date, today)}. I'll get the listing ready so it can go up early.`);
    await ctx.emit('listing.requested', { ownerId: input.ownerId, propertyId: lease.propertyId, availableFrom: addDays(date, 3) });
    await ctx.step('walkthrough-task', () => store.insert('tasks', { ownerId: input.ownerId, title: `Move-out walkthrough: ${address}`, detail: `Do the walkthrough on ${date} and take photos of every room. Compare with move-in photos. Normal wear and tear can't be charged.`, dueAt: date + 'T17:00:00Z', status: 'open' }));

    await ctx.sleepUntil(addDays(date, -1) + 'T16:00:00Z', 'Waiting until the day before move-out');
    for (const t of tenants) await noticeTenant(ctx, `tomorrow:${t.id}`, t, `Reminder: move-out is tomorrow (${niceDate(date)}). Please leave keys inside and lock up. ${t.forwardingAddress || store.get('tenants', t.id)?.forwardingAddress ? 'Thank you!' : "And if you haven't yet, reply with your forwarding address for your deposit."}`);

    await ctx.sleepUntil(addDays(date, 1) + 'T09:00:00Z', 'Waiting for move-out day to pass');
    await ctx.step('end', () => {
      store.update('leases', lease.id, { status: 'ended' });
      for (const t of tenants) store.update('tenants', t.id, { status: 'former' });
      const p = store.get('properties', lease.propertyId);
      // A home already listed stays listed (now available right away); otherwise it's between tenants.
      return store.update('properties', lease.propertyId, p?.status === 'listed' ? { facts: { ...p.facts, 'Available from': 'now' } } : { status: 'turnover' });
    });

    // Deposit: the owner itemizes; we enforce the deadline.
    const deadline = addDays(date, CO.depositReturnDays);
    const held = lease.depositHeld || lease.deposit;
    const howTo = 'To take deductions, reply NO with the code and list each one, like "NO code carpet cleaning $150, broken blinds $40". Only damage beyond normal wear and tear, unpaid rent or unpaid utilities can be deducted.';
    let d = await ctx.approval({
      kind: 'deposit', title: `Deposit for ${address}: ${money(held)}`,
      body: `Return the full deposit, or take deductions. ${howTo} Colorado deadline: ${niceDate(deadline)}.`,
      options: ['return_full', 'deductions_entered'], data: { deductions: [] }, timeoutMs: 21 * DAY,
    });
    if (!d) {
      await tellOwner(ctx, 'deposit-urgent', input.ownerId, `URGENT: the deposit for ${address} must be returned or itemized by ${niceDate(deadline)}. Keeping it without an itemized statement can cost you damages.`);
      d = await ctx.approval({ kind: 'deposit-final', title: `Deposit due by ${niceDate(deadline)}: ${address}`, body: `Return the full deposit, or take deductions. ${howTo}`, options: ['return_full', 'deductions_entered'], data: { deductions: [] } });
    }
    // "Take deductions" with none listed: ask for the list rather than send a full refund by mistake.
    for (let i = 0; i < 3 && d?.decision === 'deductions_entered' && !((d.data.deductions as unknown[] | undefined)?.length); i++) {
      d = await ctx.approval({ kind: 'deposit-list', title: `List the deposit deductions: ${address}`, body: `I need each deduction and amount before I send the statement. ${howTo} Deadline: ${niceDate(deadline)}.`, options: ['return_full', 'deductions_entered'], data: { deductions: [] } });
    }
    const deductions = (d?.data.deductions as { reason: string; amount: number }[] | undefined) ?? [];
    const total = deductions.reduce((s, x) => s + x.amount, 0);
    const refund = Math.max(0, held - total);
    // The owner holds the deposit and sends the refund; Landwell sends the statement and tracks the deadline.
    const fwd = tenants.map((t) => store.get('tenants', t.id)?.forwardingAddress).filter(Boolean).join('; ');
    await ctx.step('refund-task', () => store.insert('tasks', { ownerId: input.ownerId, title: `Send deposit refund of ${money(refund)}: ${address}`, detail: `Send ${money(refund)} to ${names} by ${deadline} (Colorado deadline). ${fwd ? `Forwarding address: ${fwd}.` : 'They have not given a forwarding address; mail it to their last known address or ask them.'} The itemized statement has been sent to them.`, dueAt: deadline + 'T17:00:00Z', status: 'open' }));
    const lines = deductions.map((x) => `• ${x.reason}: ${money(x.amount)}`).join('\n');
    for (const t of tenants) await noticeTenant(ctx, `statement:${t.id}`, t, `Deposit statement for ${address}: deposit ${money(held)}${deductions.length ? `\nDeductions:\n${lines}` : ', no deductions'}\nRefund: ${money(refund)}, sent to you by your landlord by ${niceDate(deadline)}. Questions? Reply here and I'll pass them to your landlord.`);
    await ctx.log('deposit.statement', `Deposit statement for ${address}: ${money(refund)} to refund, ${money(total)} deducted. Owner reminded to send it by ${deadline}.`);
    return { refund, deducted: total };
  },
};

export const tenantWelcome: WorkflowDef<Services, { tenantId: string }> = {
  name: 'tenant-welcome',
  title: 'Tenant welcome',
  description: 'Welcomes a tenant added by the owner: how to request repairs and reach the landlord.',
  trigger: { event: 'tenant.added', dedupeKey: (p) => p.tenantId },
  async run(ctx, { tenantId }) {
    const t = ctx.store.get('tenants', tenantId)!;
    ctx.setOwner(t.ownerId);
    const address = propertyName(ctx.store, t.propertyId);
    await noticeTenant(ctx, 'welcome', t, `Hi ${firstName(t.name)}! Your landlord now uses ${ctx.svc.brand.name} for ${address}. Text this number anytime for repairs (send a photo) or questions. You'll keep paying rent to your landlord the same way; we'll just send you a reminder before it's due. Reply STOP to opt out of texts.`);
    await ctx.log('tenant.welcomed', `${t.name} invited.`);
    return { ok: true };
  },
};
