/**
 * Configuration and readiness.
 *
 * Every value comes from Edge Function secrets. Failures name the variable and
 * never echo its value (FR-019, SC-006); `/healthz` calls `readiness()` so an
 * operator learns which secret is missing without reading code.
 *
 * Contract: specs/001-bark-server-supabase/contracts/apns-push.md
 */

import type { DeviceKind } from "./types.ts";
import { DEFAULT_TOPICS } from "./apns.ts";
import { importProviderKey, normalizeP8 } from "./jwt.ts";

export type EnvMap = Record<string, string | undefined>;

export class ConfigError extends Error {
  readonly variable: string;

  constructor(variable: string, detail: string) {
    super(`${variable}: ${detail}`);
    this.name = "ConfigError";
    this.variable = variable;
  }
}

export interface ApnsConfig {
  p8: string;
  keyId: string;
  teamId: string;
  topics: Record<DeviceKind, string>;
  env: "production" | "sandbox";
}

export interface RateLimitConfig {
  pushLimit: number;
  pushWindowSeconds: number;
  registerLimit: number;
  registerWindowSeconds: number;
}

export interface BarkConfig {
  apns: ApnsConfig;
  supabaseUrl: string;
  serviceRoleKey: string;
  serverToken?: string;
  deliveryRetentionDays: number;
  version: string;
  build: string;
  commit: string;
  arch: string;
  rateLimits: RateLimitConfig;
}

export const DEFAULT_RATE_LIMITS: RateLimitConfig = {
  pushLimit: 60,
  pushWindowSeconds: 60,
  registerLimit: 10,
  registerWindowSeconds: 60,
};

/** Structural check only; `readiness()` proves the key actually imports. */
export function looksLikePkcs8Pem(pem: string): boolean {
  const normalized = normalizeP8(pem).trim();
  return normalized.startsWith("-----BEGIN PRIVATE KEY-----") &&
    normalized.includes("-----END PRIVATE KEY-----");
}

function requireEnv(env: EnvMap, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === "") {
    throw new ConfigError(name, "is required but was not provided");
  }
  return value.trim();
}

function optionalNumber(env: EnvMap, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ConfigError(name, "must be a positive number");
  }
  return Math.trunc(parsed);
}

/**
 * Parses and validates configuration. Throws `ConfigError` naming the offending
 * variable — the message never contains a secret value.
 */
export function parseConfig(env: EnvMap): BarkConfig {
  const p8 = normalizeP8(requireEnv(env, "APNS_P8"));
  if (!looksLikePkcs8Pem(p8)) {
    throw new ConfigError("APNS_P8", "is not a PKCS#8 PEM private key");
  }

  const keyId = requireEnv(env, "APNS_KEY_ID");
  const teamId = requireEnv(env, "APNS_TEAM_ID");
  const apnsEnvRaw = (env["APNS_ENV"] ?? "production").trim().toLowerCase();
  if (apnsEnvRaw !== "production" && apnsEnvRaw !== "sandbox") {
    throw new ConfigError("APNS_ENV", "must be either production or sandbox");
  }

  const topics: Record<DeviceKind, string> = {
    ios: (env["APNS_TOPIC_IOS"] ?? "").trim() || DEFAULT_TOPICS.ios,
    watchos: (env["APNS_TOPIC_WATCH"] ?? "").trim() || DEFAULT_TOPICS.watchos,
  };

  return {
    apns: { p8, keyId, teamId, topics, env: apnsEnvRaw },
    supabaseUrl: requireEnv(env, "SUPABASE_URL"),
    serviceRoleKey: requireEnv(env, "SUPABASE_SERVICE_ROLE_KEY"),
    serverToken: (env["BARK_SERVER_TOKEN"] ?? "").trim() || undefined,
    deliveryRetentionDays: optionalNumber(env, "BARK_DELIVERY_RETENTION_DAYS", 30),
    version: (env["BARK_VERSION"] ?? "").trim() || "dev",
    build: (env["BARK_BUILD"] ?? "").trim() || "deno",
    commit: (env["BARK_COMMIT"] ?? "").trim(),
    arch: runtimeArch(),
    rateLimits: DEFAULT_RATE_LIMITS,
  };
}

export function runtimeArch(): string {
  const deno = (globalThis as { Deno?: { build?: { os?: string; arch?: string } } }).Deno;
  const os = deno?.build?.os;
  const arch = deno?.build?.arch;
  if (os && arch) return `${os}/${arch}`;
  return "unknown";
}

export interface ReadinessResult {
  ready: boolean;
  failingVariable?: string;
  message?: string;
}

const REQUIRED_VARIABLES = [
  "APNS_P8",
  "APNS_KEY_ID",
  "APNS_TEAM_ID",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
] as const;

/**
 * Readiness checks presence *and* that the APNs key imports as an EC P-256
 * PKCS#8 key, which is the only credential whose validity cannot be judged by
 * looking at it.
 */
export async function readiness(env: EnvMap): Promise<ReadinessResult> {
  for (const name of REQUIRED_VARIABLES) {
    const value = env[name];
    if (value === undefined || value.trim() === "") {
      return { ready: false, failingVariable: name, message: `${name} is not set` };
    }
  }

  try {
    await importProviderKey(normalizeP8(env["APNS_P8"] as string));
  } catch {
    return {
      ready: false,
      failingVariable: "APNS_P8",
      message: "APNS_P8 could not be imported as a P-256 PKCS#8 key",
    };
  }

  return { ready: true };
}
