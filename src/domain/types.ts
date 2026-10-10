// Core records. Every record has an id and lives in the Store under a table name.
// Money is always integer cents. Dates are ISO strings (UTC).

export type ID = string;
export type Cents = number;
export type ISO = string;

export type Channel = 'sms' | 'email' | 'voice' | 'app';

export interface Owner {
  id: ID;
  name: string;
  email: string;
  phone: string;
  plan: 'essentials' | 'autopilot' | 'plus';
  timezone: string; // e.g. America/Denver
  lineNumber?: string; // the Landwell phone number tenants text for this owner
  lineEmail?: string; // the Landwell inbox address for this owner
  createdAt: ISO;
}

/** The owner's standing instructions. Workflows read these instead of guessing. */
export interface OwnerRules {
  id: ID; // same as ownerId
  ownerId: ID;
  repairSpendLimit: Cents; // jobs at or under this are booked without asking
  emergencySpendLimit: Cents; // emergencies at or under this go ahead without waiting for the owner
  rentDueDay: number; // 1-28
  graceDays: number; // days after due date before rent counts as late
  lateFee: Cents; // requested late fee; engine caps it to Colorado limits
  autoLateNotice: boolean;
  petPolicy: string; // plain words, quoted to prospects verbatim
  screeningCriteria: ScreeningCriterion[];
  showingMode: 'self' | 'owner' | 'both';
  showingHours: { start: string; end: string }; // "09:00"-"19:00" local
  renewalLeadDays: number; // start renewal this many days before lease end
  quietHours: { start: string; end: string }; // no non-urgent texts to tenants
  alwaysRouteToOwner: string[]; // extra keywords the owner wants to handle personally
  facts: Record<string, string>; // free-form facts the AI may quote (parking, trash day...)
}

export interface ScreeningCriterion {
  key: 'income_multiple' | 'evictions_years' | 'collections_years' | 'references' | 'pets' | 'custom';
  label: string; // "Monthly income at least 3x rent"
  value: number | string;
}

export interface Property {
  id: ID;
  ownerId: ID;
  address: string;
  city: string;
  state: string; // 'CO'
  zip: string;
  beds: number;
  baths: number;
  rent: Cents; // advertised all-in monthly rent (Colorado HB25-1090)
  deposit: Cents;
  status: 'occupied' | 'vacant' | 'listed' | 'turnover';
  lock?: { kind: 'smart' | 'lockbox' | 'none'; deviceId?: string; lockboxCode?: string };
  facts: Record<string, string>; // per-home facts: parking, laundry, utilities
}

export interface Tenant {
  id: ID;
  ownerId: ID;
  propertyId: ID;
  name: string;
  phone?: string;
  email?: string;
  preferredChannel: Channel;
  language?: string; // Colorado: notices in tenant's primary language when known
  autopay: boolean;
  status: 'active' | 'former' | 'future';
}

export interface Lease {
  id: ID;
  ownerId: ID;
  propertyId: ID;
  tenantIds: ID[];
  startDate: string; // YYYY-MM-DD
  endDate: string;
  rent: Cents;
  deposit: Cents;
  depositHeld: Cents;
  templateId?: ID;
  documentUrl?: string;
  status: 'draft' | 'out_for_signature' | 'active' | 'ended';
  renewalOf?: ID;
  lastRentIncreaseAt?: string; // Colorado: one increase per 12 months
}

export interface LeaseTemplate {
  id: ID;
  ownerId: ID;
  name: string;
  body: string; // text with {{merge_fields}}; produced from the owner's uploaded file
  fields: string[]; // merge fields found in body
  uploadedAt: ISO;
}

export interface Vendor {
  id: ID;
  ownerId: ID;
  name: string;
  trades: string[]; // 'plumbing', 'windows', 'hvac', 'electrical', 'general', ...
  phone?: string;
  email?: string;
  emergency: boolean; // will take after-hours emergencies
  preferred: boolean;
}

export type Urgency = 'emergency' | 'urgent' | 'routine';

export interface WorkOrder {
  id: ID;
  ownerId: ID;
  propertyId: ID;
  tenantId?: ID;
  summary: string;
  trade: string;
  urgency: Urgency;
  photos: string[];
  vendorId?: ID;
  quote?: Cents;
  invoice?: Cents;
  scheduledFor?: string; // free text window from vendor: "Tue 9-11"
  respondBy: ISO; // Colorado SB24-094: start repairs within 24h (health/safety) or 72h
  status:
    | 'new' | 'triaged' | 'awaiting_vendor' | 'awaiting_owner' | 'scheduled'
    | 'in_progress' | 'completed' | 'invoice_review' | 'paid' | 'cancelled';
  createdAt: ISO;
}

