# Contract: Client-visible HTTP API

**Feature**: `001-bark-server-supabase` | **Version**: 1 (compatible with `Finb/bark-server` API v1 + v2)

This is the interface the Bark iOS app and existing integrations already speak. It is frozen for this feature: clients do not change (FR-024, FR-025).

## Base address

```
https://<project-ref>.supabase.co/functions/v1/bark
```

Everything below is relative to that base. `/functions/v1/bark` is part of the configured server address; the router strips it and dispatches on the remainder. A custom domain (should the project add one) only replaces the host; the `/functions/v1/bark` path remains.

## Response envelope

Every JSON response (except `/`, `/healthz`, which return plain text) uses the reference envelope:

```json
{ "code": 200, "message": "success", "data": {}, "timestamp": 1762732800 }
```

- `code` — HTTP status repeated in the body, an integer.
- `message` — `"success"`, `"pong"`, or a human-readable reason.
- `data` — present only when the endpoint returns a payload (registration, batch results).
- `timestamp` — Unix seconds.

The HTTP status line matches `code` (FR-014). Registration, notification and health responses are never cached: `cache-control: no-store`.

## Endpoints

| Method | Path | Purpose | Reqs |
|---|---|---|---|
| `GET` | `/` | Liveness text `ok` | FR-015 |
| `GET` | `/ping` | `{code:200,message:"pong",timestamp}` | FR-015 |
| `GET` | `/healthz` | Readiness: `ok` when credentials load and are usable, otherwise `503` with the reason | FR-015 |
| `GET` | `/info` | `{version, build, arch, commit, devices}` | FR-015 |
| `POST` | `/register` | Register or refresh a device (JSON or form body) | FR-001–FR-003 |
| `GET` | `/register` | Legacy registration via query parameters | FR-003 |
| `GET` | `/register/{device_key}` | Existence check → `success` or `400` | FR-004 |
| `POST` | `/push` | Notification with the key in the body (v2) | FR-007, FR-008, FR-009 |
| `GET`/`POST` | `/{device_key}` | Notification with key only | FR-009 |
| `GET`/`POST` | `/{device_key}/{body}` | Key + body | FR-009 |
| `GET`/`POST` | `/{device_key}/{title}/{body}` | Key + title + body | FR-009 |
| `GET`/`POST` | `/{device_key}/{title}/{subtitle}/{body}` | Key + title + subtitle + body | FR-009 |

Unmatched paths → `404` with the envelope; wrong method on a matched path → `405` with `Allow`. Neither is an APNs error and neither is billed as a push.

## Registration

Request fields (JSON body or form/query, both accepted for compatibility):

| Field | Type | Required | Rules |
|---|---|---|---|
| `device_token` | string | yes | 1–160 characters; legacy alias `devicetoken` accepted |
| `device_key` | string | no | 6–32 chars `[A-Za-z0-9]`; legacy alias `key`; preserved if supplied |
| `device_type` | string | no | `ios` (default) or `watchos`; anything else → `400` |

`200` response:

```json
{
  "code": 200,
  "message": "success",
  "data": {
    "key": "ynJ5Ft4atkMkWeo2PAvFhF",
    "device_key": "ynJ5Ft4atkMkWeo2PAvFhF",
    "device_token": "a1b2…",
    "device_type": "ios"
  },
  "timestamp": 1762732800
}
```

Both `key` and `device_key` are returned because clients read different ones (FR-024).

Failure cases: missing/oversized token → `400` `"device token is empty"` / `"device token is invalid"`; bad type → `400` `"invalid device type: …"`; rate limit → `429`.

`GET /register/{device_key}` → `200 success` if known and not disabled; `400 "device not found"` otherwise.

## Notification parameters

All parameters are normalised from the request shape, then validated. Sources and precedence, highest first (matching the reference server):

1. URL path (`device_key`, `body`, `title`, `subtitle`)
2. Request body (JSON, form-encoded, or multipart)
3. Query string

