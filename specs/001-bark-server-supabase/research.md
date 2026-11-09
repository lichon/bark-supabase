# Phase 0 Research: Bark Push Server on Supabase

**Feature**: `001-bark-server-supabase` | **Date**: 2026-11-09

Findings from the reference implementation and Supabase platform documentation. Each decision records what was chosen, why, and what else was evaluated. No open clarifications remain.

## Reference behaviour baseline

The compatibility target is `Finb/bark-server` v2. Facts used throughout:

| Fact | Source |
|---|---|
| Endpoints registered by the reference server: `/` (ok), `/ping`, `/healthz`, `/info`, `POST /register`, `GET /register` (legacy query), `GET /register/:device_key`, `POST /push`, and V1 `GET`/`POST` on `/:device_key`, `/:device_key/:body`, `/:device_key/:title/:body`, `/:device_key/:title/:subtitle/:body` | [router.go](https://github.com/Finb/bark-server/blob/master/router.go), [route_push.go](https://github.com/Finb/bark-server/blob/master/route_push.go), [route_misc.go](https://github.com/Finb/bark-server/blob/master/route_misc.go), [route_register.go](https://github.com/Finb/bark-server/blob/master/route_register.go) |
| Response envelope: `{code, message, data?, timestamp}`; success is `code: 200, message: "success"`; `/ping` returns `message: "pong"` | router.go |
| Parameter precedence: URL path highest, then POST/form values, then query values | route_push.go |
| Parameter normalisation: `sound` gets `.caf` appended unless already suffixed; unknown keys become custom payload fields, lower-cased; `delete=1` becomes a silent background push | route_push.go, [apns/apns.go](https://github.com/Finb/bark-server/blob/master/apns/apns.go) |
| Payload: `aps.alert.{title,subtitle,body}`, `sound`, `thread-id` from `group`, `mutable-content: 1`, category `myNotificationCategory`, all custom params as lower-cased strings | apns/apns.go |
| Invalid token handling: HTTP 410, or 400 `BadDeviceToken` → token cleared for that key | route_push.go |
| Push request headers: `apns-topic` per device type, `apns-collapse-id` from `id`, 24 h expiration, push type `alert` (or `background` for delete) | apns/apns.go |
| Batch push: `device_keys` accepts a comma string or array; a single key uses `device_key`; per-device results returned in `data[]` with `{code, message, device_key}` | route_push.go |
| Registration: optional `device_key` is preserved, otherwise generated; token required; token length capped at 160; device type `ios` (default) or `watchos`; response carries `key` and `device_key` aliases | route_register.go |
| APNs topics baked into the reference server: `me.fin.bark` and `me.fin.bark.watch`, key id `LH4T9V5U4R`, team id `5U8LBRXG3A` | apns/apns.go, [apns/apns_certs.go](https://github.com/Finb/bark-server/blob/master/apns/apns_certs.go) |
| iOS app builds every request as `baseURL = server.address` plus a path (`Moya` target with `baseURL`, `path`), so a server address containing a path prefix is used verbatim | [BarkTargetType.swift](https://github.com/Finb/Bark/blob/master/Common/Moya/BarkTargetType.swift) |
| Documented parameter set: `title`, `subtitle`, `body`, `level`, `volume`, `badge`, `call`, `autoCopy`, `copy`, `sound`, `icon`, `group`, `ciphertext`, `isArchive`, `ttl`, `url`, `action` | [API_V2.md](https://github.com/Finb/bark-server/blob/master/docs/API_V2.md) |

## D1 — URL shape: one catch-all function, prefix kept in the base address

**Decision**: Deploy a single Edge Function named `bark`. Users configure the server address as
`https://<project-ref>.supabase.co/functions/v1/bark` (or the custom-domain equivalent). The router strips everything up to and including the function slug, then dispatches on the remainder (`/register`, `/push`, `/<key>/...`). `/functions/v1/bark/ping`, `/functions/v1/bark/<key>/<body>` etc. work unchanged.

**Rationale**: Supabase Edge Functions are addressed at `/functions/v1/<slug>` and provide no root-path rewrite; the platform's own guidance is that a single function can host a whole REST API by routing on pathname. The Bark app takes the configured address as a base URL and appends paths, so a path prefix is preserved rather than dropped.

**Alternatives considered**:
- One function per endpoint (`register`, `push`, …): rejected — each adds a URL segment, so the address would no longer be a plausible Bark server, and it multiplies cold starts.
- Root-path exposure via a reverse proxy (Cloudflare Worker / VPS in front): rejected for v1 — it adds infrastructure the spec forbids and a component the operator must secure. Documented as an optional add-on for a vanity domain.
- Custom domain add-on alone: rejected as insufficient — the custom domain replaces the host, not the `/functions/v1/<slug>` path.

## D2 — APNs transport: runtime `fetch` over HTTP/2, ES256 JWT via Web Crypto

**Decision**: Implement a small APNs client (`_shared/apns.ts`) that signs an ES256 provider token with `crypto.subtle` (P-256, PKCS#8 import) and posts to `https://api.push.apple.com/3/device/<token>` (or the sandbox host) with `fetch`. Cache the signed token per isolate for 50 minutes.

**Rationale**: APNs requires HTTP/2 with TLS, a bearer JWT in the `authorization` header, and `apns-topic`/`apns-push-type` headers. The Deno-based runtime's `fetch` negotiates HTTP/2 to APNs, and Web Crypto returns ECDSA signatures in the raw `r||s` form JWT needs, so no library and no DER-to-raw conversion are required. APNs accepts one provider token for an hour and throttles refreshes faster than every 20 minutes, so a 50-minute module-scope cache is both safe and necessary when handling bursts.

**Alternatives considered**:
- npm APNs clients (`apns2`, `@bagatka/apns`): rejected — extra dependency surface, some require Node's `http2` module, and the signing work is ~40 lines.
- Certificate-based APNs auth: rejected — deprecated by Apple for token flows, and rotating a `.p12` is worse than rotating a `.p8`.
- Sending via a third-party push relay: rejected — defeats the purpose of a self-hosted server and adds a data processor.

## D3 — APNs credentials: use the upstream-published Bark key by default, override via secrets

**Decision**: Ship the provider key, key id, team id and topics as **required secrets** (`APNS_P8`, `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_TOPIC_IOS`, `APNS_TOPIC_WATCH`). The documented values for a stock deployment are the ones the reference server publishes: key id `LH4T9V5U4R`, team id `5U8LBRXG3A`, topics `me.fin.bark` and `me.fin.bark.watch`, with the `.p8` copied from upstream. `APNS_ENV` selects `production` (default) or `sandbox`.

**Rationale**: APNs only delivers a push whose `apns-topic` is an app id owned by the team that signed the provider token. The unmodified App Store Bark app's tokens belong to `me.fin.bark`. An operator-generated key from a different team therefore cannot deliver to that app (`DeviceTokenNotForTopic`); the only two ways to keep the client unmodified are the upstream-published key, or shipping a differently signed client. `bark-server` itself relies on exactly this arrangement, which is why self-hosted instances work without any Apple account.

**Impact on the spec**: the spec's "Push credentials available" assumption reads as if the operator obtains their own Apple credentials. That is factually impossible for the stock app; the operative assumption is that the operator supplies *the Bark app's* provider key (from upstream or from the app owner). Flagged for confirmation before implementation; the design keeps the values in secrets either way.

**Alternatives considered**:
- Operator-owned Apple key with an operator-built client: rejected — out of scope by FR-024 (unmodified official app).
- Bundling the key in the repository: rejected — a `.p8` in git is a credential leak and makes rotation a code change (violates FR-019/SC-010).

## D4 — Persistence: Postgres via the service role inside the function, RLS deny-all for clients

**Decision**: All state lives in `bark_*` tables (see data-model). The Edge Function uses the platform-provided service-role credential to call the database through RPC functions and table access; RLS is enabled with **no** policies for `anon`/`authenticated`, so the public Data API cannot read devices, archives or delivery records even if someone holds the publishable key.

**Rationale**: Registration tokens and archive content are sensitive; the client interface is the only intended surface. Keeping the Data API closed means a leaked publishable key grants nothing. RPCs (`bark_register_device`, `bark_lookup_device`, `bark_hit_rate_limit`, `bark_claim_retries`, `bark_purge_expired`) give the function a narrow, testable contract and keep multi-statement logic atomic.

**Alternatives considered**: direct table access from the function with no RPCs — rejected for the rate limiter and retry claim, which need atomicity; exposing tables through RLS with per-key policies — rejected, there is no user identity in the Bark protocol to authorise against.

## D5 — Retries and expiry: delivery table + `pg_cron` drain, archives purged by SQL

**Decision**: The happy path writes one `bark_delivery` row and returns after the APNs response. Failures classified as transient (`429`, `5xx`, timeouts, connection errors) are left `pending` with `next_attempt_at`; a cron job invokes `bark-drain` every minute, which claims due rows with `FOR UPDATE SKIP LOCKED` (max 3 attempts, exponential backoff, minimum 15 minutes after a server error per Apple's guidance) and clears them on success or terminal failure. Archive rows carry `expires_at`; a second cron job runs `bark_purge_expired()` every five minutes.

**Rationale**: A request that already answered cannot retry itself; cron + a claim RPC is idempotent under overlap and produces no duplicates because only failed attempts are re-sent. Supabase Cron's documented pattern for invoking a function is `pg_cron` + `pg_net`, with the project URL and secret key in Vault.

**Alternatives considered**: Supabase Queues (pgmq) — a good fit and a reasonable later optimisation, rejected for v1 because the state to retry is a row that already exists and a `SKIP LOCKED` claim needs no extra extension; client-side retries — rejected, third-party integrations do not implement them; dead-letter table — covered by terminal failure rows rather than a separate store.

## D6 — Rate limiting: atomic counters in Postgres

**Decision**: `bark_hit_rate_limit(bucket, limit, window_seconds)` performs an upsert-increment on `bark_rate_limit` and returns `allowed` plus `retry_after`. Buckets are per device key (push) and per client address (registration). Rejections return the Bark envelope with `code: 429` and a `Retry-After` header.

**Rationale**: Functions are stateless and horizontally scaled, so an in-memory limiter is unreliable; a single-statement upsert in Postgres is atomic, cheap at this volume, and needs no new service. Bucket rows are cleaned by the same purge job.

**Alternatives considered**: Upstash/Redis — rejected (new external dependency and a second place to keep secrets); platform gateway limits — not configurable per endpoint, and they produce platform-shaped errors instead of the Bark envelope.

## D7 — Configuration and secret hygiene

**Decision**: Configuration is read once in `_shared/config.ts` from Edge Function secrets, validated at first use, and missing values produce an explicit error naming the variable (never a silent fallback). `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` are platform-injected. Logs are structured JSON containing delivery id, device key hash, APNs status/reason and latency — never tokens, ciphertext, message content, or credentials.

**Rationale**: FR-019/FR-020 and SC-006 require actionable failures without leaking secrets; the readiness endpoint (`/healthz`) reports credential presence and validity age, not values.

**Alternatives considered**: Supabase Vault for APNs credentials — Vault is reachable from SQL but the function would need a DB read per cold start; Edge secrets are the documented place for function configuration. Vault is still used for the cron → function invocation URL and key.

## D8 — Testing strategy

**Decision**: Three layers. (1) `deno test` unit tests for parameter normalisation, payload mapping, JWT signing (asserting header/claims and verifying the signature with the derived public key), error classification, and the router (prefix stripping, method matrix, 404/405). (2) HTTP contract tests that run the handler in-process against `helpers/apns_stub.ts` — a local HTTP/2 server returning scripted APNs responses (200, 400 `BadDeviceToken`, 410, 429, 503, timeout) — covering every documented request shape. (3) Database tests with pgTAP for constraints, RLS deny-all, and RPC behaviour (rate limit windows, retry claim exclusivity, purge). `scripts/smoke.sh` exercises the same contract against `supabase functions serve` for a human-checkable run, plus one manual real-device pass on the hosted project for SC-001/SC-002.

**Rationale**: Real APNs cannot be scripted for failure modes, and sending real pushes in CI would hit Apple's production service. Injectable transport is required to test retry and invalid-token behaviour at all; the stub also makes SC-008 (burst) reproducible.

**Alternatives considered**: emulator-only tests — rejected, the seam is APNs and the request shapes; mocking at module level with `Deno.test.stub` for the whole client — rejected in favour of a transport-level stub that still exercises header construction and HTTP/2 framing.

## D9 — Version and `/info`

**Decision**: `/info` reports `version`, `build`, `arch` (runtime platform), `commit` and `devices` (count of live registrations). Version comes from a `BARK_VERSION` secret defaulting to the package version; `commit` from a `BARK_COMMIT` secret set at deploy time.

**Rationale**: The reference endpoint's shape is part of the client contract; the fields are cheap and make deployments identifiable, satisfying FR-015 without exposing configuration details.
