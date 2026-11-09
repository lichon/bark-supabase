/**
 * Parameter normalisation and validation.
 *
 * All documented request shapes (v1 path, v1 form, v2 JSON, batch) converge on a
 * single `ParamMap` first, then get validated. Keeping this pure means the whole
 * compatibility surface is unit-testable without a database or a network.
 *
 * Contract: specs/001-bark-server-supabase/contracts/http-api.md
 */

import { BarkError } from "./response.ts";
import { type DeviceKind, isDeviceKind } from "./types.ts";

export type ParamMap = Record<string, unknown>;

export interface NormalizeInput {
  /** Path parameters, still URL-encoded (see `_shared/router.ts`). */
  path?: Record<string, string> | null;
  /** Parsed JSON or form body. */
  body?: Record<string, unknown> | null;
  /** Query string parameters, already form-decoded. */
  query?: Record<string, string> | URLSearchParams | null;
  contentType?: string;
}

export const MAX_BATCH_KEYS = 100;
export const DEVICE_KEY_PATTERN = /^[A-Za-z0-9]{6,32}$/;
export const MAX_DEVICE_TOKEN_LENGTH = 160;
export const LEVELS = ["active", "passive", "timeSensitive", "critical"] as const;
export type NotificationLevel = (typeof LEVELS)[number];
export const MAX_BADGE = 999999;

/** Legacy field aliases accepted by the reference server. */
const ALIASES: Record<string, string> = {
  key: "device_key",
  devicetoken: "device_token",
};

/** Decodes a path segment exactly once; a malformed escape is kept verbatim. */
export function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Form/query parsing: `+` is a space, as the reference server does. */
export function parseFormEncoded(raw: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(raw)) params[key] = value;
  return params;
}

/**
 * Flattens a multipart form into the same shape as a form-encoded body. File
 * parts are stringified by name only; the Bark clients send text fields.
 */
export function formDataToObject(form: FormData): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    params[key] = typeof value === "string" ? value : value.name;
  }
  return params;
}

function queryToObject(query: NormalizeInput["query"]): Record<string, string> {
  if (!query) return {};
  if (query instanceof URLSearchParams) return parseFormEncoded(query.toString());
  return { ...query };
}

/**
 * Merges path > body > query (highest first) into one map.
 *
 * Path segments are URL-decoded once. `+` stays literal in paths and becomes a
 * space in bodies and query strings, matching the documented examples.
 */
export function normalize(input: NormalizeInput): ParamMap {
  const merged: ParamMap = {};

  for (const [key, value] of Object.entries(queryToObject(input.query))) {
    const name = ALIASES[key] ?? key;
    if (value !== undefined && value !== null) merged[name] = value;
  }

  for (const [key, value] of Object.entries(input.body ?? {})) {
    const name = ALIASES[key] ?? key;
    if (value !== undefined && value !== null) merged[name] = value;
  }

  for (const [key, value] of Object.entries(input.path ?? {})) {
    if (value === undefined || value === null) continue;
    merged[key] = decodePathSegment(String(value));
  }

  return merged;
}

