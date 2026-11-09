/**
 * Structured logging.
 *
 * One JSON line per delivery attempt: delivery id, hashed device key, APNs status,
 * reason and latency. Tokens, message content, ciphertext and credentials are
 * never logged (FR-019, FR-020).
 */

export interface DeliveryLogLine {
  event: "delivery_attempt";
  delivery_id: string;
  device_key_hash: string;
  device_kind: string;
  origin: string;
  attempt: number;
  apns_status: number | null;
  apns_reason: string | null;
  classification: string;
  latency_ms: number;
}

/** First 16 hex characters of SHA-256(device key) — enough to correlate, not to recover. */
export async function hashDeviceKey(deviceKey: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(deviceKey),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

export function logDelivery(line: DeliveryLogLine): void {
  console.log(JSON.stringify(line));
}

/** Readiness/lifecycle events; also value-free. */
export function logEvent(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, ...fields }));
}
