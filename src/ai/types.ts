// The plug-in point for "communication AI". Anything that implements
// CommunicationAI can run Landwell's texting/email/voice front desk:
//   - RuleBasedAI   : no model, keyword rules (always available, used as fallback)
//   - AnthropicAI   : Claude via the Messages API
//   - HttpAI        : your own in-house service, or any vendor, over one HTTPS endpoint
// The AI only classifies and drafts. Workflows decide what actually happens,
// and guardrails check every draft before it is sent.

import type { Channel } from '../domain/types.ts';

export type Intent =
  | 'emergency'
  | 'maintenance_request'
  | 'maintenance_update'
  | 'rent_question'
  | 'showing_request'
  | 'listing_question'
  | 'application_question'
  | 'lease_question'
  | 'renewal_response'
  | 'move_out_notice'
  | 'vendor_update'
  | 'accommodation_request'
  | 'fair_housing_sensitive'
  | 'screening_decision_question'
  | 'complaint_or_legal'
  | 'general';

export type SenderRole = 'tenant' | 'prospect' | 'vendor' | 'unknown';

export interface Fact {
  label: string; // "Rent for 2412 Larch Ave"
  value: string; // "$2,150/month, all-in"
}

export interface AIInput {
  channel: Channel;
  senderRole: SenderRole;
  senderName?: string;
  message: string;
  mediaCount: number;
  history: { direction: 'in' | 'out'; body: string }[];
  /** The ONLY facts the AI may state. Anything else → hand off to the owner. */
  facts: Fact[];
  allowedIntents: Intent[];
  ownerFirstName: string;
  brandName: string;
  /** Which owner's account this is for, so AI use can be capped per account. */
  ownerId?: string;
}

export interface AIEntities {
  trade?: string; // plumbing, electrical, hvac, appliance, windows, pest, locks, general
  urgency?: 'emergency' | 'urgent' | 'routine';
  summary?: string; // one-line description of the issue or request
  preferredTimes?: string[];
  moveOutDate?: string; // YYYY-MM-DD
  renewalAnswer?: 'accept' | 'decline' | 'question';
  vendorAccept?: boolean;
  vendorWindow?: string; // "Tue 9-11"
  vendorQuote?: number; // dollars
  vendorDone?: boolean;
  vendorInvoice?: number; // dollars
  beds?: number;
  maxRent?: number; // dollars
  /** Repairs: keep troubleshooting with the tenant, send a pro now, or the tenant fixed it. */
  repairAction?: 'troubleshoot' | 'dispatch' | 'resolved';
}

export interface AIResult {
  intent: Intent;
  confidence: number; // 0..1
  reply: string; // draft reply to the sender (may be empty for vendor updates)
  entities: AIEntities;
  handoff: boolean; // true → the owner must see this
  handoffReason?: string;
  provider: string;
}

export interface CommunicationAI {
  name: string;
  respond(input: AIInput): Promise<AIResult>;
}
