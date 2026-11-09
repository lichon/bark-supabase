/**
 * Rate limiting.
 *
 * Functions are stateless and horizontally scaled, so counters live in Postgres
 * and are incremented atomically by `bark_hit_rate_limit`. The RPC is injected as
 * a function, which keeps this module pure and testable.
 *
 * Contract: specs/001-bark-server-supabase/contracts/http-api.md (FR-018, SC-008)
 */

import { failed, jsonResponse } from "./response.ts";

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfter: number;
}

export type RateLimitHit = (
  bucketKey: string,
  limit: number,
  windowSeconds: number,
) => Promise<RateLimitResult>;

export const PUSH_LIMIT = 60;
export const PUSH_WINDOW_SECONDS = 60;
export const REGISTER_LIMIT = 10;
export const REGISTER_WINDOW_SECONDS = 60;

export function pushBucket(deviceKey: string): string {
  return `push:${deviceKey}`;
}

export function batchBucket(deviceKey: string): string {
  return `batch:${deviceKey}`;
}

/** Registration buckets key on a hashed client address, never the raw address. */
export async function registerBucket(clientAddress: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(clientAddress),
  );
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
  return `register:${hex.slice(0, 16)}`;
}

export async function check(
  hit: RateLimitHit,
  bucketKey: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  return await hit(bucketKey, limit, windowSeconds);
}

/** `429` envelope with the headers the contract requires. */
export function rejectionResponse(retryAfter: number): Response {
  const seconds = Math.max(1, Math.ceil(retryAfter));
  return jsonResponse(failed(429, `rate limit exceeded, retry after ${seconds}s`), {
    status: 429,
    headers: {
      "retry-after": String(seconds),
      "x-ratelimit-remaining": "0",
    },
  });
}

/** Response used when the optional shared access token is configured and missing. */
export function unauthorizedResponse(): Response {
  return jsonResponse(failed(401, "unauthorized"), {
    status: 401,
    headers: { "www-authenticate": 'Basic realm="bark"' },
  });
}
