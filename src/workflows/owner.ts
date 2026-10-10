// OWNER-FACING: Monday report, onboarding checklist, and how approvals reach
// the owner's phone.

import type { WorkflowDef } from '../engine/engine.ts';
import type { Services } from '../services.ts';
import type { Approval } from '../domain/types.ts';
import { DAY } from '../engine/clock.ts';
import { addressKey, money, tellOwner } from './lib.ts';

export const weeklyReport: WorkflowDef<Services, { localDate: string }> = {
  name: 'weekly-report',
  title: 'Monday owner report',
  description: 'Every Monday at 7 AM: rent you marked received, repairs, messages handled and anything waiting on you.',
  trigger: { schedule: { every: 'week', weekday: 1, at: '07:00' } },
  async run(ctx, { localDate }) {
    const store = ctx.store;
    const since = new Date((await ctx.now()).getTime() - 7 * DAY).toISOString();
    for (const o of store.list('owners')) {
      const audit = store.list('audit', (a) => a.ownerId === o.id && a.at >= since);
      const paid = store.list('payments', (p) => p.ownerId === o.id && p.receivedAt >= since && (!p.chargeId || store.get('charges', p.chargeId)?.kind !== 'deposit')).reduce((s, p) => s + p.amount, 0);
      const repairs = store.list('workOrders', (w) => w.ownerId === o.id && w.createdAt >= since).length;
      const msgs = audit.filter((a) => a.action === 'message.answered').length;
      const pending = store.list('approvals', (a) => a.ownerId === o.id && a.status === 'pending');
      const tasks = store.list('tasks', (t) => t.ownerId === o.id && t.status === 'open');
      const body = `Your week with ${ctx.svc.brand.name} (to ${localDate}): ${money(paid)} rent marked received, ${repairs} repair${repairs === 1 ? '' : 's'} handled, ${msgs} message${msgs === 1 ? '' : 's'} answered. ${pending.length ? `${pending.length} decision${pending.length > 1 ? 's' : ''} waiting for you.` : 'Nothing waiting on you.'}${tasks.length ? ` ${tasks.length} open to-do${tasks.length > 1 ? 's' : ''}.` : ''}`;
      await tellOwner(ctx, `report:${o.id}`, o.id, body);
    }
    return { owners: store.list('owners').length };
  },
};

export const onboarding: WorkflowDef<Services, { ownerId: string }> = {
  name: 'onboarding',
  title: 'New owner setup',
  description: 'Welcome, a setup checklist, and nudges until homes, lease, tenants and vendors are in.',
  trigger: { event: 'owner.signed_up', dedupeKey: (p) => p.ownerId },
  async run(ctx, { ownerId }) {
    const store = ctx.store;
    ctx.setOwner(ownerId);
    const o = store.get('owners', ownerId)!;
    const checklist = ['Add your homes', 'Upload your lease', 'Add your tenants', 'Add your vendors', 'Set your rules (spending limit, pets, screening criteria)', 'Tell us how tenants pay you (Zelle, check, your bank portal) so reminders say the right thing'];
    await ctx.step('tasks', () => checklist.map((title) => store.insert('tasks', { ownerId, title, detail: 'Setup step', status: 'open' })));
    await tellOwner(ctx, 'welcome', ownerId, `Welcome to ${ctx.svc.brand.name}, ${o.name.split(' ')[0]}! Six quick setup steps are in your app. Most owners finish in under an hour. Reply here anytime if you get stuck.`);
    for (const [i, wait] of [2, 5].entries()) {
      await ctx.sleep(wait * DAY, 'Giving the owner time to finish setup');
      const open = store.list('tasks', (t) => t.ownerId === ownerId && t.detail === 'Setup step' && t.status === 'open');
      if (!open.length) break;
      await tellOwner(ctx, `nudge-${i}`, ownerId, `You're ${checklist.length - open.length} of ${checklist.length} steps in. Next: ${open[0].title}. Once tenants are added, ${ctx.svc.brand.name} starts answering them for you.`);
    }
    return { ok: true };
  },
};

/** Called by the engine when an approval is created: text the owner a short code. */
export async function notifyOwnerOfApproval(svc: Services, a: Approval): Promise<void> {
  const owner = svc.store.get('owners', a.ownerId);
  if (!owner) return;
  const code = a.id.slice(-3).toUpperCase();
  svc.store.kvSet('approvalCode', code, a.id);
  const opts = a.options.length === 2 ? `Reply YES ${code} or NO ${code}` : `Open the app to choose`;
  const body = `${svc.brand.name}: ${a.title}. ${a.body.replace(/\n•\s*/g, ' • ').replace(/\n+/g, ' ').slice(0, 300)} ${opts}, or open ${svc.cfg.publicUrl}/app#approvals`;
  const to = owner.phone || owner.email;
  const channel = owner.phone ? 'sms' : 'email';
  const r = await svc.adapters.messaging.send({ channel, to, body });
  svc.store.insert('messages', { ownerId: owner.id, threadKey: addressKey(to), direction: 'out', channel, to, body, media: [], at: svc.clock.now().toISOString(), meta: { providerId: r.providerId, approvalId: a.id } });
}
