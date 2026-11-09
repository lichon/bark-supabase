# Bark Push Server on Supabase

A self-hosted [Bark](https://github.com/Finb/bark-server) push server that runs entirely on
Supabase: one catch-all Edge Function serves the client API, talks to Apple Push Notification
service over HTTP/2 with an ES256 provider token signed in-process, and keeps registrations,
delivery records, archives and rate-limit counters in Postgres. A cron-driven worker retries
transient failures. No container, no long-running process, no queue.

The unmodified Bark iOS app and existing Bark clients work unchanged — no client code, no fork.

- Specification: [`specs/001-bark-server-supabase/spec.md`](specs/001-bark-server-supabase/spec.md)
- Plan and architecture: [`specs/001-bark-server-supabase/plan.md`](specs/001-bark-server-supabase/plan.md)
- API contract: [`specs/001-bark-server-supabase/contracts/http-api.md`](specs/001-bark-server-supabase/contracts/http-api.md)
- APNs contract: [`specs/001-bark-server-supabase/contracts/apns-push.md`](specs/001-bark-server-supabase/contracts/apns-push.md)
- Validation guide: [`specs/001-bark-server-supabase/quickstart.md`](specs/001-bark-server-supabase/quickstart.md)

## Server address

Supabase addresses functions at `/functions/v1/<slug>` and offers no root-path rewrite, so the
address you give the app **includes** that prefix:

```
https://<project-ref>.supabase.co/functions/v1/bark
```

A custom domain only replaces the host; the `/functions/v1/bark` path stays. Every documented
Bark path works under it: `/register`, `/push`, `/ping`, `/healthz`, `/info`, and the V1 forms
`/<key>`, `/<key>/<body>`, `/<key>/<title>/<body>`, `/<key>/<title>/<subtitle>/<body>`.

## Layout

```text
supabase/
├── config.toml                       # project config (api.schemas includes `bark`)
├── seed.sql                          # intentionally empty
├── migrations/
│   ├── 20260101000000_bark_schema.sql   # schema, enums, tables, indexes, RLS deny-all
│   ├── 20260101000100_bark_rpc.sql      # register/lookup device, rate-limit counter
│   ├── 20260101000200_bark_retry.sql    # retry claim RPC + drain schedule
│   ├── 20260101000300_bark_purge.sql    # archive/rate-limit/delivery purge + schedule
│   └── 20260101000400_bark_admin.sql    # disable-a-device RPC + operator view
└── functions/
    ├── deno.json                    # test/fmt/lint tasks, supabase-js import map
    ├── .env.example                 # every variable, no values
    ├── bark/index.ts                # catch-all entrypoint: Deno.serve(handler)
    ├── bark-drain/index.ts          # cron worker: retry due deliveries
    ├── _shared/                     # config, router, params, payload, apns, jwt, store, …
    └── tests/                       # unit tests only (no database, no network)
```

## Tests

Unit tests cover pure logic only — parameter normalisation, payload mapping, ES256 signing,
APNs classification and header derivation through a stub `fetch`, route matching, retry rules,
config validation, archive decisions. They need no database, no Docker and no network.

```bash
deno test --allow-net --allow-env --allow-read supabase/functions/tests/
deno fmt --check
deno lint
```

Or, from `supabase/functions`: `deno task test`, `deno task fmt`, `deno task lint`.

## Local development

```bash
supabase start
supabase db reset                     # applies migrations, then the empty seed
cp supabase/functions/.env.example supabase/functions/.env.local   # fill it in, never commit
supabase functions serve bark --no-verify-jwt --env-file supabase/functions/.env.local
```

Verify with `curl http://127.0.0.1:54321/functions/v1/bark/ping`. The full manual checklist —
including the checks that cross the function/database boundary — is in
[`quickstart.md` §4](specs/001-bark-server-supabase/quickstart.md).

## Deploy

```bash
supabase link --project-ref <ref>
supabase secrets set --env-file supabase/functions/.env.production   # never commit this file
supabase db push
supabase functions deploy bark --no-verify-jwt
supabase functions deploy bark-drain --no-verify-jwt
```

Then confirm:

```bash
curl https://<ref>.supabase.co/functions/v1/bark/healthz     # ok
curl https://<ref>.supabase.co/functions/v1/bark/info        # version, commit, devices
```

### Required configuration

| Variable | Meaning | Required |
|---|---|---|
| `APNS_P8` | PKCS#8 PEM of the Apple provider key (`.p8`) | yes |
| `APNS_KEY_ID` | 10-character key id | yes |
| `APNS_TEAM_ID` | 10-character team id | yes |
| `APNS_TOPIC_IOS` | topic for phone pushes (default `me.fin.bark`) | defaulted |
| `APNS_TOPIC_WATCH` | topic for watch pushes (default `me.fin.bark.watch`) | defaulted |
| `APNS_ENV` | `production` (default) or `sandbox` | no |
| `BARK_SERVER_TOKEN` | optional shared access credential | no |
| `BARK_DELIVERY_RETENTION_DAYS` | delivery record retention (default 30) | no |
| `BARK_VERSION`, `BARK_BUILD`, `BARK_COMMIT` | reported by `/info` | no |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | injected by the platform | yes |

`/healthz` returns `503` naming the missing or unusable variable; it never echoes a value.

### Enabling the scheduled jobs

`20260101000200_bark_retry.sql` posts to `bark-drain` every minute and
`20260101000300_bark_purge.sql` purges every five minutes. Both need `pg_cron` (and `pg_net`
for the drain). The migrations create them when the project allows it and print a notice
otherwise. The drain reads its URL and credential from Vault, so set them once per project:

```sql
select vault.create_secret(
  'https://<ref>.supabase.co/functions/v1/bark-drain', 'bark_functions_url');
select vault.create_secret('<service-role-key>', 'bark_service_role_key');
```

Confirm with `select jobname, schedule, active from cron.job;`.

### APNs credentials

APNs only delivers a push whose `apns-topic` is an app id owned by the team that signed the
provider token. The App Store Bark app's tokens belong to `me.fin.bark`, so a stock deployment
uses the provider key the Bark project publishes (key id `LH4T9V5U4R`, team id `5U8LBRXG3A`);
see [research D3](specs/001-bark-server-supabase/research.md). Operators with a licensed app can
substitute their own values — it is a `supabase secrets set` operation with no code change.

## Operator commands

| Task | Command |
|---|---|
| List registrations | `select device_key, device_kind, created_at, updated_at, invalidated_at, disabled_at from bark.device_status order by updated_at desc;` |
| Disable a device | `select bark_disable_device('<key>');` — later pushes return `400 "device is disabled"`, a new registration re-enables it |
| Diagnose a missing notification | `select status, attempt_count, apns_status, apns_reason, apns_id, created_at from bark.delivery where device_key = '<key>' order by created_at desc limit 5;` |
| Inspect archives | `select id, device_key, expires_at from bark.archive order by created_at desc;` |
| Run expiry now | `select bark_purge_expired();` |
| Check schedules | `select jobname, schedule, active from cron.job;` |
| Confirm no leakage | `supabase functions logs bark --tail` — structured JSON lines with delivery id, hashed device key, APNs status/reason and latency; never a token, message body, ciphertext or credential |

## Data and security

Everything lives in the `bark` schema. The schema is listed in `[api] schemas` because the Edge
Functions reach Postgres through PostgREST, but it is closed to clients by two independent
mechanisms: row level security is **enabled with no policies**, and every privilege is revoked
from `anon` and `authenticated`. Only `service_role` can read or write. Message content is
stored only while a retry is still possible, and in `bark.archive` when the sender asks for it.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `/healthz` → `503` with a variable name | that secret is missing, or `APNS_P8` will not import |
| `DeviceTokenNotForTopic` | configured topic does not match the app that owns the token |
| `404` on every path | the app's server address is missing `/functions/v1/bark` |
| `401` on every path | `BARK_SERVER_TOKEN` is set and the client is not sending it |
| Pushes stop after a key rotation | the isolate cache re-signs within 50 minutes or on the first `ExpiredProviderToken` |
