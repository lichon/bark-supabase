/**
 * Shared domain types for the Bark push server.
 *
 * `device_kind`, `delivery_status` and `delivery_origin` mirror the Postgres
 * enums created in `supabase/migrations/20260101000000_bark_schema.sql`
 * (see specs/001-bark-server-supabase/data-model.md).
 */

export type DeviceKind = "ios" | "watchos";

export const DEVICE_KINDS: readonly DeviceKind[] = ["ios", "watchos"];

export type DeliveryStatus = "delivered" | "pending" | "failed" | "suppressed";

export type DeliveryOrigin = "v1_path" | "v1_form" | "v2_json" | "v2_batch" | "retry";

export interface DeviceRecord {
  device_key: string;
  device_token: string;
  device_kind: DeviceKind;
  disabled_at: string | null;
  invalidated_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface DeliveryRecord {
  id: string;
  request_id: string;
  device_key: string;
  origin: DeliveryOrigin;
  status: DeliveryStatus;
  attempt_count: number;
  apns_status: number | null;
  apns_reason: string | null;
  apns_id: string | null;
  archived: boolean;
  next_attempt_at: string | null;
  created_at: string;
  updated_at: string;
}

/** A due retry claimed by `bark_claim_retries`, joined with its device row. */
export interface PendingDelivery {
  id: string;
  request_id: string;
  device_key: string;
  device_token: string;
  device_kind: DeviceKind;
  payload: Record<string, unknown>;
  attempt_count: number;
  origin: DeliveryOrigin;
}

export function isDeviceKind(value: unknown): value is DeviceKind {
  return value === "ios" || value === "watchos";
}
