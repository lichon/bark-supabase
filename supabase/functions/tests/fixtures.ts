/**
 * Shared unit-test fixtures. Pure data only — no network, no filesystem access
 * beyond this module, so every test runs with `deno test` alone.
 */

/** PKCS#8 P-256 private key used to sign provider tokens in tests. */
export const TEST_PRIVATE_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgsMCgTjEdt1ibAuuL
Cq7DhPZ6Hlvhd0Vwt5GS9im2YwGhRANCAATKX7pYCvZjjP6RB5s5+ym56IJ6pWi9
s1OqaH5shCgjrv0gz1q4qYmu3IwhvU0CqadAhnG+XUjHgWBR9TwucDYg
-----END PRIVATE KEY-----`;

/** Matching SPKI public key, used to verify the ES256 signature in tests. */
export const TEST_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEyl+6WAr2Y4z+kQebOfspueiCeqVo
vbNTqmh+bIQoI679IM9auKmJrtyMIb1NAqmnQIZxvl1Ix4FgUfU8LnA2IA==
-----END PUBLIC KEY-----`;

/** A PEM that parses as base64 but is not an EC P-256 PKCS#8 key. */
export const MALFORMED_P8 = "-----BEGIN PRIVATE KEY-----\nnot-a-key\n-----END PRIVATE KEY-----\n";

export const TEST_KEY_ID = "LH4T9V5U4R";
export const TEST_TEAM_ID = "5U8LBRXG3A";
export const TEST_TOPIC_IOS = "me.fin.bark";
export const TEST_TOPIC_WATCH = "me.fin.bark.watch";

/** A well-formed 64-character hex APNs token (the shape the app registers). */
export const VALID_DEVICE_TOKEN =
  "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";

/** Alias used by the APNs transport tests. */
export const TEST_DEVICE_TOKEN = VALID_DEVICE_TOKEN;

/** 161 characters — one over the documented limit. */
export const OVERSIZED_DEVICE_TOKEN = "a".repeat(161);

export const EMPTY_DEVICE_TOKEN = "";

/** A key that satisfies `^[A-Za-z0-9]{6,32}$`. */
export const TEST_DEVICE_KEY = "ynJ5Ft4atkMkWeo2PAvFhF";

export const TEST_DEVICE_KEY_2 = "Qm7Zr2LpTx9Kv4Nb8Wd3Hc";

/** Minimal environment that passes config validation. */
export function validEnv(): Record<string, string> {
  return {
    APNS_P8: TEST_PRIVATE_KEY_PEM,
    APNS_KEY_ID: TEST_KEY_ID,
    APNS_TEAM_ID: TEST_TEAM_ID,
    APNS_TOPIC_IOS: TEST_TOPIC_IOS,
    APNS_TOPIC_WATCH: TEST_TOPIC_WATCH,
    SUPABASE_URL: "https://project-ref.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key-value",
  };
}

/** Parameter maps for each documented request shape. */
export const JSON_PUSH_PARAMS = {
  device_key: TEST_DEVICE_KEY,
  title: "Hello",
  body: "World",
};

export const PATH_PUSH_PARAMS = {
  device_key: TEST_DEVICE_KEY,
  title: "Hello",
  body: "World",
};

export const FORM_PUSH_PARAMS = {
  device_key: TEST_DEVICE_KEY,
  body: "World",
  group: "chat",
  sound: "minuet",
};

export const RICH_PUSH_PARAMS = {
  device_key: TEST_DEVICE_KEY,
  title: "Rich",
  subtitle: "sub",
  body: "Body",
  level: "timeSensitive",
  volume: 0.5,
  sound: "alarm",
  badge: 3,
  group: "ops",
  icon: "https://example.test/icon.png",
  url: "https://bark.day.app",
  action: "none",
  autoCopy: "1",
  copy: "copied",
  call: "1",
  id: "collapse-1",
  ttl: 120,
};

/** Batch key lists covering array, comma string and mixed input. */
export const BATCH_KEY_LIST = [TEST_DEVICE_KEY, TEST_DEVICE_KEY_2];
export const BATCH_KEY_STRING = `${TEST_DEVICE_KEY},${TEST_DEVICE_KEY_2}`;
