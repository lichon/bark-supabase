import { assert, assertEquals, assertNotEquals } from "./asserts.ts";
import {
  TEST_KEY_ID,
  TEST_PRIVATE_KEY_PEM,
  TEST_PUBLIC_KEY_PEM,
  TEST_TEAM_ID,
} from "./fixtures.ts";
import {
  base64url,
  importProviderKey,
  invalidate,
  pemToDer,
  providerToken,
  signProviderToken,
} from "../_shared/jwt.ts";

function base64urlDecode(value: string): string {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - (value.length % 4)) % 4);
  return new TextDecoder().decode(Uint8Array.from(atob(padded), (c) => c.charCodeAt(0)));
}

const config = {
  keyId: TEST_KEY_ID,
  teamId: TEST_TEAM_ID,
  p8: TEST_PRIVATE_KEY_PEM,
};

Deno.test("provider token has the ES256 header and iss/iat claims", async () => {
  const issuedAt = 1_762_732_800;
  const token = await signProviderToken(config, issuedAt);
  const parts = token.split(".");
  assertEquals(parts.length, 3);

  assertEquals(JSON.parse(base64urlDecode(parts[0])), {
    alg: "ES256",
    kid: TEST_KEY_ID,
  });
  assertEquals(JSON.parse(base64urlDecode(parts[1])), {
    iss: TEST_TEAM_ID,
    iat: issuedAt,
  });
});

Deno.test("provider token signature verifies with the derived public key", async () => {
  const token = await signProviderToken(config, 1_762_732_800);
  const [header, claims, signature] = token.split(".");

  const publicKey = await crypto.subtle.importKey(
    "spki",
    pemToDer(TEST_PUBLIC_KEY_PEM),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );

  const signatureBytes = Uint8Array.from(
    atob(signature.replace(/-/g, "+").replace(/_/g, "/")),
    (c) => c.charCodeAt(0),
  );

  const valid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    signatureBytes,
    new TextEncoder().encode(`${header}.${claims}`),
  );

  assert(valid, "ES256 signature should verify against the public key");
  assertEquals(signatureBytes.length, 64, "raw r||s signatures are 64 bytes");
});

Deno.test("provider token is cached and refreshed only after invalidate()", async () => {
  invalidate();
  const first = await providerToken(config);
  const second = await providerToken(config);
  assertEquals(second, first, "the cache must return the identical token");

  invalidate();
  // ECDSA signatures may be deterministic, so prove a re-sign by moving the clock:
  // a cached token would keep the original `iat`.
  const later = Date.now() + 120_000;
  const third = await providerToken(config, later);
  const claims = JSON.parse(base64urlDecode(third.split(".")[1]));
  assertNotEquals(claims.iat, JSON.parse(base64urlDecode(first.split(".")[1])).iat);
  assertEquals(third.split(".").length, 3);
});

Deno.test("nested caches are isolate-wide but keyed by credential identity", async () => {
  invalidate();
  const first = await providerToken(config);
  const rotated = await providerToken({ ...config, keyId: "ZZZZZZZZZZ" });
  assertNotEquals(rotated, first);

  const header = JSON.parse(base64urlDecode(rotated.split(".")[0]));
  assertEquals(header.kid, "ZZZZZZZZZZ");
  invalidate();
});

Deno.test("a non-PKCS8 PEM fails to import", async () => {
  let failed = false;
  try {
    await importProviderKey("-----BEGIN PRIVATE KEY-----\nnot-a-key\n-----END PRIVATE KEY-----\n");
  } catch {
    failed = true;
  }
  assert(failed, "import must reject malformed key material");
});

Deno.test("base64url has no padding and uses the URL-safe alphabet", () => {
  const encoded = base64url(new Uint8Array([251, 255, 191]));
  assertEquals(encoded.includes("+"), false);
  assertEquals(encoded.includes("/"), false);
  assertEquals(encoded.includes("="), false);
});