| Parameter | Type | Effect | Mapping |
|---|---|---|---|
| `device_key` | string | Target device; empty → `400` | required for delivery |
| `device_keys` | string or array | Batch targets; comma-separated string accepted | expands to one delivery per key |
| `title` | string | Alert title | `aps.alert.title` |
| `subtitle` | string | Alert subtitle | `aps.alert.subtitle` |
| `body` | string | Alert body | `aps.alert.body` |
| `level` | string | `active` (default), `passive`, `timeSensitive`, `critical` | `aps.interruption-level` |
| `volume` | number | Critical-alert volume, `0.0`–`1.0` | `aps.sound.volume`, implies `critical` |
| `sound` | string | Sound name; `.caf` appended when no extension | `aps.sound` |
| `badge` | integer | App icon badge | `aps.badge` |
| `group` | string | Notification grouping | `aps.thread-id` |
| `icon` | string (URL) | Notification icon (iOS 15+) | custom `icon`, requires mutable content |
| `url` | string | Tap-through link | custom `url` |
| `action` | string | `none` disables tap action | custom `action` |
| `autoCopy` | `1` | Copy on delivery | custom `autoCopy` |
| `copy` | string | Text to copy | custom `copy` |
| `call` | `1` | Continuous ring for 30 s | custom `call` |
| `id` | string | Collapse identifier | `apns-collapse-id` |
| `isArchive` | `1` | Retain in archive | sets `archived` |
| `ttl` | integer seconds | Archive lifetime, clamped 60 – 2 592 000 | archive `expires_at` |
| `ciphertext` | string | Opaque encrypted payload | custom `ciphertext`, forwarded byte-for-byte |
| `delete` | `1` | Silent background push removing the notification | `aps.content-available`, push type `background` |

Unknown parameters are forwarded as custom payload fields, lower-cased, stringified — this is how the reference server passes app-specific fields through (e.g. `markdown`, `image`, `mute`).

Validation failures (all `400`, no APNs call): empty `device_key`, empty body for a non-delete/non-encrypted push, `BadDeviceToken`-shaped token, payload > 4096 bytes after mapping, malformed JSON.

## Delivery responses

Single target:

```json
{ "code": 200, "message": "success", "timestamp": 1762732800 }
```

Batch (`device_keys` present), always `200` with per-device results in `data`:

```json
{
  "code": 200,
  "message": "success",
  "data": [
    { "device_key": "aaa…", "code": 200, "message": "success" },
    { "device_key": "bbb…", "code": 400, "message": "device not found" }
  ],
  "timestamp": 1762732800
}
```

Batch limit: 100 keys per request; above that → `400` `"batch push count exceeds the maximum limit: 100"`.

APNs failures are surfaced with the reference's status mapping so existing clients keep their behaviour: `410` (and `400` with `BadDeviceToken`) → `400` body `"push failed: BadDeviceToken"`; `429`/`503` → `503` body `"push failed: <reason>"` and the delivery is retried; other 4xx → `400`.

## Access control (optional)

If `BARK_SERVER_TOKEN` is configured, every endpoint except `/`, `/ping`, `/healthz` requires `Authorization: Basic <base64(:token)>` **or** `Authorization: Bearer <token>`. Missing/incorrect → `401` with `WWW-Authenticate: Basic realm="bark"`. Default deployment: not configured (open registration, per spec FR-028).

## Rate limiting

| Bucket | Default | Applies to |
|---|---|---|
| `push:<device_key>` | 60 requests / 60 s | notification endpoints |
| `register:<sha256(ip)[:6]…>` | 10 requests / 60 s | registration endpoints |
| `batch:<device_key>` | counted per key | each element of a batch |

Rejection: HTTP `429`, envelope `{ "code": 429, "message": "rate limit exceeded, retry after Ns" }`, headers `Retry-After: N` and `X-RateLimit-Remaining: 0`. Rejected requests never reach APNs (SC-008).

## CORS

`OPTIONS` returns `204` with `access-control-allow-origin: *` and the methods/headers above. No cookies, no credentials.

## Compatibility notes

- Path segments are URL-decoded once (`%20`, `%2F`, UTF-8); `+` is treated literally in paths and as a space in form and query bodies, matching the reference behaviour and the documented examples.
- An empty body with only a title is valid; the app renders title-only notifications.
- `ciphertext` pushes may omit `body`; the server substitutes `Empty Message` because APNs discards alert pushes without one.
