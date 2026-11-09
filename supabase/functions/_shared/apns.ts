/**
 * APNs client: header derivation, response classification, retry rules and the
 * HTTP/2 POST.
 *
 * The transport is injectable (`fetchImpl`) so classification, headers and retry
 * behaviour are all unit-testable with a stub function — no real push, no local
 * server, no Apple credentials.
 *
 * Contract: specs/001-bark-server-supabase/contracts/apns-push.md
 */

import { boolParam, type ParamMap, stringParam } from "./params.ts";
import type { DeviceKind } from "./types.ts";

export type Classification =
  | "delivered"
  | "transient"
  | "credential"
  | "permanent"
  | "suppressed";

export const MAX_ATTEMPTS = 3;
export const TRANSIENT_DELAY_SECONDS = 60;
export const SERVER_ERROR_DELAY_SECONDS = 15 * 60;
export const EXPIRATION_SECONDS = 24 * 60 * 60;
export const DEFAULT_TIMEOUT_MS = 10_000;

export const PRODUCTION_HOST = "https://api.push.apple.com";
export const SANDBOX_HOST = "https://api.sandbox.push.apple.com";

export function apnsHost(env: string | undefined): string {
  return env === "sandbox" ? SANDBOX_HOST : PRODUCTION_HOST;
}

/**
 * Maps an APNs status/reason pair onto the four outcomes the delivery pipeline
 * cares about. Status `0` means the request never completed (timeout, DNS,
 * connection reset) and is treated as transient.
 */
export function classify(status: number, reason?: string): Classification {
  if (status === 200) return "delivered";
  if (status === 0) return "transient";
  if (status === 403) return "credential";
  if (status === 429) return "transient";
  if (status >= 500) return "transient";
  if (status === 410) return "permanent";
  if (status === 400 && (reason === "BadDeviceToken" || reason === "DeviceTokenNotForTopic")) {
    return "permanent";
  }
  return "permanent";
}

/** Whether a permanent token rejection invalidates the registration. */
export function isInvalidTokenFailure(status: number, reason?: string): boolean {
  if (status === 410) return true;
  return status === 400 && reason === "BadDeviceToken";
}

/** Retries are capped at three attempts, so no row can loop. */
export function shouldRetry(classification: Classification, attemptCount: number): boolean {
  return classification === "transient" && attemptCount < MAX_ATTEMPTS;
}

/**
 * Backoff before the next attempt: a minute for throttling or a timeout, fifteen
 * minutes after an APNs server error (Apple's guidance).
 */
export function retryDelaySeconds(status: number): number {
  return status >= 500 ? SERVER_ERROR_DELAY_SECONDS : TRANSIENT_DELAY_SECONDS;
}

/** The HTTP status the client sees for a classified outcome. */
export function clientStatusFor(classification: Classification): number {
  switch (classification) {
    case "delivered":
      return 200;
    case "transient":
    case "credential":
      return 503;
    default:
      return 400;
  }
}

export type PushType = "alert" | "background";

export function pushTypeFor(params: ParamMap): PushType {
  return boolParam(params, "delete") ? "background" : "alert";
}

function isPrintableAscii(value: string): boolean {
  return /^[\x20-\x7e]+$/.test(value);
}

export interface HeaderOptions {
  token?: string;
  topics?: Partial<Record<DeviceKind, string>>;
  expirationSeconds?: number;
}

export const DEFAULT_TOPICS: Record<DeviceKind, string> = {
  ios: "me.fin.bark",
  watchos: "me.fin.bark.watch",
};

/**
 * Derives the APNs request headers. `now` is Unix seconds and only feeds
 * `apns-expiration`, so tests can pin the clock.
 */
export function buildHeaders(
  params: ParamMap,
  deviceKind: DeviceKind,
  now: number,
  options: HeaderOptions = {},
): Record<string, string> {
  const pushType = pushTypeFor(params);
  const topics = { ...DEFAULT_TOPICS, ...(options.topics ?? {}) };
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "apns-topic": topics[deviceKind],
    "apns-push-type": pushType,
    "apns-priority": pushType === "background" ? "5" : "10",
    "apns-expiration": String(now + (options.expirationSeconds ?? EXPIRATION_SECONDS)),
  };

  if (options.token) headers["authorization"] = `bearer ${options.token}`;

  const collapseId = stringParam(params, "id");
  if (
    collapseId !== undefined && collapseId !== "" && collapseId.length <= 64 &&
    isPrintableAscii(collapseId)
  ) {
    headers["apns-collapse-id"] = collapseId;
  }

  return headers;
}

export interface SendOptions {
  deviceToken: string;
  deviceKind: DeviceKind;
  payload: Record<string, unknown>;
  params: ParamMap;
  token: string;
  topics?: Partial<Record<DeviceKind, string>>;
  env?: string;
  fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  now?: number;
  timeoutMs?: number;
  /** Re-signs a fresh provider token; called once on `ExpiredProviderToken`. */
  resignToken?: () => Promise<string>;
}

export interface SendResult {
  status: number;
  reason?: string;
  classification: Classification;
  apnsId?: string;
  latencyMs: number;
  attempts: number;
  timedOut: boolean;
}

interface RawAttempt {
  status: number;
  reason?: string;
  apnsId?: string;
  timedOut: boolean;
}

async function readReason(response: Response): Promise<string | undefined> {
  try {
    const body = await response.json() as { reason?: unknown };
    return typeof body?.reason === "string" ? body.reason : undefined;
  } catch {
    return undefined;
  }
}

async function postOnce(
  url: string,
  headers: Record<string, string>,
  body: string,
  fetchImpl: NonNullable<SendOptions["fetchImpl"]>,
  timeoutMs: number,
): Promise<RawAttempt> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
    return {
      status: response.status,
      reason: await readReason(response),
      apnsId: response.headers.get("apns-id") ?? undefined,
      timedOut: false,
    };
  } catch (error) {
    const timedOut = error instanceof Error &&
      (error.name === "AbortError" || error.name === "TimeoutError");
    return { status: 0, reason: timedOut ? "timeout" : "connection error", timedOut };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Posts one notification. A 403 `ExpiredProviderToken` invalidates the token
 * cache and retries once with a freshly signed token, as the contract requires.
 */
export async function send(options: SendOptions): Promise<SendResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  // `options.now` is Unix seconds, matching `buildHeaders`.
  const now = options.now !== undefined ? Math.floor(options.now) : nowSeconds();
  const url = `${apnsHost(options.env)}/3/device/${options.deviceToken}`;
  const body = JSON.stringify(options.payload);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const started = Date.now();
  let token = options.token;
  let attempts = 0;
  let attempt = await postOnce(
    url,
    buildHeaders(options.params, options.deviceKind, now, {
      token,
      topics: options.topics,
    }),
    body,
    fetchImpl,
    timeoutMs,
  );
  attempts += 1;

  if (
    attempt.status === 403 && attempt.reason === "ExpiredProviderToken" &&
    options.resignToken && attempts < MAX_ATTEMPTS
  ) {
    token = await options.resignToken();
    attempt = await postOnce(
      url,
      buildHeaders(options.params, options.deviceKind, now, {
        token,
        topics: options.topics,
      }),
      body,
      fetchImpl,
      timeoutMs,
    );
    attempts += 1;
  }

  return {
    status: attempt.status,
    reason: attempt.reason,
    classification: classify(attempt.status, attempt.reason),
    apnsId: attempt.apnsId,
    latencyMs: Date.now() - started,
    attempts,
    timedOut: attempt.timedOut,
  };
}

export function nowSeconds(now: number = Date.now()): number {
  return Math.floor(now / 1000);
}
