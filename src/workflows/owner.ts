// OWNER-FACING: Monday report, onboarding checklist, and how approvals reach
// the owner's phone.

import type { WorkflowDef } from '../engine/engine.ts';
import type { Services } from '../services.ts';
import type { Approval } from '../domain/types.ts';
import { randomInt } from 'node:crypto';
import { DAY, addDays } from '../engine/clock.ts';
import { addressKey, clip, money, niceDate, tellOwner } from './lib.ts';

export const weeklyReport: WorkflowDef<Services, { localDate: string }> = {
  name: 'weekly-report',
  title: 'Monday owner report',
  description: 'Every Monday at 7 AM: rent you marked received, repairs, messages handled and anything waiting on you.',
  trigger: { schedule: { every: 'week', weekday: 1, at: '07:00' } },
  async run(ctx, { localDate }) {
    const store = ctx.store;
    const since = new Date((await ctx.now()).getTime() - 7 * DAY).toISOString();
    const owners = store.list('owners', (o) => o.billing?.status !== 'canceled');
    for (const o of owners) {
      const audit = store.list('audit', (a) => a.ownerId === o.id && a.at >= since);
      const paid = store.list('payments', (p) => p.ownerId === o.id && p.receivedAt >= since && (!p.chargeId || store.get('charges', p.chargeId)?.kind !== 'deposit')).reduce((s, p) => s + p.amount, 0);
      const opened = store.list('workOrders', (w) => w.ownerId === o.id && w.createdAt >= since).length;
      const closed = audit.filter((a) => a.action === 'repair.closed').length;
      const selfFixed = audit.filter((a) => a.action === 'repair.self-fixed').length;
      const msgs = audit.filter((a) => a.action === 'message.answered').length;
      const pending = store.list('approvals', (a) => a.ownerId === o.id && a.status === 'pending');
      const tasks = store.list('tasks', (t) => t.ownerId === o.id && t.status === 'open');
      const lines = [
        `${ctx.svc.brand.name} weekly report, ${niceDate(addDays(localDate, -7))} to ${niceDate(localDate)}:`,
        `• Rent you marked received: ${money(paid)}`,
        `• Repairs: ${opened} new, ${closed} finished${selfFixed ? `, ${selfFixed} fixed by the tenant with our help` : ''}`,
        `• Messages answered for you: ${msgs}`,
      ];
      if (pending.length) lines.push(`Waiting on you: ${pending.slice(0, 3).map((a) => `${a.title}${a.code ? ` (code ${a.code})` : ''}`).join('; ')}${pending.length > 3 ? ` and ${pending.length - 3} more` : ''}.`);
      if (tasks.length) lines.push(`To-dos: ${tasks.length}, starting with "${tasks[0].title}".`);
      if (!pending.length && !tasks.length) lines.push('Nothing needs you right now. Enjoy your week!');
      await tellOwner(ctx, `report:${o.id}`, o.id, lines.join('\n'));
    }
    return { owners: owners.length };
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

/** Plain words for each decision, used in texts and confirmations. */
const LABELS: Record<string, string> = {
  approve: 'Approve', decline: 'Decline', deny: 'Deny', dispute: 'Dispute the invoice',
  received: 'Yes, it arrived', not_received: "No, it hasn't",
  notify_fee: 'Apply the late fee', skip_fee: 'Skip the fee',
  send_demand_notice: 'Send the 10-day demand', offer_payment_plan: 'Offer a payment plan', keep_waiting: 'Keep waiting',
  offer_renewal: 'Offer the renewal', do_not_renew: "Don't renew",
  i_will_arrange_it: "I'll arrange it", cancel_request: 'Cancel the request',
  return_full: 'Return the full deposit', deductions_entered: 'Take deductions',
  publish: 'Publish it', not_now: 'Not now', confirm: 'Confirm', send: 'Send it', cancel: 'Cancel',
  exempt_tenancy_confirmed_by_attorney: 'Exempt (my attorney confirmed)',
};
export function optionLabel(option: string): string {
  const s = LABELS[option] ?? option.replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Letter, digit, letter (like "K4P"): never a real word, and unique among decisions still open. */
export function newApprovalCode(store: Services['store']): string {
  const L = 'ABCDEFGHJKMNPQRSTUVWXYZ';
  const D = '23456789';
  const taken = new Set(store.list('approvals', (a) => a.status === 'pending').map((a) => a.code));
  let code = '';
  for (let i = 0; i < 500 && (!code || taken.has(code)); i++) code = L[randomInt(L.length)] + D[randomInt(D.length)] + L[randomInt(L.length)];
  return code;
}

/** How to answer an approval by text: "Reply YES K4P (Approve) or NO K4P (Decline)." */
export function replyHint(a: Pick<Approval, 'options' | 'code'>): string {
  const code = a.code ?? '';
  if (a.options.length === 2) return `Reply YES ${code} (${optionLabel(a.options[0])}) or NO ${code} (${optionLabel(a.options[1])}).`;
  return `Reply with a number and ${code}: ${a.options.map((o, i) => `${i + 1} ${code} = ${optionLabel(o)}`).join(', ')}.`;
}

/** Called by the engine when an approval is created: text the owner a short code. */
export async function notifyOwnerOfApproval(svc: Services, a: Approval): Promise<void> {
  const owner = svc.store.get('owners', a.ownerId);
  if (!owner) return;
  const code = newApprovalCode(svc.store);
  svc.store.update('approvals', a.id, { code });
  a.code = code;
  svc.store.kvSet('approvalCode', code, a.id);
  const sms = !!owner.phone && owner.consents?.smsConsent !== false;
  const to = sms ? owner.phone : owner.email;
  const channel = sms ? 'sms' : 'email';
  const hint = replyHint({ options: a.options, code });
  const details = clip(a.body.replace(/\n•\s*/g, ' • ').replace(/\n+/g, ' '), Math.max(160, 560 - hint.length - a.title.length));
  const body = `${svc.brand.name}: ${a.title}. ${details}\n${hint}`;
  const r = await svc.adapters.messaging.send({ channel, to, body, subject: channel === 'email' ? `${svc.brand.name}: ${a.title}` : undefined });
  svc.store.insert('messages', { ownerId: owner.id, threadKey: addressKey(to), direction: 'out', channel, to, body, media: [], at: svc.clock.now().toISOString(), meta: { providerId: r.providerId, approvalId: a.id } });
}
