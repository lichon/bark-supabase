import { assertEquals } from "./asserts.ts";
import { createMiscHandlers } from "../_shared/routes/misc.ts";
import { parseConfig } from "../_shared/config.ts";
import { validEnv } from "./fixtures.ts";

async function jsonBody(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

Deno.test("GET / returns the liveness text", async () => {
  const env = validEnv();
  const handlers = createMiscHandlers({ config: parseConfig(env), env });
  const response = handlers.root();
  assertEquals(response.status, 200);
  assertEquals(await response.text(), "ok");
  assertEquals(response.headers.get("cache-control"), "no-store");
});

Deno.test("GET /ping returns the pong envelope with a timestamp", async () => {
  const env = validEnv();
  const handlers = createMiscHandlers({ config: parseConfig(env), env });
  const body = await jsonBody(handlers.ping());

  assertEquals(body["code"], 200);
  assertEquals(body["message"], "pong");
  assertEquals(typeof body["timestamp"], "number");
  assertEquals(body["data"], undefined);
});

Deno.test("GET /info reports build fields and the live device count", async () => {
  const env = validEnv();
  const handlers = createMiscHandlers({
    config: { ...parseConfig(env), version: "1.2.3", commit: "abc1234", arch: "linux/x86_64" },
    env,
    countDevices: () => Promise.resolve(7),
  });

  const body = await jsonBody(await handlers.info());
  assertEquals(body["code"], 200);
  const data = body["data"] as Record<string, unknown>;
  assertEquals(data["version"], "1.2.3");
  assertEquals(data["commit"], "abc1234");
  assertEquals(data["arch"], "linux/x86_64");
  assertEquals(data["devices"], 7);
  assertEquals(typeof data["build"], "string");

  const serialized = JSON.stringify(body);
  assertEquals(serialized.includes(env["SUPABASE_SERVICE_ROLE_KEY"] as string), false);
  assertEquals(serialized.includes("BEGIN PRIVATE KEY"), false);
});

Deno.test("/info still answers when the device count query fails", async () => {
  const env = validEnv();
  const handlers = createMiscHandlers({
    config: parseConfig(env),
    env,
    countDevices: () => Promise.reject(new Error("db down")),
  });
  const body = await jsonBody(await handlers.info());
  assertEquals((body["data"] as Record<string, unknown>)["devices"], 0);
});

Deno.test("/healthz returns ok when every credential loads", async () => {
  const env = validEnv();
  const handlers = createMiscHandlers({ config: parseConfig(env), env });
  const response = await handlers.healthz();
  assertEquals(response.status, 200);
  assertEquals(await response.text(), "ok");
});

Deno.test("/healthz names the failing variable and never echoes its value", async () => {
  const env: Record<string, string> = { ...validEnv(), APNS_KEY_ID: "" };
  const handlers = createMiscHandlers({ config: parseConfig(validEnv()), env });

  const response = await handlers.healthz();
  assertEquals(response.status, 503);
  const text = await response.text();
  assertEquals(text.includes("APNS_KEY_ID"), true);
  assertEquals(text.includes(env["SUPABASE_SERVICE_ROLE_KEY"] as string), false);
});

Deno.test("/healthz reports an unusable .p8 by variable name", async () => {
  const env = {
    ...validEnv(),
    APNS_P8: "-----BEGIN PRIVATE KEY-----\nnot-a-key\n-----END PRIVATE KEY-----\n",
  };
  const handlers = createMiscHandlers({ config: parseConfig(validEnv()), env });

  const response = await handlers.healthz();
  assertEquals(response.status, 503);
  const text = await response.text();
  assertEquals(text.includes("APNS_P8"), true);
  assertEquals(text.includes("not-a-key"), false);
});
