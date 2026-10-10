// SHOWINGS and LISTINGS.
//
// Self-showing: prospect asks → ID check link → picks one of 3 times →
// one-time lock code 15 min before → code revoked after → feedback + apply link.
// Listing: fair-housing-checked ad copy with all-in rent → owner approves →
// published → past prospects who opted in hear about it.

import type { WorkflowDef } from '../engine/engine.ts';
import type { Services } from '../services.ts';
import type { Showing } from '../domain/types.ts';
import { HOUR, MIN, DAY, localParts } from '../engine/clock.ts';
import { checkAdCopy } from '../ai/guardrails.ts';
import { contactOf, hourLabel, money, send, tellOwner } from './lib.ts';

function fmt(iso: string, tz: string): string {
  return new Date(iso).toLocaleString('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function nextSlots(fromIso: string, tz: string, hours: { start: string; end: string }, count = 3): string[] {
  const out: string[] = [];
  let t = Math.ceil((Date.parse(fromIso) + 3 * HOUR) / HOUR) * HOUR;
  const startH = Number(hours.start.slice(0, 2));
  const endH = Number(hours.end.slice(0, 2));
  for (let i = 0; i < 24 * 7 && out.length < count; i++, t += HOUR) {
    const lp = localParts(new Date(t), tz);
    if (lp.hour < startH || lp.hour >= endH) continue;
    if (out.length && t - Date.parse(out[out.length - 1]) < 3 * HOUR) continue;
    out.push(new Date(t).toISOString());
  }
  return out;
}

export const showing: WorkflowDef<Services, { ownerId: string; propertyId: string; prospectId: string; preferredTimes: string[] }> = {
  name: 'showing',
  title: 'Showing',
  description: 'Self-guided tours with ID check and one-time door codes, or owner-led showings on the owner\'s calendar.',
  trigger: { event: 'showing.requested' },

  async run(ctx, input) {
    const store = ctx.store;
    const svc = ctx.svc;
    ctx.setOwner(input.ownerId);
    const prop = store.get('properties', input.propertyId)!;
    const rules = store.get('rules', input.ownerId)!;
    const prospect = store.get('prospects', input.prospectId)!;
    const to = contactOf(prospect);
    if (!to) return { status: 'no_contact' };
    const tell = (label: string, body: string) => send(ctx, { label, ownerId: input.ownerId, ...to, body });
    const now = await ctx.now();

    // Owner-led showing: the owner picks the time.
    if (rules.showingMode === 'owner' || !prop.lock || prop.lock.kind === 'none') {
      const a = await ctx.approval({ kind: 'showing_request', title: `Showing request: ${prop.address}`, body: `A prospect (${prospect.phone ?? prospect.email}) wants to see ${prop.address}${input.preferredTimes.length ? `. They suggested: ${input.preferredTimes.join(', ')}` : ''}. Reply with a time in the app, or decline.`, options: ['confirm', 'decline'] });
      if (a?.decision === 'confirm') await tell('owner-confirm', `You're confirmed to see ${prop.address}${a.note ? `: ${a.note}` : ''}. The owner will meet you there.`);
      else await tell('owner-decline', `Thanks for your interest in ${prop.address}. The owner isn't able to schedule a showing right now and will reach out if that changes.`);
      return { status: a?.decision ?? 'no_decision' };
    }

    // Self-guided: verify ID first.
    let sh: Showing = await ctx.step('showing', () => store.insert('showings', { ownerId: input.ownerId, propertyId: prop.id, prospectId: prospect.id, at: '', mode: 'self', idVerified: false, status: 'requested' }));
    const idv = await ctx.step('idv', () => svc.adapters.identity.createVerification({ refId: sh.id }));
    await tell('idv', `Great! Self-guided tours of ${prop.address} run daily ${hourLabel(rules.showingHours.start)}–${hourLabel(rules.showingHours.end)}. First, verify your ID here (takes about a minute): ${idv.url}`);
    const verified = await ctx.waitFor('identity.verified', { refId: sh.id }, { timeoutMs: DAY, label: 'Waiting for the prospect to verify ID' });
    if (!verified) {
      await ctx.step('cancel-noid', () => store.update('showings', sh.id, { status: 'cancelled' }));
      return { status: 'id_not_verified' };
    }
    sh = await ctx.step('verified', () => store.update('showings', sh.id, { idVerified: true }));

    // Offer three times.
    const slots = await ctx.step('slots', () => nextSlots(now.toISOString(), svc.cfg.tz, rules.showingHours));
    await ctx.step('choice-flag', () => store.kvSet('showingChoice', prospect.id, sh.id));
    await tell('slots', `Thanks, you're verified. Reply 1, 2 or 3 to pick a time:\n${slots.map((s, i) => `${i + 1}) ${fmt(s, svc.cfg.tz)}`).join('\n')}`);
    const pick = await ctx.waitFor<{ choice: number }>('showing.slot_chosen', { showingId: sh.id }, { timeoutMs: DAY, label: 'Waiting for the prospect to pick a time' });
    await ctx.step('clear-choice', () => store.kvDelete('showingChoice', prospect.id));
    if (!pick || !slots[pick.choice - 1]) return { status: 'no_time_chosen' };
    const at = slots[pick.choice - 1];
    sh = await ctx.step('confirmed', () => store.update('showings', sh.id, { at, status: 'confirmed' }));
    await tell('confirmed', `You're booked for ${fmt(at, svc.cfg.tz)} at ${prop.address}. Your door code arrives 15 minutes before.`);
    await tellOwner(ctx, 'owner-fyi', input.ownerId, `Self-tour booked: ${prop.address}, ${fmt(at, svc.cfg.tz)} (ID verified).`);

    // Code 15 minutes before, valid for one hour.
    await ctx.sleepUntil(new Date(Date.parse(at) - 15 * MIN).toISOString(), 'Waiting until 15 minutes before the tour');
    const from = new Date(Date.parse(at) - 15 * MIN).toISOString();
    const until = new Date(Date.parse(at) + 45 * MIN).toISOString();
    const code = prop.lock.kind === 'smart' && prop.lock.deviceId
      ? await ctx.step('code', () => svc.adapters.locks.createCode({ deviceId: prop.lock!.deviceId!, from, to: until, label: `Tour ${sh.id}` }))
      : { code: prop.lock.lockboxCode ?? '(ask owner)', codeId: '' };
    await ctx.step('save-code', () => store.update('showings', sh.id, { accessCode: code.code }));
    await tell('code', `Your door code for ${prop.address} is ${code.code}. It works until ${fmt(until, svc.cfg.tz)}. Please lock up when you leave. ${prop.facts['Tour notes'] ?? ''}`.trim());

    // After: revoke and ask for feedback.
    await ctx.sleepUntil(new Date(Date.parse(at) + HOUR).toISOString(), 'Tour in progress');
    if (code.codeId && prop.lock.deviceId) await ctx.step('revoke', () => svc.adapters.locks.revokeCode({ deviceId: prop.lock!.deviceId!, codeId: code.codeId }));
    await ctx.step('done', () => store.update('showings', sh.id, { status: 'completed' }));
    await tell('feedback', `Thanks for touring ${prop.address}! What did you think? If you'd like to apply: ${svc.cfg.publicUrl}/apply/${prop.id}`);
    await ctx.log('showing.completed', `Self-tour completed at ${prop.address}.`, { actor: 'prospect' });
    return { status: 'completed' };
  },
};

