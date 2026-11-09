# Data Model: Bark Push Server on Supabase

**Feature**: `001-bark-server-supabase` | **Date**: 2026-11-09

Entities map to the spec's Key Entities section. All tables live in schema `bark` (kept out of the exposed `public` schema; the Data API is not enabled for it) and are accessed only by the Edge Functions through the service role. RLS is enabled with no policies, so `anon` and `authenticated` see nothing.

## Enumerations

| Name | Values | Notes |
|---|---|---|
| `bark.device_kind` | `ios`, `watchos` | Defaults to `ios`; selects the APNs topic (FR-005, FR-011) |
| `bark.delivery_status` | `delivered`, `pending`, `failed`, `suppressed` | `suppressed` = device disabled or token invalidated, so no attempt was made |
| `bark.delivery_origin` | `v1_path`, `v1_form`, `v2_json`, `v2_batch`, `retry` | Lets the operator see which client style a request used (SC-004) |

## `bark.device` — Device Registration

One row per delivery target. Satisfies FR-001 – FR-006, FR-017, FR-021, FR-028.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `device_key` | `text` | primary key, `~ '^[A-Za-z0-9]{6,32}$'` | Opaque, unguessable; generated as 16 base62 characters when the client does not supply one |
| `device_token` | `text` | not null, length 1..160 | APNs token, hex; replaced on re-registration (FR-002) |
| `device_kind` | `bark.device_kind` | not null, default `ios` | |
| `disabled_at` | `timestamptz` | null | Operator disable; suppresses delivery (FR-028) |
| `invalidated_at` | `timestamptz` | null | Set when APNs reports the token permanently invalid (FR-021) |
| `last_error` | `text` | null | Most recent non-sensitive failure reason, e.g. `BadDeviceToken` |
| `created_at` | `timestamptz` | not null, default `now()` | |
| `updated_at` | `timestamptz` | not null, default `now()` | Token refresh time (FR-006) |

Indexes: `(device_token)` for diagnostics, `(updated_at)` for stale-registration review.

Rules:
- Registration without a key generates one; registration with an existing key completes a partial update and preserves `created_at`.
- A key may carry both an `ios` and a `watchos` row only if the client explicitly registers both; `(device_key, device_kind)` is therefore the effective identity for delivery and `device_key` alone is the primary key (the reference server stores one token per key, and the Bark app registers a separate key for the watch). Implementation keeps `device_key` as PK and treats `device_kind` as an attribute; if dual-kind support is enabled later it becomes part of the PK.
- `disabled_at` and `invalidated_at` never delete the row: the device key stays resolvable so the client gets a specific error instead of `device not found` (FR-013, edge case).

## `bark.delivery` — Delivery Attempt

One row per notification addressed to one device. Satisfies FR-007 – FR-014, FR-019, FR-020, FR-022. **No message content is stored** except for archived notifications.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | `uuid` | primary key, default `gen_random_uuid()` | Also used as the idempotency/collapse handle |
| `request_id` | `uuid` | not null | Groups the rows produced by one batch request (FR-008) |
| `device_key` | `text` | not null, FK → `bark.device(device_key)` on delete cascade | Target device (FR-017) |
| `origin` | `bark.delivery_origin` | not null | |
| `status` | `bark.delivery_status` | not null, default `pending` | |
| `attempt_count` | `smallint` | not null, default 0, `check (attempt_count between 0 and 3)` | |
| `apns_status` | `smallint` | null | HTTP status from APNs, `0` for transport failures |
| `apns_reason` | `text` | null | APNs `reason` string, e.g. `BadDeviceToken`, `TooManyRequests` |
| `apns_id` | `text` | null | `apns-id` response header, for support escalation |
| `archived` | `boolean` | not null, default false | Whether content was retained (FR-023) |
| `next_attempt_at` | `timestamptz` | null | Null = nothing to do |
| `created_at` | `timestamptz` | not null, default `now()` | |
| `updated_at` | `timestamptz` | not null, default `now()` | |

Indexes: `(status, next_attempt_at)` partial where `status = 'pending'` for the drain claim; `(device_key, created_at desc)` for history; `(created_at)` for the retention purge.

