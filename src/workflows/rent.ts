// RENT: a daily sweep creates each month's rent charge, sends the pay link and
// reminders, and flags late rent. Payments arrive by webhook (payment.received).
// Late rent follows Colorado's late-fee rules and never files anything: a
// formal demand only goes out if the owner approves it.

import type { WorkflowDef } from '../engine/engine.ts';
import type { Services } from '../services.ts';
import type { Charge } from '../domain/types.ts';
import { addDays, daysBetween } from '../engine/clock.ts';
import { CO, cappedLateFee } from '../config/colorado.ts';
import { DAY } from '../engine/clock.ts';
import { money, ordinal, propertyName, tellOwner, tellTenant } from './lib.ts';

function dueDateFor(localDate: string, dueDay: number): { period: string; due: string } {
  // The charge for the upcoming due date: if we're past this month's due day + 20, look at next month.
  const [y, m, d] = localDate.split('-').map(Number);
  let yy = y, mm = m;
  if (d > dueDay + 20) { mm += 1; if (mm > 12) { mm = 1; yy += 1; } }
  const period = `${yy}-${String(mm).padStart(2, '0')}`;
  return { period, due: `${period}-${String(dueDay).padStart(2, '0')}` };
}

export const rentCycle: WorkflowDef<Services, { localDate: string }> = {
  name: 'rent-cycle',
  title: 'Daily rent check',
  description: 'Creates monthly rent charges, sends pay links and reminders, and flags late rent.',
  trigger: { schedule: { every: 'day', at: '06:00' } },

  async run(ctx, { localDate }) {
    const store = ctx.store;
    const svc = ctx.svc;
    const leases = store.list('leases', (l) => l.status === 'active' && l.startDate <= addDays(localDate, 6) && l.endDate >= localDate);
    let created = 0, reminded = 0, late = 0;

    for (const lease of leases) {
      const rules = store.get('rules', lease.ownerId);
      if (!rules) continue;
      const { period, due } = dueDateFor(localDate, rules.rentDueDay);
      if (due < lease.startDate || due > lease.endDate) continue;
      const tenants = lease.tenantIds.map((id) => store.get('tenants', id)!).filter(Boolean);
      const daysToDue = daysBetween(localDate, due);
      let charge = store.find('charges', (c) => c.leaseId === lease.id && c.kind === 'rent' && c.period === period);

      // 5 days before: create the charge and send the link.
      if (!charge && daysToDue <= 5 && daysToDue >= -2) {
        charge = await ctx.step(`charge:${lease.id}:${period}`, async () => {
          const c = store.insert('charges', { ownerId: lease.ownerId, leaseId: lease.id, kind: 'rent', amount: lease.rent, dueDate: due, paid: 0, status: 'open', period, notices: [] });
          const link = await svc.adapters.payments.createPaymentLink({ chargeId: c.id, amount: c.amount, description: `Rent ${period} · ${propertyName(store, lease.propertyId)}`, tenantEmail: tenants[0]?.email });
          return store.update('charges', c.id, { payUrl: link.url });
        });
        created++;
        for (const t of tenants) {
          await tellTenant(ctx, `upcoming:${charge.id}:${t.id}`, t, t.autopay
            ? `Heads up: autopay will pay your rent of ${money(lease.rent)} on the ${ordinal(rules.rentDueDay)}.`
            : `Your rent of ${money(lease.rent)} is due on the ${ordinal(rules.rentDueDay)}. Pay by free bank transfer here: ${charge.payUrl}`);
        }
      }
      if (!charge || charge.status !== 'open') continue;

      // Due date: reminder for anyone not on autopay.
      if (daysToDue === 0 && !charge.notices.includes('due') && !tenants.every((t) => t.autopay)) {
        await ctx.step(`due:${charge.id}`, () => store.update('charges', charge!.id, { notices: [...charge!.notices, 'due'] }));
        for (const t of tenants) await tellTenant(ctx, `due:${charge.id}:${t.id}`, t, `Friendly reminder: rent of ${money(charge.amount - charge.paid)} is due today. Pay here: ${charge.payUrl}`);
        reminded++;
      }
      // After the grace period: hand off to the late-rent workflow (once).
      if (-daysToDue > rules.graceDays && !charge.notices.includes('late')) {
        await ctx.step(`late:${charge.id}`, () => store.update('charges', charge!.id, { notices: [...charge!.notices, 'late'] }));
        await ctx.emit(`rent.late`, { ownerId: lease.ownerId, chargeId: charge.id });
        late++;
      }
    }
    await ctx.log('rent.sweep', `Rent check ${localDate}: ${created} charges created, ${reminded} reminders, ${late} late.`);
    return { created, reminded, late };
  },
};

export const paymentReceived: WorkflowDef<Services, { chargeId: string; amount: number; method: 'ach' | 'card' | 'other'; providerRef?: string }> = {
  name: 'payment-received',
  title: 'Payment received',
  description: 'Records a rent payment, sends a receipt and stops late notices.',
  trigger: { event: 'payment.received', dedupeKey: (p) => p.providerRef ?? `${p.chargeId}:${p.amount}` },

  async run(ctx, p) {
    const store = ctx.store;
    const charge = store.get('charges', p.chargeId);
    if (!charge) throw new Error(`charge ${p.chargeId} not found`);
    ctx.setOwner(charge.ownerId);
    const lease = store.get('leases', charge.leaseId)!;
    await ctx.step('payment', () => store.insert('payments', { ownerId: charge.ownerId, leaseId: lease.id, chargeId: charge.id, amount: p.amount, method: p.method, providerRef: p.providerRef, receivedAt: ctx.svc.clock.now().toISOString() }));
    const paid = charge.paid + p.amount;
    const updated: Charge = await ctx.step('charge', () => store.update('charges', charge.id, { paid, status: paid >= charge.amount ? 'paid' : 'open' }));
    for (const id of lease.tenantIds) {
      const t = store.get('tenants', id);
      if (t) await tellTenant(ctx, `receipt:${id}`, t, `Payment received: ${money(p.amount)}. Thank you!${updated.status === 'open' ? ` Remaining balance: ${money(updated.amount - updated.paid)}.` : ''}`);
    }
    if (updated.status === 'paid') await ctx.emit('charge.paid', { chargeId: charge.id });
    await ctx.log('rent.paid', `${money(p.amount)} received for ${propertyName(store, lease.propertyId)} (${charge.period ?? charge.kind}).`, { actor: 'tenant' });
    return { status: updated.status };
  },
};

