// LEASING: application → screening (licensed partner) → owner decides →
// lease filled from the owner's own template → both sign → move-in.
//
// Fair housing: the software never scores, ranks or recommends applicants.
// It lays the screening report next to the owner's written criteria, the same
// way for everyone, and records the order applications arrived.

import type { WorkflowDef } from '../engine/engine.ts';
import type { Services } from '../services.ts';
import type { Application, ScreeningCriterion, ScreeningReport, Lease } from '../domain/types.ts';
import { DAY } from '../engine/clock.ts';
import { addDays } from '../engine/clock.ts';
import { clip, firstName, money, niceDate, ordinal, noticeTenant, send, contactOf, tellOwner, tellTenant, type C } from './lib.ts';
import { fillTemplate } from '../leases/template.ts';

/* ------------------------------------------------------------------ */
/* Criteria comparison: objective, mechanical, identical for everyone. */
/* ------------------------------------------------------------------ */
export type CriterionResult = { label: string; report: string; met: 'yes' | 'no' | 'unknown' };

export function compareCriteria(criteria: ScreeningCriterion[], r: ScreeningReport | undefined, rent: number): CriterionResult[] {
  return criteria.map((c) => {
    if (!r) return { label: c.label, report: 'No report yet', met: 'unknown' as const };
    switch (c.key) {
      case 'income_multiple': {
        if (r.monthlyIncome === undefined) return { label: c.label, report: 'Not reported', met: 'unknown' as const };
        const need = Number(c.value) * rent;
        return { label: c.label, report: `${money(r.monthlyIncome)}/month`, met: r.monthlyIncome >= need ? 'yes' : 'no' };
      }
      case 'evictions_years':
        return r.evictionsLast ? { label: c.label, report: `${r.evictionsLast.count} in last ${r.evictionsLast.years} years`, met: r.evictionsLast.count === 0 && r.evictionsLast.years >= Number(c.value) ? 'yes' : r.evictionsLast.count > 0 ? 'no' : 'unknown' } : { label: c.label, report: 'Not reported', met: 'unknown' };
      case 'collections_years':
        return r.collectionsLast ? { label: c.label, report: `${r.collectionsLast.count} in last ${r.collectionsLast.years} years`, met: r.collectionsLast.count === 0 && r.collectionsLast.years >= Number(c.value) ? 'yes' : r.collectionsLast.count > 0 ? 'no' : 'unknown' } : { label: c.label, report: 'Not reported', met: 'unknown' };
      case 'references':
        return r.referencesConfirmed === undefined ? { label: c.label, report: 'Not reported', met: 'unknown' } : { label: c.label, report: `${r.referencesConfirmed} confirmed`, met: r.referencesConfirmed >= Number(c.value) ? 'yes' : 'no' };
      case 'pets':
        return { label: c.label, report: r.pets ?? 'None listed', met: 'unknown' };
      default:
        return { label: c.label, report: 'Check the full report', met: 'unknown' };
    }
  });
}

