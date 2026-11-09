# Quickstart & Validation Guide: Bark Push Server on Supabase

**Feature**: `001-bark-server-supabase` | **Date**: 2026-11-09

Runnable checks that prove the feature works. Implementation detail lives in [data-model.md](./data-model.md), [contracts/http-api.md](./contracts/http-api.md) and [contracts/apns-push.md](./contracts/apns-push.md); this file only says how to run and what to expect.

## Prerequisites

| Tool / asset | Why | Check |
|---|---|---|
| Supabase CLI ≥ the version in `.specify/init-options.json` era (`2.x`) | migrations, local stack, deploy | `supabase --version` |
| Docker running | local stack containers | `docker info` |
| Deno 2.x | unit and contract tests | `deno --version` |
| `curl`, `jq` | smoke tests | `curl --version`, `jq --version` |
| APNs provider key (`.p8`) + key id + team id | real delivery | see research D3 |
| An iPhone with the Bark app | real-device acceptance | — |
| A hosted Supabase project | the deliverable target | `supabase projects list` |

Local development never needs the Apple credentials: the APNs transport is replaced by a stub in tests and by `APNS_ENV=sandbox`-style configuration in the local stack only for the manual path.

## 1. Start the local stack

```bash
cd supabase-checkout-root
supabase start          # first run pulls images; note the printed API URL and keys
supabase db reset        # applies supabase/migrations/* then seed.sql (empty)
```

Expected: `db reset` reports all migrations applied with no errors; `select * from bark.device;` returns zero rows; `anon` cannot read it (`permission denied` / empty result under RLS).

## 2. Configure secrets locally

```bash
# supabase/functions/.env.local  (gitignored)
APNS_P8="$(cat /path/to/AuthKey_XXXXXXXXXX.p8)"
APNS_KEY_ID=XXXXXXXXXX
APNS_TEAM_ID=YYYYYYYYYY
APNS_TOPIC_IOS=me.fin.bark
APNS_TOPIC_WATCH=me.fin.bark.watch
APNS_ENV=production
BARK_VERSION=dev
BARK_COMMIT="$(git rev-parse --short HEAD)"

supabase functions serve bark --no-verify-jwt --env-file supabase/functions/.env.local
supabase functions serve bark-drain --no-verify-jwt --env-file supabase/functions/.env.local
```

Expected: both functions report listening; requesting `/functions/v1/bark/ping` returns `pong`.

## 3. Automated tests (unit only)

```bash
deno test --allow-net --allow-env --allow-read supabase/functions/tests/
```

Expected: every test file in `supabase/functions/tests/` passes. The suite covers pure logic only — parameter normalisation and precedence, payload mapping for each documented parameter, ES256 signing (verified against the derived public key), APNs status classification and header derivation through a stub `fetch` function, route matching and prefix stripping, retry/backoff rules, the response envelope, config validation (a missing variable is named, never echoed) and archive/TTL decisions. No test opens a connection or needs the database, so no extra tooling is required beyond `deno test`.

## 4. Manual contract checks against the local stack

Run these by hand once after the unit suite; they are the checks that cannot be a unit test because they cross the function/database boundary. Use `BASE=http://127.0.0.1:54321/functions/v1/bark`.

```bash
curl -s "$BASE/"                                    # 1  ok
curl -s "$BASE/ping"                                 # 2  {code:200,message:"pong",...}
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/healthz"   # 3  200
curl -s "$BASE/info"                                 # 4  version/devices, no secrets
curl -s -X POST "$BASE/register" -H 'content-type: application/json' \
  -d '{"device_token":"<64 hex chars>","device_key":"<key>"}'   # 5  key returned
curl -s -X POST "$BASE/register" -H 'content-type: application/json' \
  -d '{"device_token":"<new token>","device_key":"<same key>"}' # 6  same key
curl -s "$BASE/register/<key>"                       # 7  200 success
curl -s -X POST "$BASE/push" -H 'content-type: application/json' \
  -d '{"device_key":"<key>","title":"t","body":"b"}'          # 8  accepted
curl -s "$BASE/<key>/t/b"                            # 9  same result as 8
curl -s -X POST "$BASE/<key>" -d 'body=b&group=g&sound=minuet'  # 10 form shape
curl -s -X POST "$BASE/push" -H 'content-type: application/json' \
  -d '{"device_keys":["<key>","<key2>"],"body":"b"}'          # 11 data[] per key
curl -s "$BASE/<unknown>/b"                          # 12 400, no APNs call
curl -s -X POST "$BASE/push" -d "{\"device_key\":\"<key>\",\"body\":\"$(head -c 6000 /dev/zero | tr '\0' a)\"}"  # 13 400
for i in $(seq 70); do curl -s -o /dev/null -w '%{http_code} ' "$BASE/<key>/burst"; done  # 14 first 60 ok, then 429
curl -s -o /dev/null -w '%{http_code}\n' -X DELETE "$BASE/push"   # 15 405
```

