/**
 * Bark parameters -> APNs payload.
 *
 * Contract: specs/001-bark-server-supabase/contracts/apns-push.md
 *
 * The mapping mirrors the reference server: alert fields, optional interruption
 * level, sound (with `.caf` suffixing and the critical-volume object), badge,
 * grouping via `thread-id`, and every unrecognised parameter forwarded as a
 * lower-cased string so app-specific fields (`markdown`, `image`, `ciphertext`,
 * …) pass through untouched.
 */

import {
  boolParam,
  normalizeLevel,
  type NotificationLevel,
  type ParamMap,
  stringParam,
} from "./params.ts";

export const MAX_PAYLOAD_BYTES = 4096;
export const EMPTY_MESSAGE = "Empty Message";
export const DEFAULT_CATEGORY = "myNotificationCategory";

/**
 * Parameters that are consumed by the server and therefore never echoed into the
 * payload. `ciphertext`, `isArchive` and `ttl` are deliberately *not* here: the
 * reference forwards them verbatim (`isArchive` arrives as the string `"1"`).
 */
const SERVER_ONLY_PARAMS = new Set([
  "device_key",
  "device_keys",
  "title",
  "subtitle",
  "body",
  "level",
  "volume",
  "sound",
  "badge",
  "group",
  "delete",
  "id",
]);

export interface ApnsPayload {
  aps: Record<string, unknown>;
  [key: string]: unknown;
}

/** Appends `.caf` when the sound name carries no extension. */
export function soundName(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "") return trimmed;
  const lastSegment = trimmed.split("/").pop() ?? trimmed;
  return lastSegment.includes(".") ? trimmed : `${trimmed}.caf`;
}

export function isBackgroundPush(params: ParamMap): boolean {
  return boolParam(params, "delete");
}

/** True when the payload carries only the opaque ciphertext. */
export function isCiphertextPush(params: ParamMap): boolean {
  const ciphertext = stringParam(params, "ciphertext");
  return ciphertext !== undefined && ciphertext !== "";
}

/** Custom fields: everything the server does not consume, lower-cased and stringified. */
export function customFields(params: ParamMap): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (SERVER_ONLY_PARAMS.has(key)) continue;
    if (value === undefined || value === null) continue;
    const name = key.toLowerCase();
    if (Array.isArray(value)) {
      fields[name] = value.map((item) => String(item)).join(",");
    } else {
      fields[name] = String(value);
    }
  }
  return fields;
}

export function buildAlertPayload(params: ParamMap): ApnsPayload {
  const aps: Record<string, unknown> = { "mutable-content": 1 };

  const alert: Record<string, string> = {};
  const title = stringParam(params, "title");
  const subtitle = stringParam(params, "subtitle");
  const body = stringParam(params, "body");
  if (title !== undefined) alert.title = title;
  if (subtitle !== undefined && subtitle !== "") alert.subtitle = subtitle;
  if (body !== undefined && body !== "") {
    alert.body = body;
  } else if (isCiphertextPush(params)) {
    // The app renders nothing for an alert push without a body, so an encrypted
    // push keeps a placeholder the content extension replaces.
    alert.body = EMPTY_MESSAGE;
  }
  if (Object.keys(alert).length > 0) aps.alert = alert;

  const sound = stringParam(params, "sound");
  const volume = params["volume"];
  if (volume !== undefined && volume !== null && volume !== "") {
    const name = sound && sound.trim() !== "" ? soundName(sound) : "default";
    aps.sound = { critical: 1, name, volume: Number(volume) };
  } else if (sound !== undefined && sound.trim() !== "") {
    aps.sound = soundName(sound);
  }

  if (params["level"] !== undefined) {
    const { level } = normalizeLevel(params["level"]);
    if (level !== "active") aps["interruption-level"] = level satisfies NotificationLevel;
  }

  if (params["badge"] !== undefined && params["badge"] !== null && params["badge"] !== "") {
    aps.badge = Number(params["badge"]);
  }

  const group = stringParam(params, "group");
  if (group !== undefined && group !== "") aps["thread-id"] = group;

  return { ...customFields(params), aps, category: DEFAULT_CATEGORY };
}

/** Silent push used by `delete=1`: no alert block, background push type. */
export function buildSilentPayload(params: ParamMap): ApnsPayload {
  return {
    ...customFields(params),
    aps: { "content-available": 1 },
    category: DEFAULT_CATEGORY,
  };
}

export function buildPayload(params: ParamMap): ApnsPayload {
  return isBackgroundPush(params) ? buildSilentPayload(params) : buildAlertPayload(params);
}

export function serializePayload(payload: ApnsPayload): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(payload));
}

export function payloadBytes(payload: ApnsPayload): number {
  return serializePayload(payload).byteLength;
}

/** Rejects anything over the APNs limit before a network call is made. */
export function assertPayloadSize(payload: ApnsPayload, max: number = MAX_PAYLOAD_BYTES): void {
  const size = payloadBytes(payload);
  if (size > max) {
    throw new Error(`payload too large: ${size} bytes (maximum ${max})`);
  }
}
