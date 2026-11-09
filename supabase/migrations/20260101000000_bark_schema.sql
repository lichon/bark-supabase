-- Bark push server — schema, tables, indexes, and the deny-all security posture.
--
-- Everything lives in the `bark` schema. The schema is exposed through PostgREST
-- (see `supabase/config.toml` `[api] schemas`) because the Edge Functions reach the
-- database through supabase-js, but it is closed to clients by two independent
-- mechanisms:
--
--   1. row level security is enabled on every table with *no* policies;
--   2. every privilege is revoked from `anon` and `authenticated`.
--
-- Only `service_role` (used exclusively by the Edge Functions) can read or write.
-- See specs/001-bark-server-supabase/data-model.md.

create schema if not exists bark;

create type bark.device_kind as enum ('ios', 'watchos');
create type bark.delivery_status as enum ('delivered', 'pending', 'failed', 'suppressed');
create type bark.delivery_origin as enum ('v1_path', 'v1_form', 'v2_json', 'v2_batch', 'retry');

-- ---------------------------------------------------------------------------
-- bark.device — one row per delivery target (FR-001 – FR-006, FR-017, FR-021)
-- ---------------------------------------------------------------------------

create table bark.device (
  device_key text primary key
    constraint device_key_format check (device_key ~ '^[A-Za-z0-9]{6,32}$'),
  device_token text not null
    constraint device_token_length check (char_length(device_token) between 1 and 160),
  device_kind bark.device_kind not null default 'ios',
  disabled_at timestamptz,
  invalidated_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index device_token_idx on bark.device (device_token);
create index device_updated_at_idx on bark.device (updated_at desc);

-- ---------------------------------------------------------------------------
-- bark.delivery — one row per notification addressed to one device
-- (FR-007 – FR-014, FR-019, FR-020, FR-022)
--
-- `payload` is the only column that can hold message content. It is written when
-- the row is created and nulled the moment the row reaches a terminal state, so
-- content is retained only as long as a retry is still possible. Archived
-- notifications keep their copy in `bark.archive` instead.
-- ---------------------------------------------------------------------------

create table bark.delivery (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null,
  device_key text not null references bark.device (device_key) on delete cascade,
  origin bark.delivery_origin not null,
  status bark.delivery_status not null default 'pending',
  attempt_count smallint not null default 0
    constraint delivery_attempt_count check (attempt_count between 0 and 3),
  apns_status smallint,
  apns_reason text,
  apns_id text,
  archived boolean not null default false,
  next_attempt_at timestamptz,
  payload jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Claim index for the drain worker: only pending rows with a due time.
create index delivery_pending_idx on bark.delivery (next_attempt_at) where status = 'pending';
create index delivery_device_created_idx on bark.delivery (device_key, created_at desc);
create index delivery_created_at_idx on bark.delivery (created_at);

-- ---------------------------------------------------------------------------
-- bark.archive — retained notifications (FR-012, FR-023, SC-009)
-- ---------------------------------------------------------------------------

create table bark.archive (
  id uuid primary key default gen_random_uuid(),
  delivery_id uuid not null references bark.delivery (id) on delete cascade,
  device_key text not null references bark.device (device_key) on delete cascade,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '1 day'),
  constraint archive_expiry_after_creation check (expires_at > created_at)
);

create index archive_expires_at_idx on bark.archive (expires_at);

-- ---------------------------------------------------------------------------
-- bark.rate_limit — fixed-window counters (FR-018, SC-008)
-- ---------------------------------------------------------------------------

create table bark.rate_limit (
  bucket_key text primary key,
  window_start timestamptz not null,
  count integer not null default 0 constraint rate_limit_count check (count >= 0)
);

create index rate_limit_window_start_idx on bark.rate_limit (window_start);

-- ---------------------------------------------------------------------------
-- Security posture: RLS with no policies, no privileges for API roles
-- ---------------------------------------------------------------------------

alter table bark.device enable row level security;
alter table bark.delivery enable row level security;
alter table bark.archive enable row level security;
alter table bark.rate_limit enable row level security;

revoke all on schema bark from public;
revoke all on schema bark from anon, authenticated;
revoke all on all tables in schema bark from public;
revoke all on all tables in schema bark from anon, authenticated;
revoke all on all sequences in schema bark from public, anon, authenticated;

grant usage on schema bark to service_role;
grant select, insert, update, delete on all tables in schema bark to service_role;

-- PostgREST connects as `authenticator` and then switches role per request. It
-- needs to see the schema to build its cache; the per-request role still has no
-- table privileges, so this exposes nothing on its own.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticator') then
    execute 'grant usage on schema bark to authenticator';
  end if;
end;
$$;

alter default privileges in schema bark
  grant select, insert, update, delete on tables to service_role;

comment on schema bark is
  'Bark push server state. Reachable by service_role only; RLS deny-all for API roles.';