export const application: WorkflowDef<Services, { applicationId: string }> = {
  name: 'application',
  title: 'Rental application',
  description: 'Sends the screening link, lays the report beside the owner\'s criteria, and records the owner\'s decision. No AI scoring.',
  trigger: { event: 'application.submitted', dedupeKey: (p) => p.applicationId },

  async run(ctx, { applicationId }) {
    const store = ctx.store;
    let app: Application = store.get('applications', applicationId)!;
    ctx.setOwner(app.ownerId);
    const prop = store.get('properties', app.propertyId)!;
    const rules = store.get('rules', app.ownerId)!;
    const to = contactOf({ phone: app.phone, email: app.email });
    const tell = async (label: string, body: string) => { if (to) await send(ctx, { label, ownerId: app.ownerId, ...to, body }); };
    const position = store.list('applications', (a) => a.propertyId === app.propertyId && a.submittedAt <= app.submittedAt && a.status !== 'withdrawn').length;

    const invite = await ctx.step('invite', () => ctx.svc.adapters.screening.createInvite({ applicationId, applicantName: app.applicantName, email: app.email, phone: app.phone }));
    app = await ctx.step('status-screening', () => store.update('applications', applicationId, { status: 'screening', screeningUrl: invite.url }));
    await tell('received', `Thanks for applying for ${prop.address}! Next step: complete your screening here: ${invite.url} (you'll authorize it and pay the screening company directly). Every applicant is reviewed against the same written criteria, in the order received.`);
    await ctx.log('application.received', `${app.applicantName} applied for ${prop.address} (#${position} for this home).`, { actor: 'prospect' });

    let rep = await ctx.waitFor<{ report: ScreeningReport }>('screening.completed', { applicationId }, { timeoutMs: 3 * DAY, label: 'Waiting for the applicant to finish screening' });
    if (!rep) {
      await tell('screen-reminder', `Reminder: your screening for ${prop.address} isn't finished yet: ${invite.url}`);
      rep = await ctx.waitFor('screening.completed', { applicationId }, { timeoutMs: 4 * DAY, label: 'Waiting for the applicant to finish screening' });
      if (!rep) {
        await ctx.step('withdraw', () => store.update('applications', applicationId, { status: 'withdrawn' }));
        return { status: 'withdrawn' };
      }
    }
    app = await ctx.step('status-ready', () => store.update('applications', applicationId, { status: 'ready_for_owner', report: rep!.report }));
    await tell('screened', `Thanks, ${firstName(app.applicantName)}: your screening for ${prop.address} is complete. The owner reviews every application against the same written criteria, and you'll hear back here.`);

    const rows = compareCriteria(rules.screeningCriteria, rep.report, prop.rent);
    const table = rows.map((r) => `• ${r.label}: ${r.report} (${r.met === 'yes' ? 'meets' : r.met === 'no' ? 'does not meet' : 'review'})`).join('\n');
    const a = await ctx.approval({
      kind: 'application',
      title: `Application: ${app.applicantName} for ${prop.address}`,
      body: `Applicant #${position} for this home. Your criteria vs. the screening report:\n${table}\nThe decision is yours. Apply the same criteria to every applicant.`,
      options: ['approve', 'deny'],
      data: { applicationId, criteria: rows, reportUrl: rep.report.reportUrl },
    });

    if (a?.decision === 'approve') {
      await ctx.step('approved', () => store.update('applications', applicationId, { status: 'approved', decision: 'approved' }));
      await tell('approved', `Good news: your application for ${prop.address} was approved! Your lease is being prepared and will arrive for e-signature shortly.`);
      const start = (a.data.startDate as string) ?? addDays(ctx.svc.clock.now().toISOString().slice(0, 10), 14);
      await ctx.emit('lease.requested', { ownerId: app.ownerId, propertyId: prop.id, applicationId, tenantName: app.applicantName, tenantEmail: app.email, tenantPhone: app.phone, startDate: start, months: Number(a.data.months ?? 12), rent: prop.rent, deposit: prop.deposit });
      return { status: 'approved' };
    }
    if (a?.decision === 'deny') {
      await ctx.step('denied', () => store.update('applications', applicationId, { status: 'denied', decision: 'denied' }));
      // FCRA adverse-action notice (required when a consumer report was used).
      await tell('adverse-action', `Thank you for applying for ${prop.address}. We're unable to approve your application at this time. This decision was based in whole or in part on information in a consumer report from: ${rep.report.agencyContact}. That company did not make this decision and cannot explain why it was made. You have the right to a free copy of your report from them within 60 days, and to dispute any inaccurate or incomplete information with them.`);
      return { status: 'denied' };
    }
    return { status: 'no_decision' };
  },
};

/* ------------------------------------------------------------------ */
/* Lease: fill → sign → activate → move-in.                            */
/* ------------------------------------------------------------------ */
export interface LeaseRequest {
  ownerId: string;
  propertyId: string;
  applicationId?: string;
  renewalOf?: string;
  tenantIds?: string[]; // renewals: existing tenants
  tenantName?: string;
  tenantEmail?: string;
  tenantPhone?: string;
  startDate: string;
  months: number;
  rent: number;
  deposit: number;
}

