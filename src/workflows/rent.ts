// RENT: Landwell NEVER collects or holds rent. Tenants pay the owner directly
// (however the owner already gets paid). Landwell only:
//   • reminds tenants when rent is coming due,
//   • asks the owner whether rent arrived before anyone is told it's late,
//   • sends late notices the owner's lease allows, and tells the owner the
//     Colorado late-fee cap so the owner can decide whether to charge it.
// Nothing here moves money, and nothing is ever filed with a court.

import type { WorkflowDef } from '../engine/engine.ts';
import type { Services } from '../services.ts';
import type { Charge } from '../domain/types.ts';
import { addDays, daysBetween } from '../engine/clock.ts';
import { CO, cappedLateFee } from '../config/colorado.ts';
import { DAY } from '../engine/clock.ts';
import { firstName, money, niceDate, noticeTenant, propertyName, tellTenant } from './lib.ts';

const DEFAULT_HOW_TO_PAY = 'Please pay your landlord the way you normally do.';

function dueDateFor(localDate: string, dueDay: number): { period: string; due: string } {
  // The rent record for the upcoming due date: if we're past this month's due day + 20, look at next month.
  const [y, m, d] = localDate.split('-').map(Number);
  let yy = y, mm = m;
  if (d > dueDay + 20) { mm += 1; if (mm > 12) { mm = 1; yy += 1; } }
  const period = `${yy}-${String(mm).padStart(2, '0')}`;
  return { period, due: `${period}-${String(dueDay).padStart(2, '0')}` };
}

export const rentCycle: WorkflowDef<Services, { localDate: string }> = {
  name: 'rent-cycle',
  title: 'Daily rent check',
  description: 'Tracks each month\'s rent, reminds tenants to pay the owner directly, and asks the owner to confirm before anything is called late.',
  trigger: { schedule: { every: 'day', at: '09:00' } }, // after quiet hours, so tenants and owners aren't texted early

  async run(ctx, { localDate }) {
    const store = ctx.store;
    const leases = store.list('leases', (l) => l.status === 'active' && l.startDate <= addDays(localDate, 6) && l.endDate >= localDate);
    let created = 0, reminded = 0, checks = 0;

    for (const lease of leases) {
      const rules = store.get('rules', lease.ownerId);
      if (!rules) continue;
      const { period, due } = dueDateFor(localDate, rules.rentDueDay);
      if (due < lease.startDate || due > lease.endDate) continue;
      const tenants = lease.tenantIds.map((id) => store.get('tenants', id)!).filter(Boolean);
      const reminders = tenants.filter((t) => !t.autopay); // autopay = tenant already pays the owner automatically
      const howToPay = rules.howToPay || DEFAULT_HOW_TO_PAY;
      const daysToDue = daysBetween(localDate, due);
      let charge = store.find('charges', (c) => c.leaseId === lease.id && c.kind === 'rent' && c.period === period);

      // 5 days before: start the month's rent record and send a heads-up.
      if (!charge && daysToDue <= 5 && daysToDue >= -2) {
        charge = await ctx.step(`charge:${lease.id}:${period}`, () =>
          store.insert('charges', { ownerId: lease.ownerId, leaseId: lease.id, kind: 'rent', amount: lease.rent, dueDate: due, paid: 0, status: 'open', period, notices: [] }));
        created++;
        for (const t of reminders) await noticeTenant(ctx, `upcoming:${charge.id}:${t.id}`, t, `Hi ${firstName(t.name)}, a heads-up: rent of ${money(lease.rent)} for ${propertyName(store, lease.propertyId)} is due ${niceDate(due)}. ${howToPay}`);
      }
      if (!charge || charge.status !== 'open') continue;

      // Due date: one friendly reminder.
      if (daysToDue === 0 && !charge.notices.includes('due') && reminders.length) {
        await ctx.step(`due:${charge.id}`, () => store.update('charges', charge!.id, { notices: [...charge!.notices, 'due'] }));
        for (const t of reminders) await noticeTenant(ctx, `due:${charge.id}:${t.id}`, t, `Friendly reminder: rent of ${money(charge.amount - charge.paid)} is due today. ${howToPay} If you've already paid, thank you!`);
        reminded++;
      }
      // After the grace period: ask the owner if it arrived (once). Only the owner knows.
      if (-daysToDue > rules.graceDays && !charge.notices.includes('late')) {
        await ctx.step(`late:${charge.id}`, () => store.update('charges', charge!.id, { notices: [...charge!.notices, 'late'] }));
        await ctx.emit(`rent.late`, { ownerId: lease.ownerId, chargeId: charge.id });
        checks++;
      }
    }
    await ctx.log('rent.sweep', `Rent check ${localDate}: ${created} months started, ${reminded} reminders, ${checks} owner checks.`);
    return { created, reminded, checks };
  },
};

