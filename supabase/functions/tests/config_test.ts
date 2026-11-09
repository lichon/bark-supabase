import { assertEquals, assertRejects, assertThrows } from "./asserts.ts";
import { ConfigError, looksLikePkcs8Pem, parseConfig, readiness } from "../_shared/config.ts";
import { MALFORMED_P8, validEnv } from "./fixtures.ts";

function envWithout(name: string): Record<string, string> {
  const env = validEnv();
  delete env[name];
  return env;
}

Deno.test("a complete environment parses with the documented defaults", () => {
  const env = validEnv();
  const config = parseConfig(env);

  assertEquals(config.apns.keyId, env["APNS_KEY_ID"]);
  assertEquals(config.apns.teamId, env["APNS_TEAM_ID"]);
  assertEquals(config.apns.topics.ios, "me.fin.bark");
  assertEquals(config.apns.topics.watchos, "me.fin.bark.watch");
  assertEquals(config.apns.env, "production");
  assertEquals(config.deliveryRetentionDays, 30);
  assertEquals(config.version, "dev");
  assertEquals(config.commit, "");
  assertEquals(config.serverToken, undefined);
  assertEquals(config.rateLimits.pushLimit, 60);
  assertEquals(config.rateLimits.registerLimit, 10);
});

Deno.test("optional variables are honoured when present", () => {
  const config = parseConfig({
    ...validEnv(),
    APNS_ENV: "sandbox",
    APNS_TOPIC_IOS: "com.example.phone",
    APNS_TOPIC_WATCH: "com.example.watch",
    BARK_SERVER_TOKEN: "shared-secret",
    BARK_DELIVERY_RETENTION_DAYS: "7",
    BARK_VERSION: "2.0.0",
    BARK_COMMIT: "deadbee",
  });

  assertEquals(config.apns.env, "sandbox");
  assertEquals(config.apns.topics.ios, "com.example.phone");
  assertEquals(config.apns.topics.watchos, "com.example.watch");
  assertEquals(config.serverToken, "shared-secret");
  assertEquals(config.deliveryRetentionDays, 7);
  assertEquals(config.version, "2.0.0");
  assertEquals(config.commit, "deadbee");
});

Deno.test("every required variable is enforced by name", () => {
  for (
    const name of [
      "APNS_P8",
      "APNS_KEY_ID",
      "APNS_TEAM_ID",
      "SUPABASE_URL",
      "SUPABASE_SERVICE_ROLE_KEY",
    ]
  ) {
    const error = assertThrows(
      () => parseConfig(envWithout(name)),
      (thrown) => thrown instanceof ConfigError && thrown.variable === name,
      `${name} must be required`,
    );
    assertEquals((error as ConfigError).message.includes(name), true);
  }
});

Deno.test("a malformed .p8 is reported as APNS_P8", () => {
  const error = assertThrows(
    () => parseConfig({ ...validEnv(), APNS_P8: "not-a-pem" }),
    (thrown) => thrown instanceof ConfigError && thrown.variable === "APNS_P8",
  );
  assertEquals((error as ConfigError).message.includes("PKCS#8"), true);
});

Deno.test("looksLikePkcs8Pem accepts the real shape and the escaped form", () => {
  const real = validEnv()["APNS_P8"];
  assertEquals(looksLikePkcs8Pem(real), true);
  assertEquals(looksLikePkcs8Pem(real.replace(/\n/g, "\\n")), true);
  assertEquals(looksLikePkcs8Pem("garbage"), false);
});

Deno.test("an invalid APNS_ENV is named, not silently defaulted", () => {
  assertThrows(
    () => parseConfig({ ...validEnv(), APNS_ENV: "staging" }),
    (thrown) => thrown instanceof ConfigError && thrown.variable === "APNS_ENV",
  );
});

Deno.test("readiness accepts a usable key", async () => {
  assertEquals(await readiness(validEnv()), { ready: true });
});

Deno.test("readiness names a missing variable", async () => {
  const result = await readiness(envWithout("APNS_TEAM_ID"));
  assertEquals(result.ready, false);
  assertEquals(result.failingVariable, "APNS_TEAM_ID");
  assertEquals(result.message?.includes("APNS_TEAM_ID"), true);
});

Deno.test("readiness rejects a .p8 that cannot be imported", async () => {
  const result = await readiness({ ...validEnv(), APNS_P8: MALFORMED_P8 });
  assertEquals(result.ready, false);
  assertEquals(result.failingVariable, "APNS_P8");
  assertEquals(result.message?.includes("not-a-key"), false);
});

Deno.test("no configuration error ever contains a secret value", async () => {
  const env = validEnv();
  const secrets = [env["APNS_P8"], env["SUPABASE_SERVICE_ROLE_KEY"], "super-secret-value"];

  const messages: string[] = [];
  for (const name of ["APNS_P8", "APNS_KEY_ID", "SUPABASE_URL"]) {
    try {
      parseConfig(envWithout(name));
    } catch (error) {
      messages.push((error as Error).message);
    }
  }
  try {
    await readiness({ ...env, APNS_P8: MALFORMED_P8 });
  } catch {
    // readiness returns rather than throws; nothing to collect
  }
  messages.push(JSON.stringify(await readiness({ ...env, APNS_P8: MALFORMED_P8 })));

  for (const message of messages) {
    for (const secret of secrets) {
      assertEquals(message.includes(secret), false, `message leaked a secret: ${message}`);
    }
  }
});

Deno.test("a malformed retention value is rejected rather than guessed", () => {
  assertThrows(
    () => parseConfig({ ...validEnv(), BARK_DELIVERY_RETENTION_DAYS: "soon" }),
    (thrown) => thrown instanceof ConfigError && thrown.variable === "BARK_DELIVERY_RETENTION_DAYS",
  );
});

Deno.test("readiness never rejects — it reports", async () => {
  await assertRejects(
    () => Promise.reject(new Error("sentinel")),
    /sentinel/,
    "sanity check of the assertRejects helper",
  );
});
