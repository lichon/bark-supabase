/**
 * The routing table. Static paths come first, then the four V1 path variants
 * from longest to shortest so `/k/title/subtitle/body` never falls through to
 * `/k/body`.
 *
 * Contract: specs/001-bark-server-supabase/contracts/http-api.md
 */

import type { RouteDefinition } from "../router.ts";

const PUSH_METHODS = ["GET", "POST"];

function exact(name: string, path: string, methods: string[]): RouteDefinition {
  return {
    name,
    methods,
    match: (segments) => (segments.length === 1 && segments[0] === path ? {} : null),
  };
}

function root(name: string, methods: string[]): RouteDefinition {
  return {
    name,
    methods,
    match: (segments) => (segments.length === 0 ? {} : null),
  };
}

function pushPath(name: string, fieldNames: string[]): RouteDefinition {
  return {
    name,
    methods: PUSH_METHODS,
    match: (segments) => {
      if (segments.length !== fieldNames.length + 1) return null;
      const params: Record<string, string> = { device_key: segments[0] };
      fieldNames.forEach((field, index) => {
        params[field] = segments[index + 1];
      });
      return params;
    },
  };
}

export function buildRouteTable(): RouteDefinition[] {
  return [
    root("root", ["GET"]),
    exact("ping", "ping", ["GET"]),
    exact("healthz", "healthz", ["GET"]),
    exact("info", "info", ["GET"]),

    // Registration. `register_check` must precede the catch-all `/{device_key}`.
    exact("register", "register", ["GET", "POST"]),
    {
      name: "register_check",
      methods: ["GET"],
      match: (segments) =>
        segments.length === 2 && segments[0] === "register" ? { device_key: segments[1] } : null,
    },

    // v2: key in the body.
    exact("push", "push", ["POST"]),

    // v1: key (and optional title/subtitle/body) in the path.
    pushPath("push_v1_title_subtitle_body", ["title", "subtitle", "body"]),
    pushPath("push_v1_title_body", ["title", "body"]),
    pushPath("push_v1_body", ["body"]),
    pushPath("push_v1_key", []),
  ];
}
