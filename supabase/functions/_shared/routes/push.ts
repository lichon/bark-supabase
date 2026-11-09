/**
 * The delivery pipeline.
 *
 * Every request shape converges here: resolve the target(s), build one payload,
 * write exactly one `delivery` row per device, send, then map the APNs outcome to
 * the client-visible result. Transient failures stay `pending` for the cron drain;
 * permanent token rejections invalidate the registration.
 *
 * Contract: specs/001-bark-server-supabase/contracts/http-api.md
 */

import { archiveDecision } from "../archive.ts";
import {
  clientStatusFor,
  isInvalidTokenFailure,
  retryDelaySeconds,
  type SendResult,
  shouldRetry,
} from "../apns.ts";
import type { BarkConfig } from "../config.ts";
import { hashDeviceKey, logDelivery, logEvent } from "../log.ts";
import { expandDeviceKeys, isBatchPush, type ParamMap, stringParam, validate } from "../params.ts";
import { assertPayloadSize, buildPayload, isBackgroundPush } from "../payload.ts";
import type { RateLimitHit } from "../ratelimit.ts";
import { batchBucket, pushBucket, rejectionResponse } from "../ratelimit.ts";
import { BarkError, failed, jsonResponse, success } from "../response.ts";
import type { Store } from "../store.ts";
import type { DeliveryOrigin, DeviceRecord } from "../types.ts";

export const MAX_PARALLEL_DELIVERIES = 10;

export interface SendNotificationInput {
  device: DeviceRecord;
  params: ParamMap;
  payload: Record<string, unknown>;
}

export type SendNotification = (input: SendNotificationInput) => Promise<SendResult>;

export interface PushDeps {
  store: Store;
  config: BarkConfig;
  sendNotification: SendNotification;
  rateLimit?: RateLimitHit;
  now?: () => Date;
  hashKey?: (deviceKey: string) => Promise<string>;
  log?: typeof logDelivery;
}

export interface BatchEntry {
  device_key: string;
  code: number;
  message: string;
  /** Present on a 429 so the single-target response can set `Retry-After`. */
  retryAfter?: number;
}

function effectiveOrigin(params: ParamMap, origin: DeliveryOrigin): DeliveryOrigin {
  return isBatchPush(params) ? "v2_batch" : origin;
}

function hasDisplayContent(params: ParamMap): boolean {
  const title = stringParam(params, "title") ?? "";
  const subtitle = stringParam(params, "subtitle") ?? "";
  const body = stringParam(params, "body") ?? "";
  const ciphertext = stringParam(params, "ciphertext") ?? "";
  return (
    title.trim() !== "" || subtitle.trim() !== "" || body.trim() !== "" || ciphertext.trim() !== ""
  );
}

function failureMessage(send: SendResult): string {
  const reason = send.reason ?? (send.status === 0 ? "connection error" : "unknown");
  return `push failed: ${reason}`;
}