export interface Charge {
  id: ID;
  ownerId: ID;
  leaseId: ID;
  kind: 'rent' | 'late_fee' | 'deposit' | 'other';
  amount: Cents;
  dueDate: string;
  paid: Cents;
  status: 'open' | 'paid' | 'void';
  period?: string; // '2026-11'
  notices: string[]; // which reminders/notices already went out for this charge
  payUrl?: string;
}

export interface Payment {
  id: ID;
  ownerId: ID;
  leaseId: ID;
  chargeId?: ID;
  amount: Cents;
  method: 'ach' | 'card' | 'other';
  providerRef?: string;
  receivedAt: ISO;
}

export interface Expense {
  id: ID;
  ownerId: ID;
  propertyId: ID;
  category: 'repairs' | 'cleaning' | 'utilities' | 'insurance' | 'hoa' | 'taxes' | 'software' | 'other';
  amount: Cents;
  vendorId?: ID;
  workOrderId?: ID;
  date: string;
  memo: string;
}

export interface Prospect {
  id: ID;
  ownerId: ID;
  name?: string;
  phone?: string;
  email?: string;
  interestedIn?: ID; // propertyId
  wants?: { beds?: number; maxRent?: Cents };
  optInUpdates: boolean; // agreed to hear about other homes (marketing texts need consent)
  createdAt: ISO;
}

export interface Application {
  id: ID;
  ownerId: ID;
  propertyId: ID;
  applicantName: string;
  phone?: string;
  email?: string;
  submittedAt: ISO;
  screeningUrl?: string;
  report?: ScreeningReport;
  decision?: 'approved' | 'denied';
  status: 'submitted' | 'screening' | 'ready_for_owner' | 'approved' | 'denied' | 'withdrawn';
}

/** Objective facts from a licensed screening partner. Never an AI judgment. */
export interface ScreeningReport {
  provider: string;
  monthlyIncome?: Cents;
  evictionsLast?: { years: number; count: number };
  collectionsLast?: { years: number; count: number };
  referencesConfirmed?: number;
  pets?: string;
  reportUrl?: string;
  agencyContact: string; // required for adverse-action notices (FCRA)
}

export interface Showing {
  id: ID;
  ownerId: ID;
  propertyId: ID;
  prospectId: ID;
  at: ISO;
  mode: 'self' | 'owner';
  idVerified: boolean;
  accessCode?: string;
  status: 'requested' | 'confirmed' | 'completed' | 'cancelled' | 'no_show';
}

export interface Message {
  id: ID;
  ownerId?: ID;
  threadKey: string; // phone/email of the outside party
  direction: 'in' | 'out';
  channel: Channel;
  to?: string;
  from?: string;
  body: string;
  media: string[];
  at: ISO;
  meta?: Record<string, unknown>;
}

export interface Approval {
  id: ID;
  ownerId: ID;
  runId: ID;
  kind: string; // 'repair_over_limit', 'application', 'lease_signature', 'renewal_rent', ...
  title: string;
  body: string;
  options: string[]; // e.g. ['approve','decline']
  data: Record<string, unknown>;
  status: 'pending' | 'decided' | 'expired';
  decision?: string;
  note?: string;
  createdAt: ISO;
  decidedAt?: ISO;
}

export interface AuditEntry {
  id: ID;
  ownerId?: ID;
  at: ISO;
  actor: 'system' | 'ai' | 'owner' | 'tenant' | 'vendor' | 'prospect';
  workflow?: string;
  runId?: ID;
  action: string;
  detail: string;
  data?: Record<string, unknown>;
}

export interface Task {
  id: ID;
  ownerId: ID;
  title: string;
  detail: string;
  dueAt?: ISO;
  status: 'open' | 'done';
}

/** Table name → record type, used by the Store. */
export interface Tables {
  owners: Owner;
  rules: OwnerRules;
  properties: Property;
  tenants: Tenant;
  leases: Lease;
  leaseTemplates: LeaseTemplate;
  vendors: Vendor;
  workOrders: WorkOrder;
  charges: Charge;
  payments: Payment;
  expenses: Expense;
  prospects: Prospect;
  applications: Application;
  showings: Showing;
  messages: Message;
  approvals: Approval;
  audit: AuditEntry;
  tasks: Task;
}
export type TableName = keyof Tables;
