// REPAIRS: request → photo → urgency → vendor → owner OK if over limit →
// scheduled → done → invoice checked → paid → everyone told.
// Colorado SB24-094 response clocks are tracked on every work order.

import type { WorkflowDef } from '../engine/engine.ts';
import type { Services } from '../services.ts';
import type { Urgency, Vendor, WorkOrder } from '../domain/types.ts';
import { CO } from '../config/colorado.ts';
import { HOUR, MIN, DAY } from '../engine/clock.ts';
import { firstName, jobLine, money, propertyName, quietUntil, tellOwner, tellTenant, tellVendor, type C } from './lib.ts';

export interface RepairInput {
  ownerId: string;
  propertyId: string;
  tenantId?: string;
  summary: string;
  trade: string;
  urgency: Urgency;
  photos: string[];
}

const VENDOR_REPLY_WINDOW: Record<Urgency, number> = { emergency: 20 * MIN, urgent: 2 * HOUR, routine: 4 * HOUR };

export const maintenance: WorkflowDef<Services, RepairInput> = {
  name: 'maintenance',
  title: 'Repair request',
  description: 'Triage, vendor booking, owner approval over the spending limit, invoice check, and the expense in the books (owner pays the vendor).',
  trigger: { event: 'maintenance.requested' },

  async run(ctx, input) {
    const store = ctx.store;
    ctx.setOwner(input.ownerId);
    const rules = store.get('rules', input.ownerId)!;
    const address = propertyName(store, input.propertyId);
    const tenant = input.tenantId ? store.get('tenants', input.tenantId) : undefined;
    const ownerFirst = firstName(store.get('owners', input.ownerId)?.name ?? 'the owner');
    const started = await ctx.now();

    // The same problem reported again (a repeat text, or the photo after the fact) joins the open job.
    const same = await ctx.step('duplicate-check', () => (input.urgency === 'emergency' || !tenant ? undefined : sameOpenRepair(store, tenant.id, input, started, started.toISOString())?.id) ?? null);
    if (same) {
      const open = store.get('workOrders', same)!;
      const v = open.vendorId ? store.get('vendors', open.vendorId) : undefined;
      if (input.photos.length) await ctx.step('dup-photos', () => store.update('workOrders', same, { photos: [...open.photos, ...input.photos] }));
      if (v && ['scheduled', 'in_progress'].includes(open.status)) await tellVendor(ctx, 'dup-note', v, `Update from the resident about "${open.summary}" at ${address}: ${input.summary}${input.photos.length ? ` Photo: ${input.photos[0]}` : ''}`);
      if (tenant) await tellTenant(ctx, 'dup', tenant, `That looks like the repair already in progress ("${open.summary}"): ${open.status === 'scheduled' && v ? `booked with ${v.name}${open.scheduledFor ? `, ${open.scheduledFor}` : ''}` : 'we are lining up a pro now'}. I've added your note to it.`);
      await ctx.log('repair.merged', `Same problem reported again; added to ${same}.`, { actor: 'tenant' });
      return { status: 'merged', workOrderId: same };
    }

    let wo: WorkOrder = await ctx.step('create', () =>
      store.insert('workOrders', {
        ownerId: input.ownerId, propertyId: input.propertyId, tenantId: input.tenantId, summary: input.summary, trade: input.trade || 'general',
        urgency: input.urgency, photos: input.photos, status: 'new', createdAt: started.toISOString(),
        respondBy: new Date(started.getTime() + CO.repairStart[input.urgency]).toISOString(),
      }),
    );
    const upd = async (patch: Partial<WorkOrder>, label: string) => {
      wo = await ctx.step(`wo:${label}`, () => store.update('workOrders', wo.id, patch));
    };
    await ctx.log('repair.created', `${wo.id}: ${input.summary} at ${address} (${input.urgency})`, { actor: 'tenant' });

    // 1. Photo for routine jobs (urgent and emergency jobs go straight out; a photo that comes later is forwarded).
    if (!wo.photos.length && input.urgency === 'routine' && tenant) {
      await ctx.step('await-photo-flag', () => store.kvSet('awaitingPhoto', tenant.id, wo.id));
      const photo = await ctx.waitFor<{ photos: string[] }>('maintenance.photo', { workOrderId: wo.id }, { timeoutMs: HOUR, label: 'Waiting for the tenant\'s photo' });
      await ctx.step('clear-photo-flag', () => store.kvDelete('awaitingPhoto', tenant.id));
      if (photo) await upd({ photos: photo.photos }, 'photo');
    }
    await upd({ status: 'triaged' }, 'triaged');

    if (input.urgency === 'emergency') {
      await tellOwner(ctx, 'emergency', input.ownerId, `EMERGENCY at ${address}: ${jobLine(input.summary)}. Contacting your emergency vendor now.${tenant?.phone ? ` ${tenant.name}: ${tenant.phone}.` : ''}`);
    } else {
      // Routine and urgent jobs don't wake vendors up: hold the text until the owner's quiet hours end.
      const until = await ctx.step('vendor-quiet', () => quietUntil(ctx.svc, input.ownerId, ctx.svc.clock.now()));
      if (until) await ctx.sleepUntil(until, 'Waiting until morning to text vendors');
    }

    // 2. Find a vendor. Preferred and trade-matched first; emergency-capable for emergencies.
    // Recorded once, so a vendor added while we wait can't reshuffle the list on replay.
    const candidateIds = await ctx.step('candidates', () => store
      .list('vendors', (v) => v.ownerId === input.ownerId && (v.trades.includes(wo.trade) || v.trades.includes('general')) && (input.urgency !== 'emergency' || v.emergency))
      .sort((a, b) => Number(b.preferred) - Number(a.preferred) || Number(b.trades.includes(wo.trade)) - Number(a.trades.includes(wo.trade)))
      .slice(0, 3)
      .map((v) => v.id));
    // Each vendor keeps its place in the list. The vendor is recorded the moment it's asked, so removing
    // one later (or one that was skipped) never shifts the others: the waits below are numbered in order,
    // and a shift would hand vendor 2's YES to vendor 3, who'd then get the tenant's name and phone.
    let asked = 0;

    let vendor: Vendor | undefined;
    let window: string | undefined;
    let quote: number | undefined;
    for (const [i, id] of candidateIds.entries()) {
      const v = await ctx.step(`vendor-at-${i}`, () => store.get('vendors', id) ?? null);
      if (!v) continue; // removed before we got to it: skipped the same way on every replay
      asked++;
      await upd({ status: 'awaiting_vendor', vendorId: v.id }, `ask-${i}`);
      await ctx.step(`vendor-last-${i}`, () => store.kvSet('vendorLast', v.id, wo.id));
      await tellVendor(ctx, `job-${i}`, v,
        `${input.urgency === 'emergency' ? 'EMERGENCY job' : input.urgency === 'urgent' ? 'Urgent job' : 'New job'} for ${ownerFirst}'s rental (via ${ctx.svc.brand.name}): ${jobLine(wo.summary)} at ${address}.${wo.photos.length ? ` Photo: ${wo.photos[0]}` : ''} Reply YES with your time and estimate (example: "YES Tue 9-11 $140"), or NO.`);
      const r = await ctx.waitFor<{ accept?: boolean; window?: string; quote?: number }>('vendor.replied', { workOrderId: wo.id, vendorId: v.id }, { timeoutMs: VENDOR_REPLY_WINDOW[input.urgency], label: `Waiting for ${v.name} to reply` });
      if (r?.accept) {
        vendor = v;
        window = r.window;
        quote = r.quote;
        break;
      }
      await ctx.log(`repair.vendor-${i}-${r ? 'declined' : 'no-reply'}`, `${v.name} ${r ? 'declined' : 'did not reply in time'}.`, { actor: 'vendor' });
    }

    if (!vendor) {
      if (tenant) await tellTenant(ctx, 'still-looking', tenant, `Quick update on "${wo.summary}": I'm still lining up a pro. ${ownerFirst} is on it and you'll hear back soon.${input.urgency === 'emergency' ? ' If anyone is in danger, call 911.' : ''}`);
      const a = await ctx.approval({
        kind: 'vendor_needed', title: `No vendor available: ${address}`,
        body: `"${wo.summary}". ${asked ? 'Your vendors did not accept in time.' : `You have no ${wo.trade} vendor on file.`} Colorado requires work to start by ${new Date(wo.respondBy).toLocaleString('en-US', { timeZone: ctx.svc.cfg.tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}.`,
        options: ['i_will_arrange_it', 'cancel_request'],
        data: { workOrderId: wo.id },
      });
      if (a?.decision === 'cancel_request') {
        await upd({ status: 'cancelled' }, 'cancel-novendor');
        if (tenant) await tellTenant(ctx, 'cancel', tenant, 'Update on your repair request: the owner will contact you directly about next steps.');
        return { status: 'cancelled' };
      }
      await upd({ status: 'scheduled', scheduledFor: 'arranged by owner' }, 'owner-arranges');
      if (tenant) await tellTenant(ctx, 'owner-arranging', tenant, 'Update: the owner is arranging your repair personally and will be in touch with the time.');
      return { status: 'owner_arranging' };
    }

    // 3. Make sure we have an estimate.
    if (quote === undefined) {
      await tellVendor(ctx, 'ask-estimate', vendor, `Thanks! What's your estimate for "${wo.summary}"? Reply with a dollar amount, e.g. "$150".`);
      const r = await ctx.waitFor<{ quote?: number }>('vendor.replied', { workOrderId: wo.id, vendorId: vendor.id }, { timeoutMs: 2 * HOUR, label: `Waiting for ${vendor.name}'s estimate` });
      quote = r?.quote;
    }
    await upd({ quote, vendorId: vendor.id }, 'quote');

    // 4. Owner approval if over the limit (or no estimate).
    const limit = input.urgency === 'emergency' ? Math.max(rules.emergencySpendLimit ?? 0, rules.repairSpendLimit) : rules.repairSpendLimit;
    if (quote === undefined || quote > limit) {
      await upd({ status: 'awaiting_owner' }, 'awaiting-owner');
      const a = await ctx.approval({
        kind: 'repair_over_limit',
        title: `${quote === undefined ? 'Repair (no estimate)' : `Repair ${money(quote)}`}: ${address}`,
        body: `${vendor.name} can do "${wo.summary}"${window ? ` ${window}` : ''}${quote !== undefined ? ` for ${money(quote)}` : ''}. Your ${input.urgency === 'emergency' ? 'emergency ' : ''}limit is ${money(limit)}.`,
        options: ['approve', 'decline'],
        data: { workOrderId: wo.id, quote },
      });
      if (!a || a.decision === 'decline') {
        await upd({ status: 'cancelled' }, 'declined');
        await tellVendor(ctx, 'vendor-cancel', vendor, `The owner decided not to go ahead with "${wo.summary}" at ${address}. Thanks for the quick reply.`);
        if (tenant) await tellTenant(ctx, 'tenant-declined', tenant, 'Update on your repair: the owner will contact you directly about next steps.');
        return { status: 'declined' };
      }
    }

    // 5. Book it.
    await upd({ status: 'scheduled', scheduledFor: window ?? 'time to be confirmed by vendor' }, 'scheduled');
    await tellVendor(ctx, 'confirm', vendor, `Confirmed: ${jobLine(wo.summary)} at ${address}${window ? `, ${window}` : ''}.${tenant ? ` Resident: ${tenant.name}${tenant.phone ? ` ${tenant.phone}` : ''}.` : ''} Text "DONE $amount" when finished.`);
    if (tenant) await tellTenant(ctx, 'tenant-scheduled', tenant, `Your repair is booked with ${vendor.name}${window ? ` (${window})` : ''}.${vendor.phone ? ` If you need to reach them: ${vendor.phone}.` : ''} Text me here if anything changes.`);
    await ctx.log('repair.scheduled', `${vendor.name} booked${window ? ` for ${window}` : ''}${quote !== undefined ? ` at ${money(quote)}` : ''}.`);

    // 6. Wait for "done" (nudge after 7 days, give up waiting after 14).
    let done = await ctx.waitFor<{ invoice?: number; photos?: string[] }>('vendor.replied', { workOrderId: wo.id, vendorId: vendor.id, done: true }, { timeoutMs: 7 * DAY, label: `Waiting for ${vendor.name} to finish` });
    if (!done) {
      await tellVendor(ctx, 'nudge', vendor, `Checking in on "${wo.summary}" at ${address}. Reply "DONE $amount" when it's finished, or let us know the new date.`);
      await tellOwner(ctx, 'nudge-owner', input.ownerId, `Heads up: ${vendor.name} hasn't marked "${wo.summary}" at ${address} done after a week. We've nudged them.`);
      done = await ctx.waitFor('vendor.replied', { workOrderId: wo.id, vendorId: vendor.id, done: true }, { timeoutMs: 7 * DAY, label: `Waiting for ${vendor.name} to finish` });
      if (!done) {
        await ctx.step('stalled-task', () => store.insert('tasks', { ownerId: input.ownerId, title: `Repair stalled: ${address}`, detail: `${vendor!.name} has not confirmed "${wo.summary}" after 2 weeks.`, status: 'open' }));
        return { status: 'stalled' };
      }
    }
    const invoice = done.invoice ?? quote;
    await upd({ status: 'invoice_review', invoice, photos: [...wo.photos, ...(done.photos ?? [])] }, 'invoice');

    // 7. Invoice check: within 10% (or $25) of the quote passes automatically.
    if (invoice === undefined || (quote !== undefined && invoice > Math.max(quote * 1.1, quote + 2500)) || (quote === undefined && invoice > rules.repairSpendLimit)) {
      const a = await ctx.approval({
        kind: 'invoice_review', title: `Invoice ${money(invoice)} for ${address}`,
        body: `${vendor.name} invoiced ${money(invoice)} for "${wo.summary}"${quote !== undefined ? ` (quote was ${money(quote)})` : ''}.`,
        options: ['approve', 'dispute'], data: { workOrderId: wo.id },
      });
      if (!a || a.decision === 'dispute') {
        await ctx.step('dispute-task', () => store.insert('tasks', { ownerId: input.ownerId, title: `Invoice dispute: ${vendor!.name}`, detail: `"${wo.summary}" at ${address}: invoiced ${money(invoice)}, quoted ${money(quote)}.`, status: 'open' }));
        return { status: 'disputed' };
      }
    }

    // 8. Record it. The owner pays the vendor directly; KeyHelm never moves money.
    await ctx.step('expense', () => store.insert('expenses', { ownerId: input.ownerId, propertyId: input.propertyId, category: 'repairs', amount: invoice ?? 0, vendorId: vendor!.id, workOrderId: wo.id, date: ctx.svc.clock.now().toISOString().slice(0, 10), memo: `${vendor!.name}: ${wo.summary}` }));
    await upd({ status: 'paid' }, 'paid');
    await tellOwner(ctx, 'owner-done', input.ownerId, `Repair done at ${address}: ${jobLine(wo.summary)} by ${vendor.name}, ${money(invoice)}. Please pay ${vendor.name} directly; it's already in your books.`);
    if (tenant) await tellTenant(ctx, 'tenant-done', tenant, `${vendor.name} marked your repair done${jobLine(wo.summary) === wo.summary ? ` ("${wo.summary}")` : ''}. If anything still isn't right, just reply here.`);
    await ctx.log('repair.closed', `${wo.id} closed: ${money(invoice)} to ${vendor.name}.`);
    return { status: 'paid', invoice };
  },
};

