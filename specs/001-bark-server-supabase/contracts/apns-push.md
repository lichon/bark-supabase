# Contract: Outbound APNs requests

**Feature**: `001-bark-server-supabase` | **Date**: 2026-11-09

Defines what the server sends to Apple, how the response is classified, and when a failed delivery is retried. Owned by `_shared/apns.ts`, `_shared/jwt.ts`, `_shared/payload.ts`.

## Transport

| Property | Value |
|---|---|
| Host | `https://api.push.apple.com` (production, default) or `https://api.sandbox.push.apple.com` (`APNS_ENV=sandbox`) |
| Path | `/3/device/<device_token>` |
| Method | `POST` |
| Protocol | HTTP/2 over TLS (negotiated by the runtime's `fetch`) |
| Timeout | 10 s per attempt (abort), 5 s connect budget |

## Provider token (JWT)

| Field | Value |
|---|---|
| Header | `alg: ES256`, `kid: <APNS_KEY_ID>` |
| Claims | `iss: <APNS_TEAM_ID>`, `iat: <unix seconds>` |
| Signing | ECDSA P-256 / SHA-256 over `base64url(header).base64url(claims)`, raw `r‖s` signature, base64url-encoded |
| Key | PKCS#8 PEM from `APNS_P8` (the `.p8` file, newlines preserved or `\n`-escaped) |
| Cache | Per isolate, reused for 50 minutes; re-signed on `ExpiredProviderToken` and the request retried once |
| Header form | `authorization: bearer <token>` |

Apple accepts a token for one hour and throttles refreshes faster than once per 20 minutes, so 50 minutes is both safe and rate-limit-friendly. A token that fails to sign (wrong curve, malformed PEM) fails readiness rather than individual pushes.

## Request headers

| Header | Value | Source |
|---|---|---|
| `authorization` | `bearer <jwt>` | see above |
| `apns-topic` | `me.fin.bark` for `ios`, `me.fin.bark.watch` for `watchos` | `APNS_TOPIC_IOS` / `APNS_TOPIC_WATCH`; FR-011 |
| `apns-push-type` | `alert`, or `background` when `delete=1` | FR-010 |
| `apns-priority` | `10` for alert, `5` for background | FR-010 |
| `apns-expiration` | `now + 86400` (24 h), matching the reference | FR-012 |
| `apns-collapse-id` | `id` parameter when present (≤64 printable ASCII), otherwise unset | FR-010 |
| `content-type` | `application/json` | — |

## Payload

| Server parameter | Payload key | Notes |
|---|---|---|
| `title` | `aps.alert.title` | |
| `subtitle` | `aps.alert.subtitle` | omitted when empty |
| `body` | `aps.alert.body` | `Empty Message` when absent and the push is encrypted/empty |
| `sound` | `aps.sound` | string; a `.caf` suffix is added when no extension is present |
| `volume` | `aps.sound` object | `{ "critical": 1, "name": <sound>, "volume": <0..1> }` |
| `level` | `aps.interruption-level` | `active`/`passive`/`timeSensitive`/`critical`; omitted for `active` |
| `badge` | `aps.badge` | integer |
| `group` | `aps.thread-id` | |
| `delete` | `aps.content-available: 1` | no alert block |
| (always) | `aps.mutable-content: 1` | enables icon/decryption in the app extension |
| (always) | `category: "myNotificationCategory"` | the app's registered category |
| any other parameter | same name, lower-cased, stringified | `url`, `icon`, `action`, `autoCopy`, `copy`, `call`, `ciphertext`, `markdown`, … |

Rules:
- The serialised payload must be ≤4096 bytes; otherwise the request fails with `400` before any network call (FR-013).
- `ciphertext` is copied verbatim; the server never parses, decrypts, logs or inspects it (FR-012).
- Custom values are stringified the way the reference server does (`fmt.Sprintf("%v", v)`), so `isArchive` arriving as `1` becomes `"1"`.

## Response classification

| APNs status | Reason (examples) | Classification | Delivery | Client sees | Retry |
|---|---|---|---|---|---|
| `200` | — | delivered | `delivered` | `200 success` | no |
| `400` | `BadDeviceToken`, `DeviceTokenNotForTopic` | permanent | `failed`, device `invalidated_at` set | `400 "push failed: <reason>"` | no |
| `400` | `PayloadTooLarge`, `BadCollapseId`, `MissingTopic` | permanent (server bug/config) | `failed` | `400 "push failed: <reason>"` | no |
| `403` | `InvalidProviderToken`, `ExpiredProviderToken` | credential | `failed` | `503 "push failed: <reason>"` | once, after re-signing |
| `404` | `BadPath` | permanent | `failed` | `400` | no |
| `405` | `MethodNotAllowed` | permanent | `failed` | `400` | no |
| `410` | `Unregistered` | permanent | `failed`, device `invalidated_at` set | `400 "push failed: Unregistered"` | no |
| `413` | `PayloadTooLarge` | permanent | `failed` | `400` | no |
| `429` | `TooManyRequests` | transient | `pending` | `503` | yes, ≥60 s |
| `500`/`503` | `InternalServerError`, `ServiceUnavailable` | transient | `pending` | `503` | yes, ≥15 min |
| timeout / connection error | — | transient | `pending` (transport failure) | `503 "push failed: timeout"` | yes, ≥60 s |
| device disabled or token already invalidated | — | suppressed | `suppressed` | `400 "device is disabled"` / `"device token is invalid"` | no |

Every attempt writes exactly one `bark.delivery` row (one per device for batches), and an archive row when requested (FR-020, FR-023).

## Retry schedule

Driven by `bark-drain` (cron, every minute), claiming due rows with `FOR UPDATE SKIP LOCKED`:

| Attempt | Delay after previous | Notes |
|---|---|---|
| 1 | immediate, inside the client request | happy path |
| 2 | 60 s | 429/timeout |
| 3 | 15 min | after a 5xx, honouring Apple's guidance to back off ~15 minutes before retrying |
| — | after attempt 3 | terminal `failed`, `last_error` recorded |

Retry rows never re-send a delivered notification (no duplicates, FR-022). `attempt_count` is capped at 3 by constraint, so no row can loop.

## Credentials

| Secret | Meaning | Required |
|---|---|---|
| `APNS_P8` | PKCS#8 PEM of the provider key | yes |
| `APNS_KEY_ID` | 10-character key id | yes |
| `APNS_TEAM_ID` | 10-character team id | yes |
| `APNS_TOPIC_IOS` | bundle id for phone pushes (default `me.fin.bark`) | yes |
| `APNS_TOPIC_WATCH` | bundle id for watch pushes (default `me.fin.bark.watch`) | yes |
| `APNS_ENV` | `production` (default) or `sandbox` | no |
| `BARK_SERVER_TOKEN` | optional shared access credential | no |
| `BARK_DELIVERY_RETENTION_DAYS` | delivery record retention (default 30) | no |

Per research D3 the documented values for a stock deployment are the upstream-published Bark key (key id `LH4T9V5U4R`, team id `5U8LBRXG3A`), because the unmodified App Store app's tokens only accept pushes from that team. Rotation is a `supabase secrets set` operation with no code change (SC-010); after rotation the isolate cache expires within 50 minutes or on the first `ExpiredProviderToken`.
