/**
 * Bark push server — single catch-all Edge Function.
 *
 * `Deno.serve` wires configuration, CORS preflight, the routing table and one
 * top-level error handler, then delegates every route to `_shared/routes/*`.
 * Unexpected throws become a generic `500` envelope so internals never leak.
 *
 * Contract: specs/001-bark-server-supabase/contracts/http-api.md
 */

import { type BarkConfig, ConfigError, parseConfig } from "../_shared/config.ts";
import {
  formDataToObject,
  normalize,
  type NormalizeInput,
  parseFormEncoded,
} from "../_shared/params.ts";
import { logEvent } from "../_shared/log.ts";
import { registerBucket, rejectionResponse, unauthorizedResponse } from "../_shared/ratelimit.ts";
import { createMiscHandlers } from "../_shared/routes/misc.ts";
import { handlePush, type SendNotification } from "../_shared/routes/push.ts";
import { handleRegister, handleRegisterCheck } from "../_shared/routes/register.ts";
import { buildRouteTable } from "../_shared/routes/table.ts";
import {
  BarkError,
  envelopeResponse,
  errorResponse,
  failed,
  optionsResponse,
} from "../_shared/response.ts";
import {
  matchRoute,
  methodNotAllowedResponse,
  notFoundResponse,
  stripPrefix,
} from "../_shared/router.ts";
import { providerToken } from "../_shared/jwt.ts";
import { send as sendApns, type SendOptions } from "../_shared/apns.ts";
import { createServiceClient, createStore, type Store } from "../_shared/store.ts";
import type { DeliveryOrigin } from "../_shared/types.ts";

const ROUTES = buildRouteTable();
const FUNCTION_SLUG = "bark";

let configCache: BarkConfig | null = null;

function loadConfig(env: Record<string, string | undefined>): BarkConfig {
  if (configCache) return configCache;
  configCache = parseConfig(env);
  return configCache;
}

/** Lenient config for the endpoints that must answer even when secrets are missing. */
function lenientConfig(env: Record<string, string | undefined>): BarkConfig {
  try {
    return loadConfig(env);
  } catch {
    return {
      apns: {
        p8: "",
        keyId: "",
        teamId: "",
        topics: { ios: "me.fin.bark", watchos: "me.fin.bark.watch" },
        env: "production",
      },
      supabaseUrl: env["SUPABASE_URL"] ?? "",
      serviceRoleKey: env["SUPABASE_SERVICE_ROLE_KEY"] ?? "",
      serverToken: env["BARK_SERVER_TOKEN"],
      deliveryRetentionDays: 30,
      version: env["BARK_VERSION"] ?? "dev",
      build: env["BARK_BUILD"] ?? "deno",
      commit: env["BARK_COMMIT"] ?? "",
      arch: "unknown",
      rateLimits: {
        pushLimit: 60,
        pushWindowSeconds: 60,
        registerLimit: 10,
        registerWindowSeconds: 60,
      },
    };
  }
}

async function readBody(request: Request): Promise<NormalizeInput["body"]> {
  const contentType = (request.headers.get("content-type") ?? "").toLowerCase();
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD") return null;

  const raw = await request.text();
  if (raw.trim() === "") return null;

  if (contentType.includes("application/json")) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new BarkError("malformed json");
      }
      return parsed as Record<string, unknown>;
    } catch (error) {
      if (error instanceof BarkError) throw error;
      throw new BarkError("malformed json");
    }
  }

  if (contentType.includes("application/x-www-form-urlencoded")) {
    return parseFormEncoded(raw);
  }

  if (contentType.includes("multipart/form-data")) {
    try {
      const form = await new Response(raw, {
        headers: { "content-type": contentType },
      }).formData();
      return formDataToObject(form);
    } catch {
      throw new BarkError("malformed form body");
    }
  }

  // No/unknown content type: accept anything that parses as JSON, then as a form.
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through to form parsing
  }
  return parseFormEncoded(raw);
}

function readQuery(url: URL): URLSearchParams {
  return url.searchParams;
}

function isAuthorized(request: Request, serverToken: string | undefined): boolean {
  if (!serverToken) return true;
  const header = request.headers.get("authorization") ?? "";
  const lower = header.toLowerCase();
  if (lower.startsWith("bearer ")) {
    return header.slice(7).trim() === serverToken;
  }
  if (lower.startsWith("basic ")) {
    try {
      const decoded = atob(header.slice(6).trim());
      const separator = decoded.indexOf(":");
      const supplied = separator >= 0 ? decoded.slice(separator + 1) : decoded;
      return supplied === serverToken;
    } catch {
      return false;
    }
  }
  return false;
}

