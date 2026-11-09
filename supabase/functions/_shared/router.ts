/**
 * Pure path matcher for the single catch-all Edge Function.
 *
 * Supabase serves functions at `/functions/v1/<slug>` and offers no root
 * rewrite, so the Bark base address includes that prefix. `stripPrefix` removes
 * it and `matchRoute` dispatches on what is left. Nothing here touches the
 * network or the clock, which is what makes the routing contract unit-testable.
 *
 * Contract: specs/001-bark-server-supabase/contracts/http-api.md
 */

import { failed, jsonResponse } from "./response.ts";

export const FUNCTIONS_MOUNT = "";

export type RouteKind = "route" | "not_found" | "method_not_allowed";

export interface RouteDefinition {
  /** Stable id used to look up the handler in the entrypoint. */
  name: string;
  /** Methods this route answers; used for the `Allow` header on 405. */
  methods: string[];
  /**
   * Returns the extracted path parameters when this route matches the
   * remainder, or `null` when it does not. Segments arrive still URL-encoded —
   * `params.normalize` performs the single decode, matching the reference
   * server, so `%2F` survives segment splitting.
   */
  match: (segments: string[]) => Record<string, string> | null;
}

export interface RouteResult {
  kind: RouteKind;
  route?: RouteDefinition;
  params: Record<string, string>;
  allow: string[];
}

/**
 * Removes `/functions/v1/<slug>` (or `/<slug>` when mounted at the root) from a
 * pathname. Returns `null` when the prefix is absent, so a misconfigured server
 * address produces a 404 instead of silently matching.
 */
export function stripPrefix(
  pathname: string,
  slug: string,
  mount: string = FUNCTIONS_MOUNT,
): string | null {
  const prefix = mount === "" || mount === "/" ? `/${slug}` : `${mount.replace(/\/$/, "")}/${slug}`;
  if (pathname === prefix) return "/";
  if (!pathname.startsWith(`${prefix}/`)) return null;
  return pathname.slice(prefix.length);
}

/** Splits a remainder path into raw (still-encoded) segments. */
export function splitPath(remainder: string): string[] {
  return remainder.split("/").filter((segment) => segment.length > 0);
}

export function matchRoute(
  routes: readonly RouteDefinition[],
  method: string,
  remainder: string,
): RouteResult {
  const segments = splitPath(remainder);
  const upper = method.toUpperCase();

  // First match wins: the table lists static paths before dynamic ones, so
  // `GET /ping` can never be mistaken for a device key called "ping", and a wrong
  // method on a static path reports only that path's methods.
  for (const route of routes) {
    const params = route.match(segments);
    if (params === null) continue;
    if (route.methods.includes(upper)) {
      return { kind: "route", route, params, allow: [...route.methods] };
    }
    return { kind: "method_not_allowed", params: {}, allow: [...route.methods].sort() };
  }

  return { kind: "not_found", params: {}, allow: [] };
}

export function notFoundResponse(): Response {
  return jsonResponse(failed(404, "not found"), { status: 404 });
}

export function methodNotAllowedResponse(allow: string[]): Response {
  return jsonResponse(failed(405, "method not allowed"), {
    status: 405,
    headers: { allow: allow.join(", ") },
  });
}
