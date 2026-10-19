-- KeyHelm's Postgres tables.
--
-- You never need to run this file: the app creates these tables itself on boot when
-- DATABASE_URL is set (src/store/pg-store.ts). It is here so the layout is easy to read.
--
-- The app keeps every record in memory and saves changes here (one transaction per batch of
-- work, a couple of seconds at most behind). Each record is stored whole as JSON, with the
-- same fields as the types in src/domain/types.ts. Money is integer cents.

-- One row per record: owners, rules, properties, tenants, leases, leaseTemplates, vendors,
-- workOrders, charges, payments, expenses, prospects, applications, showings, messages,
-- approvals, audit, tasks, offers (tbl = the record type, id = the record id).
create table if not exists kh_records (
  tbl text not null,
  id text not null,
  data json not null,
  updated_at timestamptz not null default now(),
  seq bigserial,                 -- keeps the order records were added in
  primary key (tbl, id)
);
create index if not exists kh_records_seq on kh_records (seq);

-- Engine state: workflow runs (ns = 'runs'), sign-in tokens, approval codes, dedupe keys,
-- schedule slots, sign requests, and meta.dataVersion.
create table if not exists kh_kv (
  ns text not null,
  key text not null,
  value json not null,
  updated_at timestamptz not null default now(),
  seq bigserial,
  primary key (ns, key)
);
create index if not exists kh_kv_seq on kh_kv (seq);

-- Which running copy of the app may write (key 'writer', a number that goes up each boot).
-- A copy that starts later takes over; an older copy still running stops saving.
create table if not exists kh_meta (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

-- Handy read-only queries (Railway: Postgres service -> Data, or psql "$DATABASE_URL"):
--   select tbl, count(*) from kh_records group by tbl order by tbl;
--   select data->>'name' as owner, data->>'email' as email, data->>'plan' as plan from kh_records where tbl = 'owners';
--   select data->>'at' as at, data->>'direction' as dir, data->>'to' as "to", data->>'body' as body
--     from kh_records where tbl = 'messages' order by seq desc limit 50;
--   select key, value->>'workflow' as workflow, value->>'status' as status from kh_kv where ns = 'runs' order by seq desc limit 50;
--
-- Change data only through the app (or with the app stopped): the running app keeps its own
-- copy in memory and would write over edits made here.