/** An open repair for the same tenant that this request most likely repeats (same trade, similar words, last 3 days). */
export function sameOpenRepair(store: C['store'], tenantId: string, input: Pick<RepairInput, 'summary' | 'trade'>, now: Date, exceptCreatedAt?: string): WorkOrder | undefined {
  const words = (t: string) => new Set(t.toLowerCase().match(/[a-z]{4,}/g)?.filter((w) => !STOP_WORDS.has(w)) ?? []);
  const mine = words(input.summary);
  return store.list('workOrders', (w) => w.tenantId === tenantId && w.trade === input.trade && w.createdAt !== exceptCreatedAt && !['paid', 'cancelled', 'completed'].includes(w.status) && now.getTime() - Date.parse(w.createdAt) < 3 * DAY)
    .find((w) => {
      const theirs = words(w.summary);
      const rooms = (x: Set<string>) => [...x].filter((r) => ROOMS.has(r));
      if (rooms(mine).length && rooms(theirs).length && !rooms(mine).some((r) => theirs.has(r))) return false;
      const shared = [...mine].filter((x) => theirs.has(x)).length;
      return shared >= 2 || (shared === 1 && Math.min(mine.size, theirs.size) === 1);
    });
}
const ROOMS = new Set(['kitchen', 'bathroom', 'bath', 'bedroom', 'basement', 'garage', 'upstairs', 'downstairs', 'laundry', 'living', 'master', 'hall', 'hallway', 'patio', 'yard', 'front', 'back']);
const STOP_WORDS = new Set(['the', 'this', 'that', 'with', 'from', 'have', 'again', 'still', 'just', 'there', 'it\'s', 'isnt', 'wont', 'doesnt', 'working', 'broken', 'please', 'thanks', 'resident', 'reports']);

export type { C };
