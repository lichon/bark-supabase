-- Bark push server — expiry and retention (FR-023, SC-009).
--
-- Archives go at `expires_at`; rate-limit windows older than an hour are dropped;
-- delivery records are kept for the operator-configurable retention period. This
-- also clears any `payload` left on a terminal row, so message content is never
-- retained longer than the retry window (the only exception is an intentional
-- archive, which has its own TTL).

create or replace function bark.bark_purge_expired(p_delivery_retention_days integer default 30)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_removed integer := 0;
  v_count integer := 0;
begin
  delete from bark.archive where expires_at <= now();
  get diagnostics v_count = row_count;
  v_removed := v_removed + v_count;

  delete from bark.rate_limit where window_start < now() - interval '1 hour';
  get diagnostics v_count = row_count;
  v_removed := v_removed + v_count;

  delete from bark.delivery
  where status <> 'pending'
    and created_at < now() - make_interval(days => greatest(coalesce(p_delivery_retention_days, 30), 1));
  get diagnostics v_count = row_count;
  v_removed := v_removed + v_count;

  update bark.delivery
  set payload = null
  where status <> 'pending'
    and payload is not null;

  return v_removed;
end;
$$;

revoke all on function bark.bark_purge_expired(integer) from public, anon, authenticated;
grant execute on function bark.bark_purge_expired(integer) to service_role;

-- ---------------------------------------------------------------------------
-- Schedule: purge every five minutes
-- ---------------------------------------------------------------------------

do $$
begin
  begin
    create extension if not exists pg_cron;
  exception when others then
    raise notice 'bark: pg_cron is not available on this project';
  end;
end;
$$;

do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'bark: pg_cron is not installed — skipping the bark-purge schedule';
    return;
  end if;

  begin
    perform cron.unschedule(jobid) from cron.job where jobname = 'bark-purge';
  exception when others then
    null;
  end;

  perform cron.schedule(
    'bark-purge',
    '*/5 * * * *',
    'select bark.bark_purge_expired();'
  );
end;
$$;
