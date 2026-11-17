/**
 * Per-invocation request correlation id.
 *
 * Supabase assigns an id to every Edge Function call at the gateway and to every
 * execution in the runtime; both surface as response headers
 * (`sb-request-id`, `x-deno-execution-id`) and are what the dashboard log search
 * and support threads key on. When the gateway forwards them, reusing that value
 * makes a `bark.delivery.request_id` line up with the invocation logs instead of
 * being an unrelated random UUID.
 *
 * Only UUID-shaped values are accepted, because `bark.delivery.request_id` is a
 * `uuid` column — Cloudflare's `cf-ray` (e.g. `99aba53fda5803f-MIA`) is not one,
 * so it is never used. Anything missing or malformed falls back to a fresh UUID,
 * which keeps local `deno serve` and self-hosted runs (no gateway) working.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Candidate headers, most authoritative first: the Supabase gateway's id (what
 * clients get back and can quote), then a caller-supplied id, then the runtime's
 * execution id.
 */
const REQUEST_ID_HEADERS: readonly string[] = [
  "sb-request-id",
  "x-request-id",
  "x-deno-execution-id",
  "x-correlation-id",
];

/** Reuses the platform's id for this call, falling back to a generated UUID. */
export function requestIdFrom(headers: Headers): string {
  for (const name of REQUEST_ID_HEADERS) {
    const value = headers.get(name)?.trim().toLowerCase();
    if (value && UUID_PATTERN.test(value)) return value;
  }
  return crypto.randomUUID();
}