function clientAddress(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return request.headers.get("cf-connecting-ip") ?? "unknown";
}

async function buildStore(config: BarkConfig): Promise<Store> {
  const client = await createServiceClient({
    supabaseUrl: config.supabaseUrl,
    serviceRoleKey: config.serviceRoleKey,
  });
  return createStore(client);
}

function makeSend(config: BarkConfig): SendNotification {
  return async ({ device, params, payload }) => {
    const options: SendOptions = {
      deviceToken: device.device_token,
      deviceKind: device.device_kind,
      payload,
      params,
      token: await providerToken(config.apns),
      topics: config.apns.topics,
      env: config.apns.env,
      resignToken: () => providerToken(config.apns, Date.now() + 0),
    };
    return await sendApns(options);
  };
}

async function dispatch(
  request: Request,
  url: URL,
  routeName: string,
  params: Record<string, string>,
  env: Record<string, string | undefined>,
): Promise<Response> {
  switch (routeName) {
    case "root":
    case "ping":
    case "healthz":
    case "info": {
      const config = lenientConfig(env);
      let store: Store | null = null;
      const handlers = createMiscHandlers({
        config,
        env,
        countDevices: async () => {
          store = store ?? await buildStore(config);
          return await store.countDevices();
        },
      });
      if (routeName === "root") return handlers.root();
      if (routeName === "ping") return handlers.ping();
      if (routeName === "healthz") return await handlers.healthz();
      return await handlers.info();
    }

    case "register":
    case "register_check": {
      const config = loadConfig(env);
      const store = await buildStore(config);
      if (routeName === "register_check") {
        return await handleRegisterCheck({ store }, params["device_key"]);
      }
      const bucket = await registerBucket(clientAddress(request));
      const outcome = await store.hitRateLimit(
        bucket,
        config.rateLimits.registerLimit,
        config.rateLimits.registerWindowSeconds,
      );
      if (!outcome.allowed) return rejectionResponse(outcome.retryAfter);
      return await handleRegister({ store }, {
        body: await readBody(request),
        query: readQuery(url),
        contentType: request.headers.get("content-type") ?? undefined,
      });
    }

    case "push":
    case "push_v1_key":
    case "push_v1_body":
    case "push_v1_title_body":
    case "push_v1_title_subtitle_body": {
      const config = loadConfig(env);
      const store = await buildStore(config);
      const contentType = request.headers.get("content-type") ?? "";
      const body = await readBody(request);
      const origin: DeliveryOrigin = routeName === "push"
        ? "v2_json"
        : body && /x-www-form-urlencoded|multipart\/form-data/i.test(contentType)
        ? "v1_form"
        : "v1_path";
      const input: NormalizeInput = {
        path: params,
        body,
        query: readQuery(url),
        contentType: contentType || undefined,
      };
      const normalized = normalize(input);
      return await handlePush(
        {
          store,
          config,
          sendNotification: makeSend(config),
          rateLimit: (bucket, limit, windowSeconds) =>
            store.hitRateLimit(bucket, limit, windowSeconds),
        },
        normalized,
        origin,
      );
    }

    default:
      return notFoundResponse();
  }
}

export async function handler(request: Request): Promise<Response> {
  const env = Deno.env.toObject();

  if (request.method.toUpperCase() === "OPTIONS") return optionsResponse();

  const url = new URL(request.url);
  const remainder = stripPrefix(url.pathname, FUNCTION_SLUG);
  if (remainder === null) return notFoundResponse();

  const match = matchRoute(ROUTES, request.method, remainder);
  if (match.kind === "not_found") return notFoundResponse();
  if (match.kind === "method_not_allowed") return methodNotAllowedResponse(match.allow);

  const routeName = match.route?.name ?? "";
  const needsAuth = !["root", "ping", "healthz"].includes(routeName);
  if (needsAuth && !isAuthorized(request, env["BARK_SERVER_TOKEN"])) {
    return unauthorizedResponse();
  }

  try {
    return await dispatch(request, url, routeName, match.params, env);
  } catch (error) {
    if (error instanceof ConfigError) {
      logEvent("config_error", { variable: error.variable });
      return envelopeResponse(failed(503, error.message));
    }
    // Keep the client response opaque, but leave a value-free trace so a 500 can
    // be diagnosed from the Edge Function logs instead of being a black box.
    logEvent("unhandled_error", {
      route: routeName,
      error: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : String(error),
    });
    return errorResponse(error);
  }
}

if (import.meta.main) {
  Deno.serve(handler);
}
