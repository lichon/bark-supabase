# Implementation Plan: Bark Push Server on Supabase

**Branch**: `001-bark-server-supabase` | **Date**: 2026-11-09 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/001-bark-server-supabase/spec.md`

## Summary

Re-implement the reference Bark server (`Finb/bark-server`) as a Supabase-native deployment so the unmodified Bark iOS app and existing Bark clients can point at a Supabase project and receive APNs notifications. One catch-all Edge Function serves the whole client-visible interface (registration, single and batch push in all documented request shapes, health/info), talks to Apple's push service over HTTP/2 with an ES256 provider token signed in-process, and stores registrations, delivery outcomes, archives and rate-limit counters in Postgres. A cron-driven drain function retries transient delivery failures and a SQL job purges expired archives. No long-running process, no container, no external queue.

## Technical Context

**Language/Version**: TypeScript on Deno 2 (Supabase Edge Runtime); SQL for Postgres 17 migrations

**Primary Dependencies**: Supabase Edge Runtime + `supabase-js` v2 (service role), Web Crypto (`crypto.subtle`) for ES256 provider tokens, Supabase CLI for migrations/deploy. No APNs client library — APNs is HTTP/2 + JWT, both native to the runtime.

**Storage**: Supabase Postgres (device registrations, delivery records, archive, rate-limit counters); APNs credentials only in Edge Function secrets / Vault

**Testing**: `deno test` unit tests only, all in `supabase/functions/tests/`. Modules are kept pure so they can be tested without a database or network: parameter normalisation, payload mapping, JWT signing, APNs classification and header derivation (stub `fetch` function), route matching, retry rules, response envelope, config validation and archive decisions. End-to-end behaviour (real APNs, real device, cron jobs) is verified manually with [quickstart.md](./quickstart.md); no pgTAP suite, no shell harness, no extra tooling.

**Target Platform**: Hosted Supabase project (Edge Functions + Postgres + Cron); local Supabase stack for development. Clients are iOS devices on the App Store Bark app — no client code changes.

**Project Type**: Serverless web service (HTTP API inside one Edge Function + one cron-invoked worker function)

**Performance Goals**: p95 from request accepted to APNs handoff under 1.5 s; burst of 500 requests in 10 s with ≥99 % accepted-or-rate-limited and ≥95 % delivered within 15 s; single push handled in one function invocation (no queue hop on the happy path)

**Constraints**:
- APNs payload limit is 4096 bytes; larger payloads are rejected before the network call.
- Tests are unit tests inside `supabase/functions/tests/`; nothing is added outside the `supabase/` project except edits to the existing `README.md`.
- APNs speaks HTTP/2 only; the runtime's `fetch` negotiates h2 (no workaround needed).
- Edge Functions are per-request and stateless: provider tokens must be cached per isolate (≤1 h validity, refresh no more often than every 20 min).
- Supabase Edge Functions expose functions under `/functions/v1/<slug>` and offer no root-path rewrite; the client-visible base path therefore includes that prefix. Verified acceptable because the Bark app builds request URLs from the configured server address as a base URL plus a path.
- The APNs topic must match the bundle id of the app whose token is being pushed; the App Store Bark app's topics are fixed (`me.fin.bark`, `me.fin.bark.watch`), so the provider key must belong to that team — see research D3.
- No service-role key or device token may appear in logs, responses or the repository.

**Scale/Scope**: 1 deployment serving tens of devices and up to a few thousand notifications per day; 2 Edge Functions, 4 tables, 3 SQL migrations, ~8 shared modules

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` is the unratified scaffold: every principle, section and governance clause is still a bracketed placeholder (`[PRINCIPLE_1_NAME]`, `[SECTION_2_CONTENT]`, `[GOVERNANCE_RULES]`). There are therefore **no enforceable project principles to gate against**, and no violation can be recorded — the file needs a `/speckit.constitution` pass before it can constrain future work.

Rather than skip the gate, the plan holds itself to the obligations that the spec and platform impose, and these are checked in review:

| Gate (substitute) | Status | Evidence |
|---|---|---|
| No credential or device token in the repository | Pass | Credentials arrive as Edge secrets; `.env` files are gitignored; migrations contain no secrets |
| Client-visible data is not readable without authorisation | Pass | RLS deny-all on all `bark_*` tables for `anon`/`authenticated`; function uses service role only |
| Every requirement traces to the spec | Pass | Contract sections carry FR ids; see [contracts/http-api.md](./contracts/http-api.md) |
| No new long-running infrastructure | Pass | Edge Functions + Cron only |
| Documented, testable behaviour over guessed behaviour | Pass | Contracts pinned to upstream API_V2 and route handlers, deviations listed in research |

