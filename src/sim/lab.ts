// The Test lab: try every workflow in minutes on the local sandbox (npm run sandbox).
// Text as Lisa, a prospect, the vendor or yourself; jump the clock ahead; see every text
// that would have gone out; start over. Only the sandbox creates a Lab, so the live
// server answers 404 to all of it.

import { randomInt } from 'node:crypto';
import { HOUR, MIN, DAY, OffsetClock, addDays, daysBetween, localParts } from '../engine/clock.ts';
import type { MemoryStore } from '../store/store.ts';
import type { Services } from '../services.ts';

export type LabWho = 'tenant' | 'prospect' | 'new_prospect' | 'vendor' | 'owner';
export type LabJump = '1h' | '1d' | '1w' | 'rent' | 'monday' | 'renewal' | 'lease_end';

const JUMP_LABEL: Record<LabJump, string> = {
  '1h': '+1 hour', '1d': '+1 day', '1w': '+1 week', rent: 'Next rent due date', monday: 'Monday morning (weekly report)',
  renewal: '120 days before the lease ends', lease_end: 'The day the lease ends',
};
/** Nobody wants to wait minutes for a jump; a year covers every workflow. */
const MAX_JUMP_MS = 400 * DAY;

/** A sample screening report (the screening partner is a stand-in until one is chosen). */
export const SAMPLE_REPORT = {
  provider: 'Sample Screening Co', monthlyIncome: 680_000, evictionsLast: { years: 5, count: 0 }, collectionsLast: { years: 2, count: 0 },
  referencesConfirmed: 2, pets: 'One 30 lb dog', agencyContact: 'Sample Screening Co, PO Box 1, Denver CO, 800-555-0100',
};

export class Lab {
  private busy = false;
  private svc: Services;
  private clock: OffsetClock;
  private opts: { reseed: () => void };
  constructor(svc: Services, clock: OffsetClock, opts: { reseed: () => void }) {
    this.svc = svc;
    this.clock = clock;
    this.opts = opts;
  }

  private tz(ownerId: string): string {
    return this.svc.store.get('owners', ownerId)?.timezone ?? this.svc.cfg.tz;
  }

  /** The instant a local date and time happen in the owner's timezone. */
  private at(date: string, time: string, tz: string): number {
    const guess = Date.parse(`${date}T${time}:00Z`);
    const lp = localParts(new Date(guess), tz);
    const [h, m] = time.split(':').map(Number);
    const off = daysBetween(date, lp.date) * 24 * 60 + lp.hour * 60 + lp.minute - (h * 60 + m);
    return guess - off * MIN;
  }

  private people(ownerId: string) {
    const s = this.svc.store;
    const owner = s.get('owners', ownerId);
    const tenant = s.find('tenants', (t) => t.ownerId === ownerId && t.status === 'active');
    const vendor = s.find('vendors', (v) => v.ownerId === ownerId && !!v.preferred && !v.emergency) ?? s.find('vendors', (v) => v.ownerId === ownerId);
    const prospect = s.kvGet<string>('lab', 'prospect') ?? '+17205550177';
    return { owner, tenant, vendor, prospect };
  }

  private lease(ownerId: string) {
    const tenant = this.people(ownerId).tenant;
    return this.svc.store.list('leases', (l) => l.ownerId === ownerId && l.status === 'active' && (!tenant || l.tenantIds.includes(tenant.id))).sort((a, b) => a.endDate.localeCompare(b.endDate))[0];
  }

  /** Where each jump lands, or why it can't. */
  targets(ownerId: string): Record<LabJump, { label: string; at?: string; why?: string }> {
    const now = this.clock.now().getTime();
    const tz = this.tz(ownerId);
    const today = localParts(new Date(now), tz).date;
    const rules = this.svc.store.get('rules', ownerId);
    const lease = this.lease(ownerId);
    const out = {} as Record<LabJump, { label: string; at?: string; why?: string }>;
    const put = (k: LabJump, ms: number | undefined, why?: string) => {
      if (ms === undefined) out[k] = { label: JUMP_LABEL[k], why: why ?? 'Not available' };
      else if (ms <= now) out[k] = { label: JUMP_LABEL[k], why: why ?? 'Already passed' };
      else out[k] = { label: JUMP_LABEL[k], at: new Date(ms).toISOString() };
    };
    put('1h', now + HOUR);
    put('1d', now + DAY);
    put('1w', now + 7 * DAY);
    // Rent: 9:00 AM on the next due day (the rent workflow runs at 9:00).
    const due = rules?.rentDueDay ?? 1;
    let d = today;
    for (let i = 0; i < 62; i++) {
      d = addDays(d, 1);
      if (Number(d.slice(8, 10)) === due) break;
    }
    put('rent', this.at(d, '09:05', tz));
    // Monday report: 7:00 AM Monday.
    let mon = today;
    for (let i = 0; i < 7; i++) {
      mon = addDays(mon, 1);
      if (localParts(new Date(this.at(mon, '12:00', tz)), tz).weekday === 1) break;
    }
    put('monday', this.at(mon, '07:05', tz));
    if (!lease) {
      put('renewal', undefined, 'No active lease');
      put('lease_end', undefined, 'No active lease');
    } else {
      put('renewal', this.at(addDays(lease.endDate, -(rules?.renewalLeadDays ?? 120)), '07:05', tz), 'Already in the renewal window (see Today)');
      put('lease_end', this.at(lease.endDate, '07:05', tz));
    }
    return out;
  }

