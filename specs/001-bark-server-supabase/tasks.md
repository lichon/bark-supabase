---
description: "Task list for Bark Push Server on Supabase (unit tests only)"
---

# Tasks: Bark Push Server on Supabase

**Input**: Design documents from `specs/001-bark-server-supabase/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md)

**Tests**: **Unit tests only**, all inside the existing `supabase/` project. No PG Tap suite, no in-process contract suite, no shell smoke/load scripts, no new top-level `scripts/` or `docs/` directories. Testability is achieved by keeping the modules pure — parameters, payload mapping, JWT signing, APNs classification and header derivation, route matching, retry rules, envelope and config validation are all plain functions that take inputs and return values, with the network transport injectable. End-to-end behaviour is verified by the manual run in [quickstart.md](./quickstart.md).

**Organization**: Tasks are grouped by user story so each story can be implemented, unit-tested and demonstrated on its own.

**Story map**

| Label | Spec story | Priority |
|---|---|---|
| US1 | Register an iPhone and receive a notification | P1 (MVP) |
| US2 | Existing tools send notifications without changes | P2 |
| US3 | Rich notification behavior is preserved | P3 |
| US4 | Operator deploys, monitors, and troubleshoots | P3 |
| US5 | End-to-end encrypted and archived notifications | P4 |

**Path Conventions**: Everything lives in the existing project: `supabase/functions/` (Edge Functions, `_shared/` modules, `tests/`), `supabase/migrations/`, `supabase/seed.sql`. Nothing is created outside `supabase/` except edits to the existing `README.md`.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: `US1`…`US5` on user-story tasks only
- Every task names the exact file it creates or edits

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Extend the existing `supabase/` project with the directories and config the feature needs.

- [X] T001 Create `supabase/functions/bark/`, `supabase/functions/bark-drain/`, `supabase/functions/_shared/routes/`, `supabase/functions/tests/` (no directories outside `supabase/`)
- [X] T002 [P] Add `supabase/functions/deno.json` with `test`/`fmt`/`lint` tasks and the import map pinning `npm:@supabase/supabase-js@^2` (D2: no APNs library, no other dependencies)
- [X] T003 [P] Append to `.gitignore`: `supabase/functions/.env`, `supabase/functions/.env.local`, `supabase/functions/.env.production`, `*.p8`
- [X] T004 [P] Create `supabase/functions/.env.example` listing every variable from [contracts/apns-push.md](./contracts/apns-push.md) with descriptions and empty values only
- [X] T005 [P] Create `supabase/seed.sql` as a commented empty file so `db.seed.sql_paths` in `supabase/config.toml` resolves
- [X] T006 [P] Create `supabase/functions/tests/fixtures.ts`: an ES256 test key pair (PEM), sample device tokens (valid, 161 characters, empty), sample parameter maps for each request shape, and a sample batch key list

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Schema, envelope, routing, transport and persistence seams every story builds on.

**⚠️ CRITICAL**: No user story work begins until this phase is complete.

- [X] T007 Create `supabase/migrations/20260101000000_bark_schema.sql`: schema `bark`; enums `device_kind` (`ios`, `watchos`), `delivery_status` (`delivered`, `pending`, `failed`, `suppressed`), `delivery_origin` (`v1_path`, `v1_form`, `v2_json`, `v2_batch`, `retry`); tables `bark.device`, `bark.delivery`, `bark.archive`, `bark.rate_limit` with the column types, defaults, checks and indexes in [data-model.md](./data-model.md)
- [X] T008 Append to `supabase/migrations/20260101000000_bark_schema.sql`: `enable row level security` on all four tables with **no policies**, `revoke all` from `anon`/`authenticated`, `grant usage on schema bark to service_role` (D4)
- [X] T009 Create `supabase/migrations/20260101000100_bark_rpc.sql` with `bark_register_device(device_key text, device_token text, device_kind bark.device_kind)` (generates a 16-character base62 key when null, preserves `created_at`, replaces `device_token` + `updated_at`, clears `disabled_at`/`invalidated_at`), `bark_lookup_device(device_key text)`, and `bark_hit_rate_limit(bucket_key text, limit int, window_seconds int)` returning `(allowed boolean, remaining int, retry_after int)` — all `security definer` with `search_path = ''`
- [X] T010 [P] Implement `supabase/functions/_shared/response.ts` as pure builders: `success()`, `failed(code, message)`, `data(payload)` returning the `{code, message, data?, timestamp}` envelope, plus `jsonResponse`/`textResponse` with `cache-control: no-store` and the `OPTIONS` → `204` CORS headers (contract: [http-api.md](./contracts/http-api.md))
- [X] T011 Implement `supabase/functions/_shared/router.ts` as a pure matcher: `stripPrefix(pathname, slug)` removing `/functions/v1/bark`, `match(method, remainder)` returning `{kind: 'route' | 'not_found' | 'method_not_allowed', handler, allow}`, with the `404`/`405` envelopes delegated to `response.ts`
- [X] T012 [P] Implement `supabase/functions/_shared/jwt.ts`: PKCS#8 import via `crypto.subtle.importKey('pkcs8', …, {name:'ECDSA', namedCurve:'P-256'})`, ES256 signing of `{alg:'ES256', kid}` + `{iss, iat}` with base64url of the raw `r‖s` signature, per-isolate cache with a 50-minute TTL, and `invalidate()`
- [X] T013 [P] Write `supabase/functions/tests/jwt_test.ts`: asserts `alg`/`kid`, `iss`/`iat` claims, verifies the signature with the public key derived from the fixture, and asserts the cache returns the same token twice and a fresh token after `invalidate()`
- [X] T014 Implement `supabase/functions/_shared/apns.ts` with the network edge injectable: pure `buildHeaders(params, deviceKind, now)` (topic per kind, `apns-push-type`/`apns-priority`/`apns-expiration`/`apns-collapse-id`), pure `classify(status, reason)` → `delivered | transient | credential | permanent | suppressed`, `shouldRetry(classification, attemptCount)`, and `send(jwt, request, fetchImpl)` posting over HTTP/2 with a 10-second abort and one re-sign retry on `ExpiredProviderToken`
- [X] T015 [P] Write `supabase/functions/tests/apns_test.ts` using a stub `fetch` function (no HTTP server): table-driven assertions for `classify` across `200`, `400 BadDeviceToken`, `400 DeviceTokenNotForTopic`, `403 InvalidProviderToken`, `410 Unregistered`, `429`, `500`, `503`, timeout; assert `buildHeaders` sets the `ios` and `watchos` topics and the alert/background priorities; assert `shouldRetry` stops at `attempt_count = 3`
- [X] T016 [P] Implement `supabase/functions/_shared/store.ts`: service-role client factory reading `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`, plus `registerDevice`, `lookupDevice`, `insertDelivery`, `updateDelivery`, `insertArchive`, `claimRetries`, `disableDevice` wrappers over the RPCs and tables in [data-model.md](./data-model.md)
- [X] T017 [P] Implement `supabase/functions/_shared/ratelimit.ts`: `check(bucket, limit, windowSeconds)` wrapping `bark_hit_rate_limit` and `rejectionResponse(retryAfter)` producing the `429` envelope with `Retry-After` and `X-RateLimit-Remaining: 0`
- [X] T018 Implement `supabase/functions/bark/index.ts`: `Deno.serve` wiring config, `OPTIONS` handling, the router table and a top-level error handler that converts unexpected throws into the envelope without leaking internals

**Checkpoint**: schema, envelope, routing, APNs classification and persistence seams exist and are unit-tested — stories can proceed independently.

---

## Phase 3: User Story 1 — Register an iPhone and receive a notification (Priority: P1) 🎯 MVP

**Goal**: A device registers itself and receives a titled notification; transient failures are retried; a permanently invalid token is flagged.

**Independent Test**: `deno test` passes the parameter, routing and retry suites, and the manual run in [quickstart.md](./quickstart.md) §7 delivers a notification to a physical iPhone after registration.

### Tests for User Story 1

- [X] T019 [P] [US1] Write `supabase/functions/tests/params_test.ts`: body/query precedence, path > body > query, URL-decoded path segments (`%20`, UTF-8), `+` literal in paths and space in forms, missing `device_key` → error
- [X] T020 [P] [US1] Write `supabase/functions/tests/router_test.ts`: `/functions/v1/bark/ping` and `/functions/v1/bark/{key}` resolve after prefix stripping; a different or missing prefix does not match; unknown path → `not_found`; `DELETE /push` → `method_not_allowed` with `allow` listing `POST`
- [X] T021 [P] [US1] Write `supabase/functions/tests/retry_rules_test.ts`: backoff is 60 s after `429`/timeout and 15 min after `5xx`; attempt 3 is terminal; `delivered`/`failed`/`suppressed` are never retryable; `attempt_count` never exceeds 3

### Implementation for User Story 1

- [X] T022 [P] [US1] Implement `supabase/functions/_shared/params.ts`: `normalize({body, query, path, contentType})` returning one parameter map with precedence path > body > query, single URL-decode of path segments, and typed accessors `requireDeviceKey`, `alertFields`, `intParam`, `boolParam`
- [X] T023 [P] [US1] Implement `supabase/functions/_shared/payload.ts`: `buildAlertPayload(params)` producing `aps.alert.{title,subtitle,body}`, `aps.sound` (append `.caf` when no extension), `aps.mutable-content: 1`, `category: "myNotificationCategory"`, plus `assertPayloadSize(payload)` rejecting anything over 4096 bytes with a `400`-class error
- [X] T024 [US1] Implement registration in `supabase/functions/_shared/routes/register.ts`: accept JSON, form and query input; validate `device_token` (1–160 characters) and `device_key` (`^[A-Za-z0-9]{6,32}$`, alias `key`), `device_type` in (`ios`, `watchos`) defaulting to `ios`; return `key`, `device_key`, `device_token`, `device_type`
- [X] T025 [US1] Implement single-target delivery in `supabase/functions/_shared/routes/push.ts`: resolve device, return `400 "device not found"` / `"device is disabled"` / `"device token is invalid"` without calling APNs, build payload via T023, call `apns.ts`, map the APNs classification to the contract's client-visible code, and write exactly one `bark.delivery` row per target
- [X] T026 [US1] Implement invalid-token handling in `supabase/functions/_shared/store.ts`: on `410`/`400 BadDeviceToken` set `device.invalidated_at = now()` and `last_error` to the APNs reason while leaving the row resolvable
- [X] T027 [US1] Create `supabase/migrations/20260101000200_bark_retry.sql`: `bark_claim_retries(batch int)` selecting `pending` rows with `next_attempt_at <= now()` via `FOR UPDATE SKIP LOCKED` and `attempt_count < 3`, plus the `pg_cron` schedule invoking `bark-drain` through `net.http_post` with URL and key read from Vault
- [X] T028 [US1] Implement `supabase/functions/bark-drain/index.ts`: claim up to 20 due deliveries, re-send through `apns.ts` (origin `retry`), apply the delays from T021, and finalise rows to `failed` at `attempt_count = 3`

**Checkpoint**: US1 is a working single-device push server — the MVP is demonstrable on a real iPhone.

---

## Phase 4: User Story 2 — Existing tools send notifications without changes (Priority: P2)

**Goal**: Every documented request shape and the batch form work and produce identical notifications.

**Independent Test**: Unit tests show all four request shapes normalise to the same parameter map and that batch key parsing handles arrays, comma strings and the 100-key cap; the manual run sends the same notification through each shape and gets identical deliveries.

### Tests for User Story 2

- [X] T029 [P] [US2] Write `supabase/functions/tests/params_v1_test.ts`: multipart/form parsing, legacy aliases (`key`→`device_key`, `devicetoken`→`device_token`), and that the four path shapes (`/k`, `/k/body`, `/k/title/body`, `/k/title/subtitle/body`) produce equal maps to their JSON equivalents
- [X] T030 [P] [US2] Write `supabase/functions/tests/batch_test.ts`: `device_keys` as array, as comma string, and mixed; 100 keys accepted; 101 keys rejected with `"batch push count exceeds the maximum limit: 100"`; duplicate keys preserved in order

### Implementation for User Story 2

- [X] T031 [US2] Extend `supabase/functions/_shared/params.ts` with V1 parsing: multipart form values, legacy aliases, and path extraction of key/title/subtitle/body with the documented precedence
- [X] T032 [US2] Extend `supabase/functions/_shared/router.ts` and `supabase/functions/_shared/routes/push.ts` with the four V1 path variants for `GET` and `POST` plus `POST /push` JSON, all sharing one delivery pipeline
- [X] T033 [US2] Implement batch delivery in `supabase/functions/_shared/routes/push.ts`: expand `device_keys` (array or comma string), cap at 100, deliver in bounded parallel batches, aggregate `data[]` results, and group rows by a shared `request_id` with origin `v2_batch`
- [X] T034 [US2] Extend `supabase/functions/_shared/routes/register.ts` with legacy `GET /register` (query parameters) and `GET /register/{device_key}` existence check

**Checkpoint**: Third-party integrations (SmsForwarder, Uptime-Kuma, acme.sh, Apprise, Shortcuts) work unchanged.

---

## Phase 5: User Story 3 — Rich notification behavior is preserved (Priority: P3)

**Goal**: Grouping, custom sounds, badges, icons, links, critical/time-sensitive levels, volume, continuous ring, auto-copy and tap behaviour all map correctly.

**Independent Test**: Unit tests assert one payload per parameter group with the documented keys (`thread-id`, `interruption-level`, critical `sound` object, `badge`, custom `url`/`icon`/`action`/`autoCopy`/`copy`/`call`, `content-available` for delete); the manual run confirms each behaviour on the phone.

### Tests for User Story 3

- [X] T035 [P] [US3] Write `supabase/functions/tests/payload_rich_test.ts`, one row per parameter in [contracts/http-api.md](./contracts/http-api.md): `level` → `aps.interruption-level`; `volume` → `aps.sound = {critical:1, name, volume}`; `group` → `aps.thread-id`; `badge` → integer; `.caf` suffixing; `delete=1` → `content-available` with background push type; unknown parameters lower-cased and stringified
- [X] T036 [P] [US3] Write `supabase/functions/tests/params_validation_test.ts`: unknown `level` falls back to `active` with a warning; `badge` outside 0–999999 rejected; `volume` outside 0.0–1.0 rejected; oversized payload rejected by `assertPayloadSize` before any transport call

### Implementation for User Story 3

- [X] T037 [US3] Extend `supabase/functions/_shared/payload.ts` with the full mapping table: `level`, `volume`, `badge`, `group`→`thread-id`, `icon`/`url`/`action`/`autoCopy`/`copy`/`call` and unknown keys as lower-cased string custom fields, plus the delete → `content-available` silent variant
- [X] T038 [US3] Extend `supabase/functions/_shared/apns.ts` `buildHeaders` to derive `apns-push-type` (`alert`/`background`), `apns-priority` (`10`/`5`) and `apns-collapse-id` from `id` (≤64 printable ASCII, otherwise dropped)
- [X] T039 [US3] Add `level`, `badge` and `volume` validation and bounds to `supabase/functions/_shared/params.ts` while keeping the tolerant fallback for unrecognised `level` values

**Checkpoint**: Notification presentation matches what users had on the reference server.

---

## Phase 6: User Story 4 — Operator deploys, monitors, and troubleshoots (Priority: P3)

**Goal**: Health, readiness, version info, delivery records, disable-a-device and log hygiene.

**Independent Test**: Unit tests prove `/healthz` names a missing variable and never echoes values, and `/info` reports fields without secrets; the manual run disables a device, sees rejection, re-registers, and confirms clean logs.

### Tests for User Story 4

- [X] T040 [P] [US4] Write `supabase/functions/tests/misc_test.ts`: `/` returns `ok` text, `/ping` returns `{code:200,message:"pong"}` with a timestamp, `/info` returns `version`/`build`/`arch`/`commit`/`devices` and contains no secret value, `/healthz` returns `503` with the failing variable **name** when a credential is absent
- [X] T041 [P] [US4] Write `supabase/functions/tests/config_test.ts`: every variable from [contracts/apns-push.md](./contracts/apns-push.md) is required or defaulted as documented; a malformed `.p8` yields an error naming `APNS_P8`; no error message contains the value of any secret

### Implementation for User Story 4

- [X] T042 [US4] Implement `supabase/functions/_shared/config.ts`: parse and validate every variable, throw errors that name the variable and never echo its value, and expose a `readiness()` returning `{ready, failingVariable?}`
- [X] T043 [US4] Implement `supabase/functions/_shared/routes/misc.ts`: `/`, `/ping`, `/healthz` (via `readiness()`), `/info` (live registration count)
- [X] T044 [US4] Create `supabase/migrations/20260101000400_bark_admin.sql`: `bark_disable_device(device_key text)` and view `bark.device_status` exposing `device_key`, `device_kind`, `created_at`, `updated_at`, `invalidated_at`, `disabled_at`, `last_error` (no tokens)
- [X] T045 [US4] Implement structured delivery logging in `supabase/functions/_shared/apns.ts`: one JSON line per attempt with delivery id, hashed device key, APNs status, reason and latency, excluding token, content, ciphertext and credentials (FR-020)

**Checkpoint**: An operator can deploy, verify and diagnose without reading code.

---

## Phase 7: User Story 5 — End-to-end encrypted and archived notifications (Priority: P4)

**Goal**: Encrypted payloads pass through untouched and never reach storage or logs; archived notifications are retained for the requested lifetime and purged automatically.

**Independent Test**: Unit tests assert the TTL clamp, that ciphertext is stored verbatim and never expanded, and that a push without `isArchive` creates no archive row; the manual run confirms the app decrypts and that the archive row is purged after expiry.

### Tests for User Story 5

- [X] T046 [P] [US5] Write `supabase/functions/tests/archive_test.ts`: `isArchive=1` produces an archive record decision; `ttl` clamped to 60–2 592 000 seconds; no `isArchive` and no `ttl` → no archive; a `ciphertext`-only payload keeps the ciphertext byte-identical and adds the `Empty Message` placeholder body

### Implementation for User Story 5

- [X] T047 [US5] Implement archive persistence in `supabase/functions/_shared/routes/push.ts` and `_shared/store.ts`: insert when `isArchive=1` or `ttl` is present, apply the clamp, set `archived = true` on the delivery, and never write message content when the payload is encrypted
- [X] T048 [US5] Add ciphertext handling to `supabase/functions/_shared/params.ts` and `_shared/payload.ts`: treat the value as opaque, allow an empty body, never parse/decrypt/log it, and keep it out of `last_error`
- [X] T049 [US5] Create `supabase/migrations/20260101000300_bark_purge.sql`: `bark_purge_expired()` covering archives, rate-limit windows older than one hour and delivery retention (30 days), plus the `pg_cron` schedule running every five minutes

**Checkpoint**: All five stories are independently functional.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Hardening and the validation the spec's success criteria depend on.

- [X] T050 Run the whole unit suite (`deno test --allow-net --allow-env --allow-read supabase/functions/tests/`) and fix every failure
- [X] T051 [P] Run `deno fmt --check` and `deno lint` over `supabase/functions/` using the tasks in `supabase/functions/deno.json` and fix findings
- [ ] T052 Deploy `supabase/functions/bark/` and `supabase/functions/bark-drain/` to the hosted project with `--no-verify-jwt`, confirm `cron.job` lists both schedules, and verify `/healthz` and `/info` on the hosted URL
- [ ] T053 Execute the real-device acceptance run in [quickstart.md](./quickstart.md) §7 (registration, four request shapes, five rich parameters, ciphertext, credential rotation) and record the timings for SC-001/SC-002/SC-010
- [X] T054 [P] Update `README.md` with the server address format, deploy commands and the operator commands from [quickstart.md](./quickstart.md) §8

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 Setup**: no dependencies
- **Phase 2 Foundational**: depends on Phase 1 — **blocks every story**
- **Phases 3–7 (US1–US5)**: depend on Phase 2; largely independent of each other
- **Phase 8 Polish**: depends on the stories you intend to ship

### Story Dependencies

| Story | Depends on | Notes |
|---|---|---|
| US1 (P1) | Phase 2 | Fully independent — the MVP |
| US2 (P2) | Phase 2; reuses US1's `push.ts` and `params.ts` | Sequence after US1 to avoid duplicating the pipeline |
| US3 (P3) | Phase 2; extends US1's `payload.ts` and `apns.ts` | Rich single-target pushes are testable without US2 |
| US4 (P3) | Phase 2 only | Independent: `misc.ts`, `config.ts`, admin migration, logging |
| US5 (P4) | Phase 2; touches US1's push route | Archive and ciphertext work once `push.ts` exists |

### Within Each Story

Unit tests are written and expected to fail before the module they cover; pure modules before routes; routes before the manual acceptance run.

### Parallel Opportunities

- **Setup**: T002–T006 all `[P]`
- **Foundational**: T010, T012, T013, T015, T016, T017 `[P]`; T011 after T010; T014 after T012; T018 after T010 + T011
- **US1**: T019–T021 `[P]`; T022 and T023 `[P]`; T024/T025 sequential; T027 and T028 pair up
- **US2**: T029 and T030 `[P]`; implementation sequential in `params.ts`/`router.ts`/`push.ts`
- **US3**: T035 and T036 `[P]`; T037–T039 sequential on shared modules
- **US4**: T040 and T041 `[P]`; T042, T043, T044 can proceed in parallel (three distinct files); T045 after T014
- **US5**: T046 first; then T047/T048/T049 — T049 is a separate migration and can run in parallel with T047/T048
- **Polish**: T051 and T054 `[P]`

---

## Parallel Example: User Story 1

```bash
# Tests first, in parallel (T019–T021) — expected to fail
deno test supabase/functions/tests/params_test.ts
deno test supabase/functions/tests/router_test.ts
deno test supabase/functions/tests/retry_rules_test.ts

