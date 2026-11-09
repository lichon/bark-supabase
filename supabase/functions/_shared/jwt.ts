/**
 * APNs provider token (ES256 JWT) minted with Web Crypto.
 *
 * APNs accepts a token for one hour and throttles re-signing faster than once per
 * 20 minutes, so the token is cached per isolate for 50 minutes. A token that
 * cannot be signed (wrong curve, malformed PEM) is a readiness failure, not a
 * per-push failure.
 *
 * Contract: specs/001-bark-server-supabase/contracts/apns-push.md
 */

export const TOKEN_TTL_SECONDS = 50 * 60;

export interface ProviderKeyConfig {
  keyId: string;
  teamId: string;
  /** PKCS#8 PEM, literal or `\n`-escaped newlines. */
  p8: string;
}

interface CacheEntry {
  token: string;
  issuedAt: number;
  fingerprint: string;
}

let cache: CacheEntry | null = null;

/** Accepts a `.p8` whose newlines were escaped when stored in an env var. */
export function normalizeP8(pem: string): string {
  return pem.includes("\\n") ? pem.replace(/\\n/g, "\n") : pem;
}

export function base64url(input: Uint8Array | string): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function pemToDer(pem: string): Uint8Array<ArrayBuffer> {
  const normalized = normalizeP8(pem).trim();
  const body = normalized
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  if (body === "") throw new Error("empty PEM body");
  const binary = atob(body);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Imports the P-256 PKCS#8 key; rejects any other curve or malformed input. */
export function importProviderKey(p8: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "pkcs8",
    pemToDer(p8),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

/** Signs a provider token for the supplied `iat` (Unix seconds). */
export async function signProviderToken(
  config: ProviderKeyConfig,
  issuedAt: number,
): Promise<string> {
  const key = await importProviderKey(config.p8);
  const header = base64url(JSON.stringify({ alg: "ES256", kid: config.keyId }));
  const claims = base64url(JSON.stringify({ iss: config.teamId, iat: issuedAt }));
  const signingInput = `${header}.${claims}`;
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64url(new Uint8Array(signature))}`;
}

export function nowSeconds(now: number = Date.now()): number {
  return Math.floor(now / 1000);
}

function fingerprint(config: ProviderKeyConfig): string {
  return `${config.keyId}:${config.teamId}:${config.p8.length}`;
}

/** Returns the cached token, re-signing only when it is missing or expired. */
export async function providerToken(
  config: ProviderKeyConfig,
  now: number = Date.now(),
): Promise<string> {
  const current = nowSeconds(now);
  const print = fingerprint(config);
  if (cache && cache.fingerprint === print && current - cache.issuedAt < TOKEN_TTL_SECONDS) {
    return cache.token;
  }
  const token = await signProviderToken(config, current);
  cache = { token, issuedAt: current, fingerprint: print };
  return token;
}

/** Drops the cache so the next call re-signs (credential rotation, or an APNs `ExpiredProviderToken`). */
export function invalidate(): void {
  cache = null;
}

export function cachedTokenIssuedAt(): number | null {
  return cache ? cache.issuedAt : null;
}