export const lateRent: WorkflowDef<Services, { ownerId: string; chargeId: string }> = {
  name: 'late-rent',
  title: 'Late rent',
  description: 'Friendly reminders, a Colorado-capped late fee, and an owner decision before any formal notice.',
  trigger: { event: 'rent.late', dedupeKey: (p) => p.chargeId },

  async run(ctx, { ownerId, chargeId }) {
    const store = ctx.store;
    ctx.setOwner(ownerId);
    const charge = store.get('charges', chargeId)!;
    const lease = store.get('leases', charge.leaseId)!;
    const rules = store.get('rules', ownerId)!;
    const tenants = lease.tenantIds.map((id) => store.get('tenants', id)!).filter(Boolean);
    const address = propertyName(store, lease.propertyId);
    const dueMs = Date.parse(charge.dueDate + 'T12:00:00Z');
    const balance = () => { const c = store.get('charges', chargeId)!; return c.amount - c.paid; };

    for (const t of tenants) await tellTenant(ctx, `late1:${t.id}`, t, `Hi ${t.name.split(' ')[0]}, our records show rent of ${money(balance())} for ${address} hasn't come in yet. Pay here: ${charge.payUrl ?? 'in your tenant app'}. If you've already paid, thank you and please ignore this.`);
    await tellOwner(ctx, 'late-owner', ownerId, `Rent for ${address} (${money(balance())}) is past the grace period. We've sent a friendly reminder.`);

    // Late fee: only once rent is 7+ days late, capped (SB21-173).
    const feeDay = new Date(dueMs + CO.lateFee.minDaysLate * DAY).toISOString();
    let paid = await ctx.waitFor('charge.paid', { chargeId }, { timeoutMs: Math.max(0, Date.parse(feeDay) - (await ctx.now()).getTime()), label: 'Waiting for payment (late fee eligibility)' });
    if (paid) return { outcome: 'paid_before_fee' };
    if (rules.lateFee > 0) {
      const fee = cappedLateFee(rules.lateFee, balance());
      await ctx.step('late-fee', () => store.insert('charges', { ownerId, leaseId: lease.id, kind: 'late_fee', amount: fee, dueDate: (feeDay).slice(0, 10), paid: 0, status: 'open', period: charge.period, notices: [] }));
      for (const t of tenants) await tellTenant(ctx, `fee:${t.id}`, t, `Rent for ${address} is now 7 days late, so a late fee of ${money(fee)} has been added as your lease allows. Balance: ${money(balance() + fee)}. Pay here: ${charge.payUrl ?? 'in your tenant app'}.`);
      await ctx.log('rent.late-fee', `Late fee ${money(fee)} added for ${address} (capped by Colorado law).`);
    }

    // Day 12: owner decides what happens next. Landwell never files anything.
    paid = await ctx.waitFor('charge.paid', { chargeId }, { timeoutMs: 5 * DAY, label: 'Waiting for payment' });
    if (paid) return { outcome: 'paid_after_fee' };
    const a = await ctx.approval({
      kind: 'late_rent_next_step',
      title: `Rent still unpaid: ${address} (${money(balance())})`,
      body: `Rent was due ${charge.dueDate}. Choose: send a formal ${CO.nonpaymentDemandDays}-day demand for payment (we prepare it, you approve it), offer a payment plan, or keep waiting. Consider talking to an attorney before any eviction step.`,
      options: ['send_demand_notice', 'offer_payment_plan', 'keep_waiting'],
      data: { chargeId },
    });
    if (a?.decision === 'send_demand_notice') {
      for (const t of tenants) await tellTenant(ctx, `demand:${t.id}`, t, `NOTICE: Rent of ${money(balance())} for ${address} was due on ${charge.dueDate} and remains unpaid. Please pay the full amount within ${CO.nonpaymentDemandDays} days: ${charge.payUrl ?? 'in your tenant app'}. A formal written notice will also be delivered as Colorado law requires. Questions? Reply here.`);
      await ctx.step('demand-task', () => store.insert('tasks', { ownerId, title: `Deliver written ${CO.nonpaymentDemandDays}-day demand: ${address}`, detail: 'Colorado requires the written demand to be delivered properly (posted/served). Use your attorney or the state form; this software does not serve notices.', status: 'open' }));
    } else if (a?.decision === 'offer_payment_plan') {
      for (const t of tenants) await tellTenant(ctx, `plan:${t.id}`, t, `The owner is open to a payment plan for the ${money(balance())} balance. Reply with what you can pay and when, and we'll pass it along.`);
    }
    await ctx.log('rent.late-decision', `Owner chose: ${a?.decision ?? 'no decision'}.`, { actor: 'owner' });
    return { outcome: a?.decision ?? 'no_decision' };
  },
};