export async function handlePush(
  deps: PushDeps,
  rawParams: ParamMap,
  origin: DeliveryOrigin,
): Promise<Response> {
  const { params, warnings } = validate(rawParams);
  for (const warning of warnings) logEvent("validation_warning", { warning });
  const keys = expandDeviceKeys(params);
  if (keys.length === 0) throw new BarkError("device key is empty");
  if (!isBackgroundPush(params) && !hasDisplayContent(params)) {
    throw new BarkError("empty message");
  }

  const payload = buildPayload(params);
  try {
    assertPayloadSize(payload);
  } catch (error) {
    throw new BarkError(error instanceof Error ? error.message : "payload too large");
  }

  const batch = isBatchPush(params) || keys.length > 1;
  const requestId = crypto.randomUUID();
  const deliveryOrigin = effectiveOrigin(params, origin);
  const decision = archiveDecision(params);
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? logDelivery;
  const hashKey = deps.hashKey ?? hashDeviceKey;

  const deliverOne = async (deviceKey: string): Promise<BatchEntry> => {
    if (deps.rateLimit) {
      const limit = deps.config.rateLimits.pushLimit;
      const window = deps.config.rateLimits.pushWindowSeconds;
      const bucket = batch ? batchBucket(deviceKey) : pushBucket(deviceKey);
      const outcome = await deps.rateLimit(bucket, limit, window);
      if (!outcome.allowed) {
        const retryAfter = Math.max(1, Math.ceil(outcome.retryAfter));
        return {
          device_key: deviceKey,
          code: 429,
          message: `rate limit exceeded, retry after ${retryAfter}s`,
          retryAfter,
        };
      }
    }

    const device = await deps.store.lookupDevice(deviceKey);
    if (!device) {
      return { device_key: deviceKey, code: 400, message: "device not found" };
    }

    const suppressed = device.disabled_at !== null
      ? "device is disabled"
      : device.invalidated_at !== null
      ? "device token is invalid"
      : null;

    if (suppressed !== null) {
      const row = await deps.store.insertDelivery({
        requestId,
        deviceKey,
        origin: deliveryOrigin,
        status: "suppressed",
        attemptCount: 0,
        payload: decision.archive ? (params as Record<string, unknown>) : null,
      });
      if (decision.archive) {
        await deps.store.insertArchive({
          deliveryId: row.id,
          deviceKey,
          payload: params as Record<string, unknown>,
          expiresAt: new Date(now().getTime() + decision.ttlSeconds * 1000).toISOString(),
        });
      }
      return { device_key: deviceKey, code: 400, message: suppressed };
    }

    const row = await deps.store.insertDelivery({
      requestId,
      deviceKey,
      origin: deliveryOrigin,
      status: "pending",
      attemptCount: 0,
      payload: params as Record<string, unknown>,
    });

    const send = await deps.sendNotification({ device, params, payload });

    let status: "delivered" | "failed" | "pending" = "failed";
    let nextAttemptAt: string | null = null;
    if (send.classification === "delivered") {
      status = "delivered";
    } else if (shouldRetry(send.classification, 1)) {
      status = "pending";
      const delaySeconds = retryDelaySeconds(send.status);
      nextAttemptAt = new Date(now().getTime() + delaySeconds * 1000).toISOString();
    }

    await deps.store.updateDelivery(row.id, {
      status,
      attemptCount: 1,
      apnsStatus: send.status,
      apnsReason: send.reason ?? null,
      apnsId: send.apnsId ?? null,
      nextAttemptAt,
      // Content is only retained while the row can still be retried.
      payload: status === "pending" ? (params as Record<string, unknown>) : null,
      archived: decision.archive,
    });

    if (decision.archive) {
      await deps.store.insertArchive({
        deliveryId: row.id,
        deviceKey,
        payload: params as Record<string, unknown>,
        expiresAt: new Date(now().getTime() + decision.ttlSeconds * 1000).toISOString(),
      });
    }

    if (isInvalidTokenFailure(send.status, send.reason) && send.classification === "permanent") {
      await deps.store.invalidateDevice(deviceKey, send.reason ?? "invalid token");
    }

    log({
      event: "delivery_attempt",
      delivery_id: row.id,
      device_key_hash: await hashKey(deviceKey),
      device_kind: device.device_kind,
      origin: deliveryOrigin,
      attempt: 1,
      apns_status: send.status,
      apns_reason: send.reason ?? null,
      classification: send.classification,
      latency_ms: send.latencyMs,
    });

    const code = clientStatusFor(send.classification);
    const message = send.classification === "delivered" ? "success" : failureMessage(send);
    return { device_key: deviceKey, code, message };
  };

  const results: BatchEntry[] = [];
  for (let index = 0; index < keys.length; index += MAX_PARALLEL_DELIVERIES) {
    const chunk = keys.slice(index, index + MAX_PARALLEL_DELIVERIES);
    const settled = await Promise.all(chunk.map((key) => deliverOne(key)));
    results.push(...settled);
  }

  if (!batch) {
    const entry = results[0];
    if (entry.code === 200) {
      return jsonResponse(success());
    }
    if (entry.code === 429) {
      return rejectionResponse(entry.retryAfter ?? 60);
    }
    return jsonResponse(failed(entry.code, entry.message), { status: entry.code });
  }

  // The batch body carries exactly the documented fields per device.
  const data = results.map((entry) => ({
    device_key: entry.device_key,
    code: entry.code,
    message: entry.message,
  }));
  return jsonResponse(success(data));
}