Invariants:
- `attempt_count = 0 AND status = 'pending'` is the just-accepted state; a row moves to `delivered`/`failed`/`suppressed` and has `next_attempt_at = null`.
- `delivered` is terminal and must never be retried (no duplicate notifications, FR-022).
- `suppressed` rows never call APNs; they exist so the caller still gets a reason.

## `bark.archive` — Archived Notification

Created only when `isArchive=1` (or `ttl` present) on an accepted notification. Satisfies FR-012 (ciphertext stays opaque), FR-023, SC-009.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | `uuid` | primary key, default `gen_random_uuid()` | |
| `delivery_id` | `uuid` | not null, FK → `bark.delivery(id)` on delete cascade | |
| `device_key` | `text` | not null, FK → `bark.device(device_key)` on delete cascade | |
| `payload` | `jsonb` | not null | The notification parameters as sent; for encrypted pushes this holds only `ciphertext` and no plaintext |
| `created_at` | `timestamptz` | not null, default `now()` | |
| `expires_at` | `timestamptz` | not null, default `now() + interval '1 day'`, `check (expires_at > created_at)` | Sender `ttl` seconds, clamped to 1 minute – 30 days |

Index: `(expires_at)` for the purge job.

## `bark.rate_limit` — Rate-limit counter

Supports FR-018 and SC-008. Operational state, not user data.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `bucket_key` | `text` | primary key | e.g. `push:<device_key>` or `register:<sha256(ip)>[:6]`; addresses are hashed, never stored raw |
| `window_start` | `timestamptz` | not null | Fixed window start |
| `count` | `integer` | not null, default 0 | |

The RPC `bark_hit_rate_limit(bucket_key, limit, window_seconds)` upserts the current window, increments, and returns `(allowed boolean, remaining int, retry_after int)`. Windows older than one hour are removed by the purge job.

## Relationships

```text
bark.device 1 ──< bark.delivery >── 0..1 bark.archive
     1 ──< bark.rate_limit (by bucket key, no FK)
```

`bark.delivery.device_key` cascades on delete, but devices are never deleted by the application (only flagged), so cascade exists for operator-initiated cleanup.

## Validation rules (from the spec)

| Rule | Source | Where enforced |
|---|---|---|
| Device token required, ≤160 chars | FR-001, edge cases | router/param validation before any DB write |
| Unknown `device_kind` rejected | FR-005 | enum cast + explicit check |
| Body required unless the push is a delete/encrypted payload | FR-007, FR-012 | param validation; encrypted payloads may have an empty body and receive the `Empty Message` placeholder the app expects |
| Payload ≤4096 bytes after mapping | FR-007, edge cases | `apns.ts` measures the serialised payload before the network call |
| `level` ∈ `active`, `passive`, `timeSensitive`, `critical` | FR-010 | param validation; unknown values fall back to `active` with a warning, matching reference tolerance |
| `badge` and `volume` numeric bounds | FR-010 | `badge` 0–999999; `volume` 0.0–1.0 |
| `ttl` bounded | FR-023, SC-009 | clamped as above |
| Archived content deleted at expiry | FR-023 | `bark_purge_expired()` |

## State transitions

```text
delivery: pending ──apns 200──> delivered
          pending ──apns 410 / BadDeviceToken──> failed  (+ device.invalidated_at)
          pending ──device disabled/invalidated──> suppressed
          pending ──400 malformed / payload too large──> failed (terminal)
          pending ──429 / 5xx / timeout──> pending (next_attempt_at set, attempt_count+1)
          pending ──attempt_count = 3──> failed (terminal)

device:   active ──operator disable──> disabled
          active ──APNs permanent token rejection──> invalidated
          active ──re-register with new token──> active (token and updated_at replaced)
          disabled/invalidated ──re-register with fresh token──> active (flags cleared)
```

## Retention

| Data | Retention | Mechanism |
|---|---|---|
| `bark.delivery` rows | 30 days (operator-configurable `BARK_DELIVERY_RETENTION_DAYS`) | purge job |
| `bark.archive` rows | sender `ttl`, clamped 1 min – 30 days | purge job |
| `bark.rate_limit` rows | 1 hour after window start | purge job |
| `bark.device` rows | indefinite while registered; flagged rows retained for diagnostics | not purged automatically |
