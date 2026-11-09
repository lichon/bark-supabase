-- Bark push server — RPC layer.
--
-- Every function is `security definer` with an empty `search_path`, so it is safe
-- against search-path injection and can only touch schema-qualified objects. The
-- parameters are `p_`-prefixed to avoid shadowing column names inside PL/pgSQL.
--
-- Naming note: the design documents describe `bark_register_device(device_key,
-- device_token, device_kind)` and `bark_hit_rate_limit(bucket_key, limit,
-- window_seconds)`. The `p_` prefix is the only difference and exists purely to
-- keep the PL/pgSQL unambiguous; the callers in `_shared/store.ts` use it.

-- ---------------------------------------------------------------------------
-- Key generation — 16 random base62 characters, unguessable (FR-001)
-- ---------------------------------------------------------------------------

create or replace function bark.bark_generate_key()
returns text
language sql
set search_path = ''
as $$
  select string_agg(
    substr(
      '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
      1 + floor(random() * 62)::integer,
      1
    ),
    ''
  )
  from generate_series(1, 16);
$$;

-- ---------------------------------------------------------------------------
-- bark_register_device — create or complete a registration (FR-001 – FR-003, FR-006)
--
-- A generated key is used when the client does not supply one. Re-registering an
-- existing key replaces the token, refreshes `updated_at`, preserves `created_at`
-- and clears the operator/token flags so a refreshed registration works again.
-- ---------------------------------------------------------------------------

create or replace function bark.bark_register_device(
  p_device_key text,
  p_device_token text,
  p_device_kind bark.device_kind
)
returns bark.device
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key text;
  v_row bark.device;
begin
  if p_device_token is null or btrim(p_device_token) = '' then
    raise exception 'device token is empty' using errcode = '22023';
  end if;
  if char_length(p_device_token) > 160 then
    raise exception 'device token is invalid' using errcode = '22023';
  end if;

  if p_device_key is null or btrim(p_device_key) = '' then
    v_key := bark.bark_generate_key();
  else
    v_key := btrim(p_device_key);
  end if;

  insert into bark.device as d (device_key, device_token, device_kind)
  values (v_key, btrim(p_device_token), coalesce(p_device_kind, 'ios'))
  on conflict (device_key) do update
    set device_token = excluded.device_token,
        device_kind = excluded.device_kind,
        updated_at = now(),
        disabled_at = null,
        invalidated_at = null,
        last_error = null
  returning * into v_row;

  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- bark_lookup_device — resolve a key, including flagged rows
--
-- Flagged rows stay resolvable so the client gets a specific error instead of
-- `device not found` (FR-013 edge case).
-- ---------------------------------------------------------------------------

create or replace function bark.bark_lookup_device(p_device_key text)
returns setof bark.device
language sql
security definer
set search_path = ''
as $$
  select *
  from bark.device
  where device_key = p_device_key
  limit 1;
$$;

-- ---------------------------------------------------------------------------
-- bark_hit_rate_limit — atomic fixed-window counter (FR-018, SC-008)
--
-- Returns whether the request is allowed, how many remain in the window, and how
-- many seconds until the window resets (0 when allowed).
-- ---------------------------------------------------------------------------

create or replace function bark.bark_hit_rate_limit(
  p_bucket_key text,
  p_limit integer,
  p_window_seconds integer
)
returns table (allowed boolean, remaining integer, retry_after integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_window_start timestamptz;
  v_count integer;
begin
  if p_window_seconds is null or p_window_seconds <= 0 then
    raise exception 'window_seconds must be positive' using errcode = '22023';
  end if;
  if p_limit is null or p_limit <= 0 then
    raise exception 'limit must be positive' using errcode = '22023';
  end if;

  v_window_start := to_timestamp(
    floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds
  );

  insert into bark.rate_limit as rl (bucket_key, window_start, count)
  values (p_bucket_key, v_window_start, 1)
  on conflict (bucket_key) do update
    set count = case
          when rl.window_start = excluded.window_start then rl.count + 1
          else 1
        end,
        window_start = case
          when rl.window_start = excluded.window_start then rl.window_start
          else excluded.window_start
        end
  returning rl.count into v_count;

  allowed := v_count <= p_limit;
  remaining := greatest(p_limit - v_count, 0);
  if allowed then
    retry_after := 0;
  else
    retry_after := greatest(
      1,
      ceil(p_window_seconds - extract(epoch from (now() - v_window_start)))::integer
    );
  end if;

  return next;
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges — the API roles never execute these directly
-- ---------------------------------------------------------------------------

revoke all on function bark.bark_generate_key() from public, anon, authenticated;
revoke all on function bark.bark_register_device(text, text, bark.device_kind)
  from public, anon, authenticated;
revoke all on function bark.bark_lookup_device(text) from public, anon, authenticated;
revoke all on function bark.bark_hit_rate_limit(text, integer, integer)
  from public, anon, authenticated;

grant execute on function bark.bark_generate_key() to service_role;
grant execute on function bark.bark_register_device(text, text, bark.device_kind) to service_role;
grant execute on function bark.bark_lookup_device(text) to service_role;
grant execute on function bark.bark_hit_rate_limit(text, integer, integer) to service_role;