# Then the two independent modules (T022, T023)
deno test supabase/functions/tests/params_test.ts   # after _shared/params.ts
deno test supabase/functions/tests/payload_test.ts  # after _shared/payload.ts
```

## Parallel Example: Foundational

```bash
# Four independent units + their tests (T012–T017)
#   _shared/jwt.ts   + tests/jwt_test.ts
#   _shared/apns.ts  + tests/apns_test.ts
#   _shared/store.ts
#   _shared/ratelimit.ts
```

---

## Implementation Strategy

### MVP First (User Story 1 only)

1. Phase 1 → Phase 2 → Phase 3
2. Deploy, point one iPhone at `https://<ref>.supabase.co/functions/v1/bark`, register, send a push
3. Validate before continuing: a real notification arriving proves the risky part (APNs over HTTP/2 with ES256 from an Edge Function); everything after is mapping and operations work

### Incremental Delivery

| Increment | Adds | Demonstrable outcome |
|---|---|---|
| MVP (US1) | register, single push, retries | one device receives notifications |
| + US2 | all request shapes, batch, legacy clients | existing tools work unchanged |
| + US3 | rich parameters | notification behaviour matches the reference server |
| + US4 | health, info, admin, logs | operator can run it |
| + US5 | encryption passthrough, archive | privacy and history features |

### Testing Scope (deliberate)

Unit tests cover pure logic: parameter normalisation, payload mapping, JWT signing, APNs classification and headers, route matching, retry rules, envelope shaping, config validation, archive decisions. They do not open connections, do not need a database, and run with `deno test` alone. Anything that requires Postgres, a running function or a real device is verified once, manually, via [quickstart.md](./quickstart.md) — that is the trade accepted here to keep the suite inside the project and free of extra tooling.

---

## Format Validation

| Check | Result |
|---|---|
| Every task starts with `- [ ]` and a sequential ID | Yes — T001–T054, no gaps |
| `[P]` only where files differ and no incomplete dependency | Yes |
| `[US#]` present on every task in Phases 3–7, absent in Phases 1, 2, 8 | Yes |
| Every task names a concrete file path | Yes, all under `supabase/` (plus the existing `README.md`, `.gitignore`) |
| Unit tests only | Yes — all test tasks target `supabase/functions/tests/*_test.ts`; no pgTAP, no script harness, no in-process HTTP suite |
| Nothing created outside the current project | Yes — no `scripts/`, no `docs/`, no `supabase/tests/` |