export const paymentReceived: WorkflowDef<Services, { chargeId: string; amount: number; method?: 'owner_recorded'; providerRef?: string }> = {
  name: 'payment-received',
  title: 'Rent marked received',
  description: 'The owner confirms rent arrived (paid to them directly). Records it in the books, thanks the tenant and stops reminders.',
  trigger: { event: 'payment.received', dedupeKey: (p) => p.providerRef ?? `${p.chargeId}:${p.amount}` },

  async run(ctx, p) {
    const store = ctx.store;
    const charge = store.get('charges', p.chargeId);
    if (!charge) throw new Error(`charge ${p.chargeId} not found`);
    ctx.setOwner(charge.ownerId);
    const lease = store.get('leases', charge.leaseId)!;
    await ctx.step('payment', () => store.insert('payments', { ownerId: charge.ownerId, leaseId: lease.id, chargeId: charge.id, amount: p.amount, method: 'owner_recorded', providerRef: p.providerRef, receivedAt: ctx.svc.clock.now().toISOString() }));
    const paid = charge.paid + p.amount;
    const updated: Charge = await ctx.step('charge', () => store.update('charges', charge.id, { paid, status: paid >= charge.amount ? 'paid' : 'open' }));
    const what = charge.kind === 'deposit' ? 'security deposit' : charge.kind === 'late_fee' ? 'late fee' : 'rent';
    for (const id of lease.tenantIds) {
      const t = store.get('tenants', id);
      if (t) await tellTenant(ctx, `receipt:${id}`, t, `Your landlord confirmed your ${what} payment of ${money(p.amount)}. Thank you!${updated.status === 'open' ? ` They show ${money(updated.amount - updated.paid)} still due.` : ''}`);
    }
    if (updated.status === 'paid') {
      // Any rent question still waiting on the owner is answered now (they marked it received in the app).
      await ctx.step('close-rent-questions', () => {
        for (const a of store.list('approvals', (x) => x.status === 'pending' && x.data.chargeId === charge.id)) {
          const pick = a.options.find((o) => ['received', 'skip_fee', 'keep_waiting'].includes(o));
          if (pick) ctx.svc.engine.decide(a.id, pick, 'Closed automatically: rent was marked received.');
        }
        return true;
      });
      await ctx.emit('charge.paid', { chargeId: charge.id });
    }
    await ctx.log('rent.recorded', `Owner recorded ${money(p.amount)} ${what} for ${propertyName(store, lease.propertyId)} (${charge.period ?? charge.kind}).`, { actor: 'owner' });
    return { status: updated.status };
  },
};

