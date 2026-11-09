-- Bark push server — retry claim RPC and the drain schedule (FR-022).
--
-- A request that has already answered cannot retry itself, so transient failures
-- are left `pending` with `next_attempt_at` and a cron job claims them. The claim
-- uses `FOR UPDATE SKIP LOCKED`, which makes overlapping runs safe: a row is
-- handed to exactly one worker. `attempt_count` is capped at 3 by the table
-- constraint, so nothing can loop.
--
-- The schedule posts to the `bark-drain` function with the project URL and the
-- service-role key read from Vault. Those secrets are never written to the
-- repository: set them once per environment with
--
--   select vault.create_secret('https://<ref>.supabase.co/functions/v1/bark-drain',
--                              'bark_functions_url');
--   select vault.create_secret('<service-role-key>', 'bark_service_role_key');

create or replace function bark.bark_claim_retries(p_batch integer)
returns table (
  id uuid,
  request_id uuid,
  device_key text,
  device_token text,
  device_kind bark.device_kind,
  payload jsonb,
  attempt_count smallint,
  origin bark.delivery_origin
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  with claimed as (
    select d.id
    from bark.delivery d
    where d.status = 'pending'
      and d.next_attempt_at is not null
      and d.next_attempt_at <= now()
      and d.attempt_count < 3
    order by d.next_attempt_at
    limit greatest(coalesce(p_batch, 0), 0)
    for update skip locked
  )
  select
    d.id,
    d.request_id,
    d.device_key,
    dev.device_token,
    dev.device_kind,
    d.payload,
    d.attempt_count,
    d.origin
  from bark.delivery d
  join claimed c on c.id = d.id
  join bark.device dev on dev.device_key = d.device_key
  where dev.disabled_at is null
    and dev.invalidated_at is null;
end;
$$;

revoke all on function bark.bark_claim_retries(integer) from public, anon, authenticated;
grant execute on function bark.bark_claim_retries(integer) to service_role;

-- ---------------------------------------------------------------------------
-- Schedule: invoke `bark-drain` once a minute
--
-- Everything is guarded so a project without pg_cron/pg_net (or without the Vault
-- secrets yet) still migrates cleanly; the notice says exactly what is missing.
-- ---------------------------------------------------------------------------

-- Extensions are enabled here when available; on a managed project they may
-- already be on, or may need to be enabled once from the dashboard.
do $$
begin
  begin
    create extension if not exists pg_cron;
  exception when others then
    raise notice 'bark: pg_cron is not available on this project';
  end;
  begin
    create extension if not exists pg_net;
  exception when others then
    raise notice 'bark: pg_net is not available on this project';
  end;
end;
$$;

do $$
declare
  v_url text;
  v_key text;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'bark: pg_cron is not installed — skipping the bark-drain schedule';
    return;
  end if;

  if not exists (select 1 from pg_extension where extname = 'pg_net') then
    raise notice 'bark: pg_net is not installed — skipping the bark-drain schedule';
    return;
  end if;

  begin
    select decrypted_secret into v_url
    from vault.decrypted_secrets
    where name = 'bark_functions_url';

    select decrypted_secret into v_key
    from vault.decrypted_secrets
    where name = 'bark_service_role_key';
  exception when others then
    v_url := null;
    v_key := null;
  end;

  if v_url is null or v_url = '' or v_key is null or v_key = '' then
    raise notice
      'bark: set Vault secrets bark_functions_url and bark_service_role_key to enable the bark-drain schedule';
    return;
  end if;

  begin
    perform cron.unschedule(jobid) from cron.job where jobname = 'bark-drain';
  exception when others then
    null;
  end;

  perform cron.schedule(
    'bark-drain',
    '* * * * *',
    format(
      $job$select net.http_post(url := %L, headers := %L::jsonb, body := '{}'::jsonb, timeout_milliseconds := 5000)$job$,
      v_url,
      jsonb_build_object(
        'Authorization', 'Bearer ' || v_key,
        'Content-Type', 'application/json'
      )::text
    )
  );
end;
$$;
