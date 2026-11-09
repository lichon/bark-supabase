/**
 * Archive retention decisions.
 *
 * Archive rows are created only when the sender asks for one. The lifetime is
 * the `ttl` parameter clamped to the documented bounds (1 minute – 30 days) and
 * defaults to one day.
 *
 * Contract: specs/001-bark-server-supabase/contracts/http-api.md (FR-023, SC-009)
 */

import { boolParam, type ParamMap } from "./params.ts";

export const MIN_TTL_SECONDS = 60;
export const MAX_TTL_SECONDS = 2_592_000; // 30 days
export const DEFAULT_TTL_SECONDS = 86_400; // 1 day

export interface ArchiveDecision {
  /** Whether an archive row must be written. */
  archive: boolean;
  /** Archive lifetime in seconds after clamping. */
  ttlSeconds: number;
}

/** Clamps a sender-supplied ttl into the supported lifetime window. */
export function clampTtl(ttlSeconds: number | undefined | null): number {
  if (ttlSeconds === undefined || ttlSeconds === null || !Number.isFinite(ttlSeconds)) {
    return DEFAULT_TTL_SECONDS;
  }
  const rounded = Math.trunc(ttlSeconds);
  if (rounded < MIN_TTL_SECONDS) return MIN_TTL_SECONDS;
  if (rounded > MAX_TTL_SECONDS) return MAX_TTL_SECONDS;
  return rounded;
}

/**
 * `isArchive=1` or a present `ttl` requests retention; anything else archives
 * nothing. `ttl` alone is enough because clients send it as a retention hint.
 */
export function archiveDecision(params: ParamMap): ArchiveDecision {
  const requested = boolParam(params, "isArchive") || params["ttl"] !== undefined;
  if (!requested) return { archive: false, ttlSeconds: DEFAULT_TTL_SECONDS };

  const rawTtl = params["ttl"];
  const ttl = rawTtl === undefined || rawTtl === null || rawTtl === "" ? undefined : Number(rawTtl);
  return { archive: true, ttlSeconds: clampTtl(ttl) };
}

/** The params an archive row stores: ciphertext stays byte-identical and opaque. */
export function archivedPayload(params: ParamMap): Record<string, unknown> {
  return { ...params };
}