export function stringParam(params: ParamMap, name: string): string | undefined {
  const value = params[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

export function intParam(
  params: ParamMap,
  name: string,
  bounds: { min?: number; max?: number } = {},
): number | undefined {
  const raw = stringParam(params, name);
  if (raw === undefined || raw.trim() === "") return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new BarkError(`${name} must be an integer`);
  }
  if (bounds.min !== undefined && parsed < bounds.min) {
    throw new BarkError(`${name} must be at least ${bounds.min}`);
  }
  if (bounds.max !== undefined && parsed > bounds.max) {
    throw new BarkError(`${name} must be at most ${bounds.max}`);
  }
  return parsed;
}

export function floatParam(
  params: ParamMap,
  name: string,
  bounds: { min?: number; max?: number } = {},
): number | undefined {
  const raw = stringParam(params, name);
  if (raw === undefined || raw.trim() === "") return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new BarkError(`${name} must be a number`);
  if (bounds.min !== undefined && parsed < bounds.min) {
    throw new BarkError(`${name} must be between ${bounds.min} and ${bounds.max}`);
  }
  if (bounds.max !== undefined && parsed > bounds.max) {
    throw new BarkError(`${name} must be between ${bounds.min} and ${bounds.max}`);
  }
  return parsed;
}

/** Truthy for `1`, `true`, `yes`, `on` — the reference server only documents `1`. */
export function boolParam(params: ParamMap, name: string): boolean {
  const raw = stringParam(params, name);
  if (raw === undefined) return false;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

export function requireDeviceKey(params: ParamMap): string {
  const key = stringParam(params, "device_key")?.trim();
  if (!key) throw new BarkError("device key is empty");
  return key;
}

export function requireDeviceToken(params: ParamMap): string {
  const token = stringParam(params, "device_token")?.trim();
  if (!token) throw new BarkError("device token is empty");
  if (token.length > MAX_DEVICE_TOKEN_LENGTH) throw new BarkError("device token is invalid");
  return token;
}

export function deviceKindParam(params: ParamMap): DeviceKind {
  const raw = stringParam(params, "device_type") ?? stringParam(params, "device_kind");
  if (raw === undefined || raw.trim() === "") return "ios";
  const value = raw.trim().toLowerCase();
  if (!isDeviceKind(value)) throw new BarkError(`invalid device type: ${raw}`);
  return value;
}

export function alertFields(params: ParamMap): {
  title?: string;
  subtitle?: string;
  body?: string;
} {
  const fields: { title?: string; subtitle?: string; body?: string } = {};
  const title = stringParam(params, "title");
  const subtitle = stringParam(params, "subtitle");
  const body = stringParam(params, "body");
  if (title !== undefined) fields.title = title;
  if (subtitle !== undefined) fields.subtitle = subtitle;
  if (body !== undefined) fields.body = body;
  return fields;
}

/**
 * Expands `device_keys` (array, comma-separated string, or a mix) and falls back
 * to the single `device_key`. Duplicates are preserved in input order so a caller
 * that repeats a key gets a repeated result entry.
 */
export function expandDeviceKeys(params: ParamMap): string[] {
  const keys: string[] = [];
  const batch = params["device_keys"];

  const pushValue = (value: unknown) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      for (const item of value) pushValue(item);
      return;
    }
    const text = typeof value === "string" ? value : String(value);
    for (const part of text.split(",")) {
      const trimmed = part.trim();
      if (trimmed.length > 0) keys.push(trimmed);
    }
  };

  if (batch !== undefined && batch !== null) {
    pushValue(batch);
  } else {
    const single = stringParam(params, "device_key");
    if (single && single.trim()) keys.push(single.trim());
  }

  if (keys.length > MAX_BATCH_KEYS) {
    throw new BarkError(`batch push count exceeds the maximum limit: ${MAX_BATCH_KEYS}`);
  }
  return keys;
}

export function isBatchPush(params: ParamMap): boolean {
  const batch = params["device_keys"];
  return batch !== undefined && batch !== null;
}

/**
 * `level` falls back to `active` with a warning (the reference server tolerates
 * unknown values); `badge` and `volume` are hard bounds because Apple rejects
 * out-of-range values with a permanent APNs error.
 */
export function normalizeLevel(value: unknown): { level: NotificationLevel; warning?: string } {
  const raw = value === undefined || value === null ? "" : String(value).trim();
  if (raw === "") return { level: "active" };
  const match = LEVELS.find((level) => level.toLowerCase() === raw.toLowerCase());
  if (match) return { level: match };
  return { level: "active", warning: `unknown level "${raw}", falling back to active` };
}

export interface ValidationResult {
  params: ParamMap;
  warnings: string[];
}

/** Validates and coerces the numeric/enumerated parameters in place. */
export function validate(params: ParamMap): ValidationResult {
  const result: ParamMap = { ...params };
  const warnings: string[] = [];

  if (result["level"] !== undefined) {
    const { level, warning } = normalizeLevel(result["level"]);
    result["level"] = level;
    if (warning) warnings.push(warning);
  }

  if (result["badge"] !== undefined && result["badge"] !== null && result["badge"] !== "") {
    result["badge"] = intParam(result, "badge", { min: 0, max: MAX_BADGE });
  }

  if (result["volume"] !== undefined && result["volume"] !== null && result["volume"] !== "") {
    result["volume"] = floatParam(result, "volume", { min: 0, max: 1 });
  }

  if (result["ttl"] !== undefined && result["ttl"] !== null && result["ttl"] !== "") {
    result["ttl"] = intParam(result, "ttl", { min: 0 });
  }

  return { params: result, warnings };
}