| # | Check | Expected | Success criterion |
|---|---|---|---|
| 1 | `GET /` | body `ok` | SC-005 |
| 2 | `GET /ping` | `{code:200,message:"pong"}` | FR-015 |
| 3 | `GET /healthz` | `200 ok` (fails loudly when a secret is missing) | FR-015 |
| 4 | `GET /info` | `version`, `devices` present, no secrets | FR-015 |
| 5 | `POST /register` with a fake token | key + `device_key` alias returned | SC-003 |
| 6 | Re-register same key, new token | same key, token updated, `updated_at` moved | FR-002 |
| 7 | `GET /register/<key>` | `200 success`; unknown key → `400` | FR-004 |
| 8 | `POST /push` with `device_key` + title/body | accepted | FR-007 |
| 9 | `GET /<key>/<title>/<body>` | same acceptance as #8 | SC-004 |
| 10 | `POST /<key>` form-encoded with `group`, `sound`, `badge` | accepted, payload mapped | SC-004 |
| 11 | `POST /push` with `device_keys: ["k1","k2"]` | `data[]` with one entry per key | FR-008 |
| 12 | `POST /push` with unknown key | `400`, no APNs call recorded | FR-013 |
| 13 | `POST /push` with 6 KB body | `400`, no APNs call | edge case |
| 14 | 70 rapid pushes to one key | first 60 accepted, remainder `429` + `Retry-After` | SC-008 |
| 15 | `DELETE /push` (wrong method) | `405` + `Allow` | contract |

## 5. Retry and archive checks (local)

```bash
# point the stub at a 503 for this key, send one push, then inspect
psql "$LOCAL_DB_URL" -c "select status, attempt_count, next_attempt_at from bark.delivery order by created_at desc limit 1;"
# expect: status = pending, attempt_count = 1, next_attempt_at ≈ now() + 1 min
# trigger the worker early instead of waiting for cron:
curl -s -X POST "$BASE/functions/v1/bark-drain" -H "apikey: $SERVICE_KEY"
psql "$LOCAL_DB_URL" -c "select status from bark.delivery order by created_at desc limit 1;"

# archive with ttl
curl -s "$BASE/<key>/<title>/<body>?isArchive=1&ttl=60"
psql "$LOCAL_DB_URL" -c "select expires_at - created_at as lifetime from bark.archive;"
psql "$LOCAL_DB_URL" -c "select bark_purge_expired();"   # or wait for the cron job
psql "$LOCAL_DB_URL" -c "select count(*) from bark.archive;"   # expect 0 after expiry
```

Expected: transient failure leaves a pending row with a future `next_attempt_at`; a delivered row is never re-attempted; the archive row disappears at expiry.

## 6. Deploy to the hosted project

```bash
supabase link --project-ref <ref>
supabase secrets set --env-file supabase/functions/.env.production   # never commit this file
supabase db push
supabase functions deploy bark --no-verify-jwt
supabase functions deploy bark-drain --no-verify-jwt
```

The cron jobs created by the migration call `bark-drain` and `bark_purge_expired()`; confirm with `select jobname, schedule, active from cron.job;`.

Expected: `curl https://<ref>.supabase.co/functions/v1/bark/healthz` returns `ok` within a minute of deploy; `/info` reports the deployed version and commit.

## 7. Real-device acceptance (the only test that proves SC-001/SC-002)

In the Bark app: add a server with address
`https://<ref>.supabase.co/functions/v1/bark`, allow notifications.

1. The app registers on its own and shows a key and test URL — no copying of keys, no extra prompts. Time it: **under 5 minutes** from app install.
2. Run the test command the app shows. Expect the notification within **5 seconds**.
3. Send the same notification via `GET /<key>/<title>/<body>` and via `POST /push` JSON. Both should arrive; the phone cannot tell them apart.
4. Send one with `group=test`, one with `sound=minuet`, one with `badge=3`, one with `url=https://bark.day.app`, one with `level=timeSensitive`. Confirm grouping, sound, badge, tap-through, and delivery during a Focus mode.
5. Send `ciphertext` from a client configured with the same key as the app. Expect the app to decrypt it; confirm the server never logged the plaintext (`supabase functions logs bark | grep -i ciphertext` → no content).
6. Rotate the APNs key (`supabase secrets set APNS_P8=… APNS_KEY_ID=…`) and send again. Expect delivery to resume within 5 minutes without code changes (SC-010).

## 8. Operator checks

| Task | How | Expect |
|---|---|---|
| List registrations | `select device_key, device_kind, created_at, updated_at, invalidated_at, disabled_at from bark.device order by updated_at desc;` | newest first; no tokens shown |
| Disable a device | `select bark_disable_device('<key>');` | subsequent pushes → `400 "device is disabled"`; new registration re-enables |
| Diagnose a missing notification | `select * from bark.delivery where device_key = '<key>' order by created_at desc limit 5;` | status, `apns_status`, `apns_reason`, `apns_id`, attempts — under 5 minutes (SC-006) |
| Confirm no secret leakage | `supabase functions logs bark --tail` after a push | structured lines with delivery id, status, latency; no token, no content, no key material |

## Failure modes worth knowing

- **`/healthz` returns 503 with a variable name** — that secret is missing or the `.p8` will not import. Pushes will also fail; fix the secret before debugging anything else.
- **APNs `DeviceTokenNotForTopic`** — the configured topic does not match the app that owns the device token (see research D3).
- **`404` for every path** — the server address is missing the `/functions/v1/bark` prefix.
- **`401` on every path** — `BARK_SERVER_TOKEN` is configured but the client is not sending it; either add the credential or unset it.
