import type { WorkflowDef } from '../engine/engine.ts';
import type { Services } from '../services.ts';
import { inboundMessage } from './inbound-message.ts';
import { maintenance } from './maintenance.ts';
import { rentCycle, paymentReceived, lateRent } from './rent.ts';
import { application, leaseFlow } from './leasing.ts';
import { showing, listing } from './showings-listings.ts';
import { renewalSweep, renewal, moveOut, tenantWelcome, conditionNotice } from './tenancy.ts';
import { weeklyReport, onboarding, approvalReminders, notifyOwnerOfApproval } from './owner.ts';
import { approvalAlert, runFailedAlert } from '../ops/alerts.ts';
import { installOps, track } from '../ops/index.ts';

export const ALL_WORKFLOWS: WorkflowDef<Services, any>[] = [
  inboundMessage, maintenance, rentCycle, paymentReceived, lateRent, application, leaseFlow,
  showing, listing, renewalSweep, renewal, moveOut, tenantWelcome, weeklyReport, onboarding, approvalReminders, conditionNotice,
];

/**
 * Register every workflow and connect the owner notification hook and the admin alerts (src/ops).
 * Alerts are sent in the background (track), so a slow text provider never holds up the engine.
 */
export function install(svc: Services, opts: { log?: (s: string) => void } = {}): void {
  svc.engine.register(...ALL_WORKFLOWS);
  svc.engine.hooks.onApprovalCreated = async (a) => {
    try {
      await notifyOwnerOfApproval(svc, a);
    } finally {
      track(svc, approvalAlert(svc, a)); // an emergency no vendor accepted → admin alert
    }
  };
  svc.engine.hooks.onRunFailed = async (run) => {
    if (run.ownerId) svc.store.insert('tasks', { ownerId: run.ownerId, title: `Something needs a look: ${run.workflow}`, detail: (run.error ?? '').split('\n')[0], status: 'open' });
    track(svc, runFailedAlert(svc, run)); // admin alert (at most one per 10 minutes)
  };
  svc.engine.hooks.log = opts.log;
  installOps(svc); // new-customer and AI-fallback alerts
}