export const lateRent: WorkflowDef<Services, { ownerId: string; chargeId: string }> = {
  name: 'late-rent',
  title: 'Late rent',
  description: 'Owner confirms rent didn\'t arrive, then late notices; the owner decides on any late fee (Colorado-capped) and any formal notice.',
  trigger: { event: 'rent.late', dedupeKey: (p) => p.chargeId },

  async run(ctx, { ownerId, chargeId }) {
    const store = ctx.store;
    ctx.setOwner(ownerId);
    const charge = store.get('charges', chargeId)!;
    const lease = store.get('leases', charge.leaseId)!;
    const rules = store.get('rules', ownerId)!;
    const tenants = lease.tenantIds.map((id) => store.get('tenants', id)!).filter(Boolean);
    const address = propertyName(store, lease.propertyId);
    const howToPay = rules.howToPay || DEFAULT_HOW_TO_PAY;
    const dueMs = Date.parse(charge.dueDate + 'T12:00:00Z');
    const balance = () => { const c = store.get('charges', chargeId)!; return c.amount - c.paid; };
    const isPaid = () => store.get('charges', chargeId)!.status === 'paid';

    // 1. Ask the owner first. Landwell can't see the owner's bank, so no one is told rent is late until the owner says so.
    //    No answer in 2 days → ask once more. "YES code $1,500" records a partial payment.
    const ask = (round: number) => ctx.approval({
      kind: 'rent_check',
      title: `${round ? 'Reminder: did' : 'Did'} rent arrive? ${address} (${money(balance())})`,
      body: `Rent was due ${niceDate(charge.dueDate)}. If only part arrived, add the amount after YES (like "YES code $1,500"). If it hasn't arrived, I'll send ${tenants.map((t) => firstName(t.name)).join(' and ') || 'the tenant'} a polite note.`,
      options: ['received', 'not_received'],
      data: { chargeId },
      timeoutMs: round ? undefined : 2 * DAY,
    });
    const check = (await ask(0)) ?? (isPaid() ? null : await ask(1));
    let owed = balance();
    if (isPaid()) return { outcome: 'paid' };
    if (check?.decision === 'received') {
      const part = Number(check.data.amount) > 0 && Number(check.data.amount) < balance() ? Number(check.data.amount) : balance();
      await ctx.emit('payment.received', { chargeId, amount: part, method: 'owner_recorded', providerRef: `owner_${chargeId}_check` });
      if (part >= balance()) return { outcome: 'owner_confirmed_paid' };
      owed = balance() - part; // the partial payment is recorded by its own run, a moment later
    } else if (check?.decision !== 'not_received') return { outcome: 'no_decision' };

    for (const t of tenants) await noticeTenant(ctx, `late1:${t.id}`, t, `Hi ${firstName(t.name)}, your landlord hasn't received ${check?.decision === 'received' ? 'the rest of the rent' : 'rent'} (${money(owed)}) for ${address} yet. ${howToPay} If you've already paid, thank you and please ignore this.`);
    await ctx.log('rent.late-notice', `Late notice sent for ${address} (${money(balance())}).`);

    // 2. Late fee: only allowed once rent is 7+ days late, capped (SB21-173). The OWNER decides; Landwell only tells the tenant.
    const feeDay = new Date(dueMs + CO.lateFee.minDaysLate * DAY).toISOString();
    let paid = await ctx.waitFor('charge.paid', { chargeId }, { timeoutMs: Math.max(0, Date.parse(feeDay) - (await ctx.now()).getTime()), label: 'Waiting for the owner to mark rent received' });
    if (paid) return { outcome: 'paid_before_fee' };
    if (rules.lateFee > 0) {
      const fee = cappedLateFee(rules.lateFee, balance());
      const f = await ctx.approval({
        kind: 'late_fee',
        title: `Late fee for ${address}: up to ${money(fee)}`,
        body: `Rent is now ${CO.lateFee.minDaysLate} days late. Your lease's late fee, capped by Colorado law (greater of $50 or 5% of past-due rent), is ${money(fee)}. If you apply it, I'll tell the tenant; they pay it to you, not us.`,
        options: ['notify_fee', 'skip_fee'],
        data: { chargeId, fee },
      });
      if (isPaid()) return { outcome: 'paid_before_fee' };
      if (f?.decision === 'notify_fee') {
        await ctx.step('late-fee', () => store.insert('charges', { ownerId, leaseId: lease.id, kind: 'late_fee', amount: fee, dueDate: feeDay.slice(0, 10), paid: 0, status: 'open', period: charge.period, notices: [] }));
        for (const t of tenants) await noticeTenant(ctx, `fee:${t.id}`, t, `Rent for ${address} is now ${CO.lateFee.minDaysLate} days late, so a late fee of ${money(fee)} applies under your lease. Total due to your landlord: ${money(balance() + fee)}. ${howToPay}`);
        await ctx.log('rent.late-fee', `Owner chose to apply a ${money(fee)} late fee for ${address} (Colorado-capped). Tenant notified.`, { actor: 'owner' });
      }
    }

    // 3. Day 12: owner decides what happens next. "Keep waiting" asks again a week later (up to 3 times). Landwell never files anything.
    for (let round = 0; round < 3; round++) {
      paid = await ctx.waitFor('charge.paid', { chargeId }, { timeoutMs: (round ? 7 : 5) * DAY, label: 'Waiting for the owner to mark rent received' });
      if (paid) return { outcome: round ? 'paid_while_waiting' : 'paid_after_fee' };
      const a = await ctx.approval({
        kind: 'late_rent_next_step',
        title: `Rent still unpaid: ${address} (${money(balance())})`,
        body: `Rent was due ${niceDate(charge.dueDate)}. You can send a formal ${CO.nonpaymentDemandDays}-day demand for payment (I draft it, you have it delivered properly), offer a payment plan, or keep waiting. Consider talking to an attorney before any eviction step.`,
        options: ['send_demand_notice', 'offer_payment_plan', 'keep_waiting'],
        data: { chargeId },
      });
      if (isPaid()) return { outcome: 'paid' };
      await ctx.log(`rent.late-decision-${round}`, `Owner chose: ${a?.decision ?? 'no decision'}.`, { actor: 'owner' });
      if (a?.decision === 'send_demand_notice') {
        for (const t of tenants) await noticeTenant(ctx, `demand:${t.id}`, t, `NOTICE: Rent of ${money(balance())} for ${address} was due on ${niceDate(charge.dueDate)} and remains unpaid. Please pay your landlord the full amount within ${CO.nonpaymentDemandDays} days. ${howToPay} A formal written notice will also be delivered as Colorado law requires. Questions? Reply here.`);
        await ctx.step('demand-task', () => store.insert('tasks', { ownerId, title: `Deliver written ${CO.nonpaymentDemandDays}-day demand: ${address}`, detail: 'Colorado requires the written demand to be delivered properly (posted/served). Use your attorney or the state form; this software does not serve notices.', status: 'open' }));
        return { outcome: 'send_demand_notice' };
      }
      if (a?.decision === 'offer_payment_plan') {
        // The tenant's next message goes straight to the owner.
        for (const t of tenants) await ctx.step(`plan-flag:${t.id}`, () => store.kvSet('paymentPlan', t.id, { chargeId, at: ctx.svc.clock.now().toISOString() }));
        for (const t of tenants) await noticeTenant(ctx, `plan:${t.id}`, t, `Hi ${firstName(t.name)}, your landlord is open to a payment plan for the ${money(balance())} balance. Reply with what you can pay and when, and I'll pass it straight to them.`);
        return { outcome: 'offer_payment_plan' };
      }
      if (a?.decision !== 'keep_waiting') return { outcome: 'no_decision' };
    }
    return { outcome: 'keep_waiting' };
  },
};