**Post-Phase 1 re-check**: unchanged — no principle was introduced by the design, and the substitute gates still hold (see Complexity Tracking: one justified deviation, the APNs key source).

## Project Structure

### Documentation (this feature)

```text
specs/001-bark-server-supabase/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/
│   ├── http-api.md      # Client-visible interface contract
│   └── apns-push.md     # Outbound APNs contract
└── checklists/
    └── requirements.md
```

### Source Code (repository root)

```text
supabase/
├── config.toml                       # existing project config (ports, db version)
├── migrations/
│   ├── 20260101000000_bark_schema.sql    # tables, indexes, RLS deny-all
│   ├── 20260101000100_bark_rpc.sql       # register/lookup device, rate-limit counter
│   ├── 20260101000200_bark_retry.sql     # retry claim RPC + drain schedule
│   ├── 20260101000300_bark_purge.sql     # archive/rate-limit/delivery purge + schedule
│   └── 20260101000400_bark_admin.sql     # disable device + operator status view
├── functions/
│   ├── bark/
│   │   └── index.ts                  # single entrypoint: Deno.serve(router)
│   ├── bark-drain/
│   │   └── index.ts                  # cron worker: retry due deliveries
│   ├── _shared/
│   │   ├── config.ts                 # env parsing, fail-fast on missing credentials
│   │   ├── router.ts                 # prefix stripping + method/path dispatch
│   │   ├── params.ts                 # V1/V2 parameter normalisation
│   │   ├── response.ts               # CommonResp envelope, error mapping
│   │   ├── apns.ts                   # headers, classification, retry rules, HTTP/2 send
│   │   ├── jwt.ts                    # ES256 provider token + isolate cache
│   │   ├── payload.ts                # bark params -> APNs payload
│   │   ├── store.ts                  # device/delivery/archive persistence
│   │   └── ratelimit.ts              # counter RPC wrapper
│   └── tests/                        # unit tests only
│       ├── jwt_test.ts
│       ├── apns_test.ts
│       ├── router_test.ts
│       ├── params_test.ts
│       ├── params_v1_test.ts
│       ├── params_validation_test.ts
│       ├── payload_test.ts
│       ├── payload_rich_test.ts
│       ├── batch_test.ts
│       ├── retry_rules_test.ts
│       ├── archive_test.ts
│       ├── misc_test.ts
│       ├── config_test.ts
│       └── fixtures.ts
│   └── .env.example                  # variable names and descriptions only
└── seed.sql                          # intentionally empty (no seed data ships)
```

**Structure Decision**: Single serverless project rooted at `supabase/`, which already exists in this repository and is where the CLI expects functions, migrations and tests; nothing is created outside it. The interface lives entirely in one function (`bark`) because routing is path-based and each extra function would add a URL segment and a cold start; the retry worker is split out (`bark-drain`) because it is invoked by cron, not by clients, and must be excluded from the public routing table. Shared code sits in `_shared/` (the Supabase convention: directories starting with `_` are not deployed as functions). Tests are unit tests in `supabase/functions/tests/`, colocated with the code they cover.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| Deployment uses the upstream-published Bark APNs provider key rather than an operator-owned Apple key (see research D3) | The unmodified App Store Bark app only accepts pushes whose `apns-topic` is its own bundle id, and APNs only honours tokens minted by the team that owns that bundle id. An operator-generated key cannot push to `me.fin.bark`. | Requiring an operator-owned key would require a self-built and self-signed Bark client, which the spec explicitly excludes (unmodified official app, FR-024). Credentials remain env-overridable so an operator with a licensed app can substitute them. |
| Second Edge Function (`bark-drain`) plus cron schedules | Retries and archive expiry cannot run inside a request that already returned; the spec requires transient retries without duplicates (FR-022) and automatic expiry (FR-023, SC-009). | Inline retry inside the request would exceed useful response latency and could not honour APNs' 15-minute backoff after a server error. |

## Phase 0 — Research

See [research.md](./research.md). Decisions D1–D9 resolve the routing prefix, APNs transport, credential source, persistence access, retry/DLQ shape, rate limiting, archive purge, testing strategy and log hygiene. No `NEEDS CLARIFICATION` items remain in Technical Context.

## Phase 1 — Design

- Data model: [data-model.md](./data-model.md)
- Client contract: [contracts/http-api.md](./contracts/http-api.md)
- Outbound contract: [contracts/apns-push.md](./contracts/apns-push.md)
- Validation guide: [quickstart.md](./quickstart.md)
