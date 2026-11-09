-- Bark push server — operator tooling (FR-028, SC-006).
--
-- `bark_disable_device` suppresses delivery for one key without deleting the
-- registration: the key stays resolvable so pushes fail with a specific
-- `device is disabled` message, and re-registering with a fresh token re-enables
-- it. `bark.device_status` is the operator view — it deliberately has no token
-- column, so `select *` can never leak a registration token.

create or replace function bark.bark_disable_device(p_device_key text)
returns bark.device
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row bark.device;
begin
  update bark.device
  set disabled_at = now(),
      updated_at = now()
  where device_key = p_device_key
  returning * into v_row;

  if v_row.device_key is null then
    raise exception 'device not found' using errcode = 'P0002';
  end if;

  return v_row;
end;
$$;

revoke all on function bark.bark_disable_device(text) from public, anon, authenticated;
grant execute on function bark.bark_disable_device(text) to service_role;

create or replace view bark.device_status as
select
  device_key,
  device_kind,
  created_at,
  updated_at,
  invalidated_at,
  disabled_at,
  last_error
from bark.device;

revoke all on bark.device_status from public, anon, authenticated;
grant select on bark.device_status to service_role;

comment on view bark.device_status is
  'Operator view of registrations: deliberately excludes device_token.';