export function listingCopy(p: { address: string; city: string; beds: number; baths: number; rent: number; deposit: number; facts: Record<string, string> }, petPolicy: string, availableFrom: string): { title: string; description: string } {
  const title = `${p.beds} bed, ${p.baths} bath home for rent · ${p.address}, ${p.city}`;
  const features = Object.entries(p.facts).filter(([k]) => !/tour notes|code/i.test(k)).map(([k, v]) => `• ${k}: ${v}`).join('\n');
  const description = `${p.beds} bedroom, ${p.baths} bathroom home at ${p.address}, ${p.city}. Available ${availableFrom}.\n\nRent: ${money(p.rent)}/month, all-in (includes every required fee). Security deposit: ${money(p.deposit)}.\nPets: ${petPolicy}\n${features ? `\n${features}\n` : ''}\nSelf-guided tours available daily with ID verification. Apply online. We welcome all qualified applicants and apply the same written criteria to everyone. Equal Housing Opportunity.`;
  return { title, description };
}

export const listing: WorkflowDef<Services, { ownerId: string; propertyId: string; availableFrom: string }> = {
  name: 'listing',
  title: 'Listing a vacancy',
  description: 'Writes a fair-housing-checked listing with all-in rent, gets owner approval, publishes, and tells past prospects who opted in.',
  trigger: { event: 'listing.requested' },

  async run(ctx, input) {
    const store = ctx.store;
    ctx.setOwner(input.ownerId);
    const prop = store.get('properties', input.propertyId)!;
    const rules = store.get('rules', input.ownerId)!;
    const copy = listingCopy(prop, rules.petPolicy, input.availableFrom);
    const check = checkAdCopy(copy.title + '\n' + copy.description);
    if (!check.ok) {
      await tellOwner(ctx, 'ad-blocked', input.ownerId, `The listing for ${prop.address} has wording that fair-housing rules don't allow (${check.problems.join(', ')}). Please edit the home's details in the app.`);
      return { status: 'blocked' };
    }
    const a = await ctx.approval({ kind: 'listing', title: `Publish listing: ${prop.address} at ${money(prop.rent)}`, body: `${copy.title}\n\n${copy.description}`, options: ['publish', 'not_now'], data: copy });
    if (a?.decision !== 'publish') return { status: 'not_published' };
    const res = await ctx.step('publish', () => ctx.svc.adapters.listings.publish({ propertyId: prop.id, title: copy.title, description: copy.description, rent: prop.rent, beds: prop.beds, baths: prop.baths, address: prop.address }));
    await ctx.step('status', () => store.update('properties', prop.id, { status: 'listed' }));
    await ctx.log('listing.published', `${prop.address} listed: ${res.channels.map((c) => `${c.name} (${c.status})`).join(', ')}.`);
    if (res.channels.some((c) => c.status === 'manual')) {
      await tellOwner(ctx, 'manual-post', input.ownerId, `Your listing for ${prop.address} is ready. Copy it from the app into Zillow Rental Manager (automatic posting comes once our Zillow feed is approved).`);
    }

    // Re-match past prospects who said they want updates.
    const matches = store.list('prospects', (p) => p.ownerId === input.ownerId && p.optInUpdates && (!p.wants?.beds || p.wants.beds <= prop.beds) && (!p.wants?.maxRent || p.wants.maxRent >= prop.rent));
    for (const p of matches.slice(0, 50)) {
      const to = contactOf(p);
      if (to) await send(ctx, { label: `rematch:${p.id}`, ownerId: input.ownerId, ...to, body: `A home just opened up that matches what you asked about: ${prop.beds} bed at ${prop.address}, ${money(prop.rent)}/month all-in. Want a self-tour? Reply YES. (Reply STOP to opt out.)` });
    }
    return { status: 'published', rematched: matches.length };
  },
};