export const leaseFlow: WorkflowDef<Services, LeaseRequest> = {
  name: 'lease',
  title: 'Lease and move-in',
  description: 'Fills the owner\'s uploaded lease, collects both signatures, reminds everyone about the deposit and first month (paid to the owner), and runs move-in messages.',
  trigger: { event: 'lease.requested' },

  async run(ctx, req) {
    const store = ctx.store;
    ctx.setOwner(req.ownerId);
    const owner = store.get('owners', req.ownerId)!;
    const rules = store.get('rules', req.ownerId)!;
    const prop = store.get('properties', req.propertyId)!;

    // Colorado: one rent increase per 12 months.
    if (req.renewalOf) {
      const prev = store.get('leases', req.renewalOf)!;
      if (req.rent > prev.rent && prev.lastRentIncreaseAt && Date.parse(prev.lastRentIncreaseAt) > Date.parse(req.startDate + 'T12:00:00Z') - 365 * DAY) {
        await tellOwner(ctx, 'increase-blocked', req.ownerId, `Can't raise rent on ${prop.address} for a lease starting ${niceDate(req.startDate)}: Colorado allows one increase per 12 months and the last was ${niceDate(prev.lastRentIncreaseAt.slice(0, 10))}. The renewal will use the current rent unless you change it.`);
        req = { ...req, rent: prev.rent };
      }
    }

    // Tenant records (new lease → create them as "future").
    const tenantIds: string[] = req.tenantIds ?? (await ctx.step('tenant', () => [
      store.insert('tenants', { ownerId: req.ownerId, propertyId: prop.id, name: req.tenantName ?? 'Tenant', email: req.tenantEmail, phone: req.tenantPhone, preferredChannel: req.tenantPhone ? 'sms' : 'email', autopay: false, status: 'future' }).id,
    ]));
    const tenants = tenantIds.map((id) => store.get('tenants', id)!);

    // The owner's template. If none yet, ask for it and wait.
    let tpl = store.list('leaseTemplates', (t) => t.ownerId === req.ownerId).sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt))[0];
    if (!tpl) {
      await tellOwner(ctx, 'need-template', req.ownerId, `To send a lease for ${prop.address}, upload your lease once in the app (Leases → Upload). We'll fill it in for every tenant after that.`);
      await ctx.waitFor('template.uploaded', { ownerId: req.ownerId }, { label: 'Waiting for you to upload your lease' });
      tpl = store.list('leaseTemplates', (t) => t.ownerId === req.ownerId).sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt))[0];
    }

    const end = (() => { const d = new Date(req.startDate + 'T12:00:00Z'); d.setUTCMonth(d.getUTCMonth() + req.months); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); })();
    const values: Record<string, string | undefined> = {
      tenant_names: tenants.map((t) => t.name).join(' and '),
      owner_name: owner.name,
      property_address: `${prop.address}, ${prop.city}, ${prop.state} ${prop.zip}`,
      start_date: req.startDate,
      end_date: end,
      term_months: String(req.months),
      monthly_rent: money(req.rent),
      security_deposit: money(req.deposit),
      rent_due_day: ordinal(rules.rentDueDay),
      late_fee: money(rules.lateFee),
      pet_terms: rules.petPolicy,
      utilities: prop.facts.Utilities,
      today: ctx.svc.clock.now().toISOString().slice(0, 10),
    };
    let filled = fillTemplate(tpl.body, values);

    let lease: Lease = await ctx.step('lease', () =>
      store.insert('leases', { ownerId: req.ownerId, propertyId: prop.id, tenantIds, startDate: req.startDate, endDate: end, rent: req.rent, deposit: req.deposit, depositHeld: 0, templateId: tpl.id, status: 'draft', renewalOf: req.renewalOf, lastRentIncreaseAt: req.renewalOf && req.rent > (store.get('leases', req.renewalOf)?.rent ?? req.rent) ? req.startDate : store.get('leases', req.renewalOf ?? '')?.lastRentIncreaseAt }),
    );

    if (filled.missing.length) {
      // The owner fills the blanks in the app (approval data.values), or sends with blank lines.
      const a = await ctx.approval({ kind: 'lease_fields', title: `Lease needs ${filled.missing.length} detail(s): ${prop.address}`, body: `Your lease has blanks we can't fill automatically: ${filled.missing.map((f) => f.replace(/_/g, ' ')).join(', ')}. Fill them in the app, then send.`, options: ['send', 'cancel'], data: { missing: filled.missing, values: {} } });
      if (a?.decision !== 'send') return { status: 'cancelled' };
      filled = fillTemplate(tpl.body, { ...values, ...((a.data.values as Record<string, string>) ?? {}) });
    }

    const env = await ctx.step('esign', () => ctx.svc.adapters.esign.send({
      documentTitle: `Residential Lease: ${prop.address}`, body: filled.text, refId: lease.id,
      signers: [...tenants.map((t) => ({ name: t.name, email: t.email, phone: t.phone, role: 'tenant' as const })), { name: owner.name, email: owner.email, phone: owner.phone, role: 'owner' as const }],
    }));
    lease = await ctx.step('out-for-signature', () => store.update('leases', lease.id, { status: 'out_for_signature' }));
    const links = ctx.svc.adapters.esign.links(env.envelopeId);
    for (const t of tenants) {
      const l = links.find((x) => x.role === 'tenant' && x.name === t.name);
      await tellTenant(ctx, `sign:${t.id}`, t, `Your lease for ${prop.address} is ready. Please review and sign: ${l?.url ?? env.signUrl}`);
    }

    // Each tenant signs, then the owner.
    for (const t of tenants) {
      let s = await ctx.waitFor('document.signed', { refId: lease.id, role: 'tenant', name: t.name }, { timeoutMs: 3 * DAY, label: `Waiting for ${t.name} to sign` });
      if (!s) {
        await tellTenant(ctx, `sign-remind:${t.id}`, t, `Reminder: your lease for ${prop.address} is waiting for your signature.`);
        s = await ctx.waitFor('document.signed', { refId: lease.id, role: 'tenant', name: t.name }, { timeoutMs: 4 * DAY, label: `Waiting for ${t.name} to sign` });
        if (!s) { await tellOwner(ctx, `sign-stalled:${t.id}`, req.ownerId, `${t.name} hasn't signed the lease for ${prop.address} after a week.`); return { status: 'unsigned' }; }
      }
    }
    const ownerLink = links.find((x) => x.role === 'owner');
    await tellOwner(ctx, 'owner-sign', req.ownerId, `${tenants.map((t) => t.name).join(' and ')} signed the lease for ${prop.address}. Your turn: ${ownerLink?.url}`);
    const signed = await ctx.waitFor('document.signed', { refId: lease.id, role: 'owner' }, { timeoutMs: 2 * DAY, label: 'Waiting for your signature' });
    if (!signed) {
      await tellOwner(ctx, 'owner-sign-remind', req.ownerId, `Reminder: the lease for ${prop.address} is waiting on your signature: ${ownerLink?.url}`);
      await ctx.waitFor('document.signed', { refId: lease.id, role: 'owner' }, { label: 'Waiting for your signature' });
    }

    lease = await ctx.step('active', () => store.update('leases', lease.id, { status: 'active' }));
    await ctx.log('lease.signed', `Lease signed for ${prop.address}: ${money(req.rent)}/month from ${req.startDate} to ${end}.`);

    if (req.renewalOf) {
      for (const t of tenants) await tellTenant(ctx, `renewed:${t.id}`, t, `All set, ${firstName(t.name)}: your renewal for ${prop.address} is signed. Thank you for staying!`);
      await tellOwner(ctx, 'renewed-owner', req.ownerId, `Renewal signed for ${prop.address}: ${money(req.rent)}/month, ${niceDate(req.startDate)} to ${niceDate(end)}.`);
      return { status: 'renewed', leaseId: lease.id };
    }

    // New tenancy: deposit + first month are paid to the OWNER directly (Landwell never
    // handles money). We record what's due so the owner can mark it received.
    const charges = await ctx.step('move-in-charges', () =>
      ([['deposit', req.deposit], ['rent', req.rent]] as const).map(([kind, amount]) =>
        store.insert('charges', { ownerId: req.ownerId, leaseId: lease.id, kind, amount, dueDate: req.startDate, paid: 0, status: 'open', period: kind === 'rent' ? req.startDate.slice(0, 7) : undefined, notices: [] })));
    const howToPay = rules.howToPay || 'Your landlord will tell you how to pay.';
    for (const t of tenants) await tellTenant(ctx, `move-in-pay:${t.id}`, t, `Welcome, ${firstName(t.name)}! Before move-in on ${niceDate(req.startDate)}, your security deposit (${money(req.deposit)}) and first month's rent (${money(req.rent)}) are due to your landlord. ${howToPay}`);
    await ctx.step('move-in-money-task', () => store.insert('tasks', { ownerId: req.ownerId, title: `Collect deposit and first month: ${prop.address}`, detail: `${tenants.map((t) => t.name).join(' and ')} owe a ${money(req.deposit)} security deposit and ${money(req.rent)} first month's rent before ${req.startDate}. Mark each one received in the app when it arrives (charges ${charges.map((c) => c.id).join(', ')}).`, dueAt: req.startDate + 'T17:00:00Z', status: 'open' }));
    await ctx.step('property-leased', () => store.update('properties', prop.id, { status: 'occupied' }));
    await ctx.step('unpublish', () => ctx.svc.adapters.listings.unpublish({ propertyId: prop.id }));
    const others = store.list('applications', (a) => a.propertyId === prop.id && a.id !== req.applicationId && ['submitted', 'screening', 'ready_for_owner'].includes(a.status));
    for (const o of others) {
      const c = contactOf({ phone: o.phone, email: o.email });
      if (c) await send(ctx, { label: `unavailable:${o.id}`, ownerId: req.ownerId, ...c, body: `Thank you for your interest in ${prop.address}. The home has been leased, so your application is closed and no further screening is needed.` });
      await ctx.step(`close:${o.id}`, () => store.update('applications', o.id, { status: 'withdrawn' }));
      // Their decision request is moot now.
      await ctx.step(`close-approval:${o.id}`, () => { for (const a of store.list('approvals', (x) => x.status === 'pending' && x.kind === 'application' && x.data.applicationId === o.id)) store.update('approvals', a.id, { status: 'expired' }); return true; });
    }
    // Prospects who asked about this home (and didn't apply): offer to text them when another home opens up.
    const tenantKeys = new Set(tenants.flatMap((t) => [t.phone, t.email].filter(Boolean) as string[]));
    const since = new Date(ctx.svc.clock.now().getTime() - 60 * DAY).toISOString();
    const askers = store.list('prospects', (p) => p.interestedIn === prop.id && !p.optInUpdates && p.createdAt >= since && !(p.phone && tenantKeys.has(p.phone)) && !(p.email && tenantKeys.has(p.email)) && !others.some((o) => (o.phone && o.phone === p.phone) || (o.email && o.email === p.email)));
    for (const p of askers.slice(0, 50)) {
      const c = contactOf(p);
      if (!c) continue;
      await ctx.step(`updates-ask:${p.id}`, () => store.kvSet('prospectAsk', p.id, { kind: 'updates', until: new Date(ctx.svc.clock.now().getTime() + 14 * DAY).toISOString() }));
      await send(ctx, { label: `leased:${p.id}`, ownerId: req.ownerId, ...c, body: `Thanks for your interest in ${prop.address}. It has been leased. Want a text if another home opens up? Reply YES.` });
    }

    // Move-in: details 2 days before, tenant becomes active on day one.
    await ctx.sleepUntil(new Date(Date.parse(req.startDate + 'T15:00:00Z') - 2 * DAY).toISOString(), 'Waiting until 2 days before move-in');
    const moveIn = rules.facts['Move-in instructions'] ?? 'The owner will send key/code details the day before.';
    for (const t of tenants) await noticeTenant(ctx, `move-in-info:${t.id}`, t, `Move-in is ${niceDate(req.startDate)}! ${moveIn} For repairs, just text this number anytime. Please take photos of each room on day one; they protect your deposit.`);
    const unpaid = store.list('charges', (c) => c.leaseId === lease.id && c.status === 'open').map((c) => `${c.kind === 'deposit' ? 'deposit' : "first month's rent"} (${money(c.amount - c.paid)})`);
    await tellOwner(ctx, 'move-in-owner', req.ownerId, `${tenants.map((t) => t.name).join(' and ')} move${tenants.length > 1 ? '' : 's'} into ${prop.address} ${niceDate(req.startDate)}. Please have keys or the door code ready${rules.facts['Move-in instructions'] ? ' (we told them: "' + clip(rules.facts['Move-in instructions'], 80) + '")' : ''}.${unpaid.length ? ` Still not marked received: ${unpaid.join(' and ')}.` : ''}`);
    await ctx.sleepUntil(req.startDate + 'T07:00:00Z', 'Waiting for move-in day');
    for (const t of tenants) await ctx.step(`tenant-active:${t.id}`, () => store.update('tenants', t.id, { status: 'active' }));
    await ctx.log('lease.move-in', `${tenants.map((t) => t.name).join(' and ')} moved in to ${prop.address}.`);
    return { status: 'moved_in', leaseId: lease.id };
  },
};

export type { C };
