import type { WorkflowDef } from '../engine/engine.ts';
import type { Services } from '../services.ts';
import { inboundMessage } from './inbound-message.ts';
import { maintenance } from './maintenance.ts';
import { rentCycle, paymentReceived, lateRent } from './rent.ts';
import { application, leaseFlow } from './leasing.ts';
import { showing, listing } from './showings-listings.ts';
import { renewalSweep, renewal, moveOut, tenantWelcome } from './tenancy.ts';
import { weeklyReport, onboarding, notifyOwnerOfApproval } from './owner.ts';

export const ALL_WORKFLOWS: WorkflowDef<Services, any>[] = [
  inboundMessage, maintenance, rentCycle, paymentReceived, lateRent, application, leaseFlow,
  showing, listing, renewalSweep, renewal, moveOut, tenantWelcome, weeklyReport, onboarding,
];

/** Register every workflow and connect the owner notification hook. */
export function install(svc: Services, opts: { log?: (s: string) => void } = {}): void {
  svc.engine.register(...ALL_WORKFLOWS);
  svc.engine.hooks.onApprovalCreated = (a) => notifyOwnerOfApproval(svc, a);
  svc.engine.hooks.onRunFailed = async (run) => {
    if (!run.ownerId) return;
    svc.store.insert('tasks', { ownerId: run.ownerId, title: `Something needs a look: ${run.workflow}`, detail: (run.error ?? '').split('\n')[0], status: 'open' });
  };
  svc.engine.hooks.log = opts.log;
}
