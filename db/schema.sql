-- Postgres schema for production. Mirrors src/domain/types.ts one table per
-- record type. Implement the Store interface (src/store/store.ts) on top of
-- this when moving off the JSON-file MVP store. Money is integer cents.

create table owners (
  id text primary key, name text not null, email text not null, phone text not null,
  plan text not null check (plan in ('essentials','autopilot','plus')),
  timezone text not null default 'America/Denver', line_number text, line_email text,
  created_at timestamptz not null default now()
);

create table owner_rules (
  owner_id text primary key references owners(id),
  repair_spend_limit int not null, emergency_spend_limit int not null,
  rent_due_day int not null check (rent_due_day between 1 and 28), grace_days int not null,
  late_fee int not null, auto_late_notice boolean not null default true,
  pet_policy text not null default '', screening_criteria jsonb not null default '[]',
  showing_mode text not null default 'self', showing_hours jsonb not null, renewal_lead_days int not null default 120,
  quiet_hours jsonb not null, always_route_to_owner text[] not null default '{}', facts jsonb not null default '{}'
);

create table properties (
  id text primary key, owner_id text not null references owners(id),
  address text not null, city text not null, state text not null default 'CO', zip text not null,
  beds int not null, baths numeric not null, rent int not null, deposit int not null,
  status text not null, lock jsonb, facts jsonb not null default '{}'
);

create table tenants (
  id text primary key, owner_id text not null references owners(id), property_id text not null references properties(id),
  name text not null, phone text, email text, preferred_channel text not null, language text,
  autopay boolean not null default false, status text not null
);

create table lease_templates (id text primary key, owner_id text not null references owners(id), name text not null, body text not null, fields text[] not null, uploaded_at timestamptz not null);

create table leases (
  id text primary key, owner_id text not null references owners(id), property_id text not null references properties(id),
  tenant_ids text[] not null, start_date date not null, end_date date not null, rent int not null, deposit int not null,
  deposit_held int not null default 0, template_id text references lease_templates(id), document_url text,
  status text not null, renewal_of text references leases(id), last_rent_increase_at date
);

create table vendors (id text primary key, owner_id text not null references owners(id), name text not null, trades text[] not null, phone text, email text, emergency boolean not null, preferred boolean not null);

create table work_orders (
  id text primary key, owner_id text not null references owners(id), property_id text not null references properties(id),
  tenant_id text references tenants(id), summary text not null, trade text not null, urgency text not null,
  photos text[] not null default '{}', vendor_id text references vendors(id), quote int, invoice int,
  scheduled_for text, respond_by timestamptz not null, status text not null, created_at timestamptz not null
);

create table charges (id text primary key, owner_id text not null, lease_id text not null references leases(id), kind text not null, amount int not null, due_date date not null, paid int not null default 0, status text not null, period text, notices text[] not null default '{}', pay_url text);
create table payments (id text primary key, owner_id text not null, lease_id text not null references leases(id), charge_id text references charges(id), amount int not null, method text not null, provider_ref text unique, received_at timestamptz not null);
create table expenses (id text primary key, owner_id text not null, property_id text not null references properties(id), category text not null, amount int not null, vendor_id text, work_order_id text, date date not null, memo text not null);
create table prospects (id text primary key, owner_id text not null, name text, phone text, email text, interested_in text references properties(id), wants jsonb, opt_in_updates boolean not null default false, created_at timestamptz not null);
create table applications (id text primary key, owner_id text not null, property_id text not null references properties(id), applicant_name text not null, phone text, email text, submitted_at timestamptz not null, screening_url text, report jsonb, decision text, status text not null);
create table showings (id text primary key, owner_id text not null, property_id text not null, prospect_id text not null, at timestamptz, mode text not null, id_verified boolean not null, access_code text, status text not null);
create table messages (id text primary key, owner_id text, thread_key text not null, direction text not null, channel text not null, "to" text, "from" text, body text not null, media text[] not null default '{}', at timestamptz not null, meta jsonb);
create index messages_thread on messages(thread_key, at);
create table approvals (id text primary key, owner_id text not null, run_id text not null, kind text not null, title text not null, body text not null, options text[] not null, data jsonb not null, status text not null, decision text, note text, created_at timestamptz not null, decided_at timestamptz);
create table audit (id text primary key, owner_id text, at timestamptz not null, actor text not null, workflow text, run_id text, action text not null, detail text not null, data jsonb);
create index audit_owner_at on audit(owner_id, at desc);
create table tasks (id text primary key, owner_id text not null, title text not null, detail text not null, due_at timestamptz, status text not null);

-- Engine state (workflow runs, dedupe keys, schedule slots, approval codes, sign requests)
create table kv (ns text not null, key text not null, value jsonb not null, updated_at timestamptz not null default now(), primary key (ns, key));
create index kv_waiting_runs on kv ((value->>'status')) where ns = 'runs';
