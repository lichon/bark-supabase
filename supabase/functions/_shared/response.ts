/**
 * Response envelope and HTTP helpers.
 *
 * Every JSON body the clients see uses the reference shape (contract:
 * specs/001-bark-server-supabase/contracts/http-api.md):
 *
 *   { "code": 200, "message": "success", "data": <optional>, "timestamp": 1762732800 }
 *
 * These builders are pure: given values in, serialisable objects out. The
 * `Response` wrappers add the required `cache-control: no-store` and CORS
 * headers.
 */

export interface Envelope<T = unknown> {
  code: number;
  message: string;
  data?: T;
  timestamp: number;
}

export const DEFAULT_MESSAGE = "success";

export const CORS_HEADERS: Readonly<Record<string, string>> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, apikey, x-client-info",
  "access-control-max-age": "86400",
};

/**
 * An expected, client-visible failure. Anything else that escapes a handler is
 * converted to a generic 500 so internals never reach the response body.
 */
export class BarkError extends Error {
  readonly code: number;
  readonly headers: Record<string, string>;

  constructor(message: string, code = 400, headers: Record<string, string> = {}) {
    super(message);
    this.name = "BarkError";
    this.code = code;
    this.headers = headers;
  }
}

/** Unix seconds — the envelope's `timestamp` field. */
export function nowSeconds(now: number = Date.now()): number {
  return Math.floor(now / 1000);
}

export function success<T>(data?: T, message: string = DEFAULT_MESSAGE): Envelope<T> {
  const envelope: Envelope<T> = { code: 200, message, timestamp: nowSeconds() };
  if (data !== undefined) envelope.data = data;
  return envelope;
}

/** Envelope carrying a result payload (registration, batch results). */
export function data<T>(payload: T): Envelope<T> {
  return success(payload);
}

export function failed(code: number, message: string): Envelope<never> {
  return { code, message, timestamp: nowSeconds() };
}

export function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  const headers: Record<string, string> = {
    ...CORS_HEADERS,
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...(init.headers ?? {}),
  };
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers });
}

export function textResponse(
  text: string,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  const headers: Record<string, string> = {
    ...CORS_HEADERS,
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    ...(init.headers ?? {}),
  };
  return new Response(text, { status: init.status ?? 200, headers });
}

export function envelopeResponse(
  envelope: Envelope<unknown>,
  extraHeaders: Record<string, string> = {},
): Response {
  return jsonResponse(envelope, { status: envelope.code, headers: extraHeaders });
}

export function optionsResponse(): Response {
  return new Response(null, { status: 204, headers: { ...CORS_HEADERS } });
}

/**
 * Converts a thrown value into a client-visible response. `BarkError` keeps its
 * message and status; everything else becomes a generic 500.
 */
export function errorResponse(error: unknown): Response {
  if (error instanceof BarkError) {
    return jsonResponse(failed(error.code, error.message), {
      status: error.code,
      headers: error.headers,
    });
  }
  return jsonResponse(failed(500, "internal server error"), { status: 500 });
}
