/**
 * Retry worker, invoked by `pg_cron` (never by clients).
 *
 * Claims due `pending` deliveries with `bark_claim_retries` (`FOR UPDATE SKIP
 * LOCKED`), re-sends them through the same APNs client, and applies the backoff
 * schedule. A delivered or terminal row is never re-sent, so no duplicate
 * notifications are produced (FR-022).
 *
 * Contract: specs/001-bark-server-supabase/contracts/apns-push.md
 */

import { parseConfig } from "../_shared/config.ts";
import {
  classify,
  isInvalidTokenFailure,
  retryDelaySeconds,
  send as sendApns,
  shouldRetry,
} from "../_shared/apns.ts";
import { invalidate, providerToken } from "../_shared/jwt.ts";
import { hashDeviceKey, logDelivery, logEvent } from "../_shared/log.ts";
import { buildPayload } from "../_shared/payload.ts";
import { errorResponse, failed, jsonResponse, success } from "../_shared/response.ts";
import { createServiceClient, createStore, type Store } from "../_shared/store.ts";
import type { BarkConfig } from "../_shared/config.ts";
import type { PendingDelivery } from "../_shared/types.ts";

const BATCH_SIZE = 20;

function authorized(request: Request, serviceRoleKey: string): boolean {
  const bearer = (request.headers.get("authorization") ?? "").toLowerCase();
  if (bearer.startsWith("bearer ") && bearer.slice(7).trim() === serviceRoleKey) return true;
  const apiKey = request.headers.get("apikey");
  return apiKey !== null && apiKey === serviceRoleKey;
}

export async function handleDrain(config: BarkConfig): Promise<Response> {
  const client = await createServiceClient({
    supabaseUrl: config.supabaseUrl,
    serviceRoleKey: config.serviceRoleKey,
  });
  const store: Store = createStore(client);

  const due = await store.claimRetries(BATCH_SIZE);
  const results: { delivery_id: string; status: string; attempts: number }[] = [];

  for (const delivery of due) {
    results.push(await retryOne(store, config, delivery));
  }

  return jsonResponse(success({ claimed: due.length, results }));
}

async function retryOne(
  store: Store,
  config: BarkConfig,
  delivery: PendingDelivery,
): Promise<{ delivery_id: string; status: string; attempts: number }> {
  const attempt = delivery.attempt_count + 1;
  const params = delivery.payload ?? {};
  const payload = buildPayload(params);
  const now = Date.now();

  const send = await sendApns({
    deviceToken: delivery.device_token,
    deviceKind: delivery.device_kind,
    payload,
    params,
    token: await providerToken(config.apns),
    topics: config.apns.topics,
    env: config.apns.env,
    resignToken: async () => {
      invalidate();
      return await providerToken(config.apns);
    },
  });

  let status: "delivered" | "failed" | "pending" = "failed";
  let nextAttemptAt: string | null = null;
  if (send.classification === "delivered") {
    status = "delivered";
  } else if (shouldRetry(send.classification, attempt)) {
    status = "pending";
    nextAttemptAt = new Date(now + retryDelaySeconds(send.status) * 1000).toISOString();
  }

  await store.updateDelivery(delivery.id, {
    status,
    attemptCount: attempt,
    apnsStatus: send.status,
    apnsReason: send.reason ?? null,
    apnsId: send.apnsId ?? null,
    nextAttemptAt,
    payload: status === "pending" ? params : null,
  });

  if (isInvalidTokenFailure(send.status, send.reason)) {
    await store.invalidateDevice(delivery.device_key, send.reason ?? "invalid token");
  }

  logDelivery({
    event: "delivery_attempt",
    delivery_id: delivery.id,
    device_key_hash: await hashDeviceKey(delivery.device_key),
    device_kind: delivery.device_kind,
    origin: "retry",
    attempt,
    apns_status: send.status,
    apns_reason: send.reason ?? null,
    classification: classify(send.status, send.reason),
    latency_ms: send.latencyMs,
  });

  return { delivery_id: delivery.id, status, attempts: attempt };
}

export async function handler(request: Request): Promise<Response> {
  const env = Deno.env.toObject();
  try {
    const config = parseConfig(env);
    if (!authorized(request, config.serviceRoleKey)) {
      return jsonResponse(failed(401, "unauthorized"), { status: 401 });
    }
    return await handleDrain(config);
  } catch (error) {
    logEvent("unhandled_error", {
      route: "bark-drain",
      error: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : String(error),
    });
    return errorResponse(error);
  }
}

if (import.meta.main) {
  Deno.serve(handler);
}