  status(ownerId: string) {
    const s = this.svc.store;
    const p = this.people(ownerId);
    const names: Record<string, string> = {};
    if (p.owner) names[p.owner.phone] = `You (${p.owner.name})`, names[p.owner.email] = `You (${p.owner.name})`;
    for (const t of s.list('tenants', (x) => x.ownerId === ownerId)) { if (t.phone) names[t.phone] = `${t.name} (tenant)`; if (t.email) names[t.email] = `${t.name} (tenant)`; }
    for (const v of s.list('vendors', (x) => x.ownerId === ownerId)) if (v.phone) names[v.phone] = `${v.name} (vendor)`;
    for (const a of s.list('applications', (x) => x.ownerId === ownerId)) if (a.phone) names[a.phone] ??= `${a.applicantName} (applicant)`;
    names[p.prospect] ??= 'Test prospect';
    const sent = s.list('messages', (m) => m.direction === 'out' && (m.ownerId === ownerId || !m.ownerId))
      .sort((a, b) => b.at.localeCompare(a.at)).slice(0, 60)
      .map((m) => ({ at: m.at, to: m.to ?? m.threadKey, toName: names[m.to ?? m.threadKey] ?? m.to ?? m.threadKey, channel: m.channel, body: m.body }));
    const vacant = s.find('properties', (x) => x.ownerId === ownerId && x.status !== 'occupied');
    const waiting = this.svc.engine.runs((r) => r.ownerId === ownerId && r.status === 'waiting').map((r) => ({ workflow: r.workflow, waitingFor: r.waitLabel ?? '' }));
    return {
      now: this.clock.now().toISOString(), tz: this.tz(ownerId), aheadMs: this.clock.offsetMs,
      people: [
        p.tenant && { who: 'tenant', name: p.tenant.name, phone: p.tenant.phone },
        { who: 'prospect', name: 'Test prospect', phone: p.prospect },
        p.vendor && { who: 'vendor', name: p.vendor.name, phone: p.vendor.phone },
        p.owner && { who: 'owner', name: `You (${p.owner.name})`, phone: p.owner.phone },
      ].filter(Boolean),
      jumps: this.targets(ownerId),
      applyUrl: vacant ? `/apply/${vacant.id}` : null,
      vacantAddress: vacant?.address ?? null,
      waiting,
      sent,
    };
  }

  /** A text from someone, exactly as if it came in by SMS. */
  async text(ownerId: string, who: LabWho, body: string, photo = false) {
    const p = this.people(ownerId);
    if (who === 'new_prospect') {
      // 555-01xx numbers are reserved for fiction; nobody can ever get these texts.
      this.svc.store.kvSet('lab', 'prospect', `+1720555${String(randomInt(100, 200)).padStart(4, '0')}`);
      who = 'prospect';
    }
    const from = who === 'tenant' ? p.tenant?.phone : who === 'vendor' ? p.vendor?.phone : who === 'owner' ? p.owner?.phone : this.people(ownerId).prospect;
    if (!from) throw new LabError(`There's no ${who} to text as.`);
    const since = this.svc.clock.now().toISOString();
    this.svc.engine.emit('message.received', { from, channel: 'sms', body, media: photo ? ['https://example.test/lab-photo.jpg'] : [], ownerId, providerMessageId: `lab_${Date.now()}_${randomInt(1e6)}` });
    await this.svc.engine.drain();
    this.svc.store.flush();
    return this.svc.store.list('messages', (m) => m.direction === 'out' && m.at >= since).length;
  }

  /** Move the clock forward, firing every timer and schedule on the way (an hour at a time, 15 minutes for short jumps). */
  async jump(ownerId: string, to: LabJump) {
    const t = this.targets(ownerId)[to];
    if (!t) throw new LabError('Unknown jump.');
    if (!t.at) throw new LabError(`${t.why}.`);
    const end = Date.parse(t.at);
    if (end - this.clock.now().getTime() > MAX_JUMP_MS) throw new LabError('That jump is more than a year; reset the demo data first.');
    if (this.busy) throw new LabError('A jump is already running. Wait a moment.', 409);
    this.busy = true;
    const since = this.svc.clock.now().toISOString();
    try {
      const step = end - this.clock.now().getTime() > 2 * DAY ? HOUR : 15 * MIN;
      while (this.clock.now().getTime() < end) {
        this.clock.advance(Math.min(step, end - this.clock.now().getTime()));
        this.svc.engine.tick();
        await this.svc.engine.drain();
      }
    } finally {
      this.busy = false;
      this.svc.store.kvSet('lab', 'offsetMs', this.clock.offsetMs);
      this.svc.store.flush();
    }
    return this.svc.store.list('messages', (m) => m.direction === 'out' && m.at >= since).length;
  }

  /** The screening partner's report for the newest application still waiting for one. */
  async screening(ownerId: string) {
    const app = this.svc.store.list('applications', (a) => a.ownerId === ownerId && a.status !== 'approved' && a.status !== 'denied').sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))[0];
    if (!app) throw new LabError('No application is waiting. Fill in the apply form first.');
    this.svc.engine.emit('screening.completed', { applicationId: app.id, report: SAMPLE_REPORT });
    await this.svc.engine.drain();
    this.svc.store.flush();
    return app.applicantName;
  }

  /** The prospect passes the ID check for their newest showing request. */
  async idCheck(ownerId: string) {
    const sh = this.svc.store.list('showings', (x) => x.ownerId === ownerId).pop();
    if (!sh) throw new LabError('No showing yet. Text as a prospect asking for a tour first.');
    this.svc.engine.emit('identity.verified', { refId: sh.id });
    await this.svc.engine.drain();
    this.svc.store.flush();
  }

  /** Wipe everything, put the clock back to now and load the demo data again. */
  reset() {
    if (this.busy) throw new LabError('A jump is running. Wait a moment.', 409);
    (this.svc.store as MemoryStore).clear();
    this.clock.offsetMs = 0;
    this.opts.reseed();
    this.svc.store.flush();
  }
}

export class LabError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}
