import { assert, assertEquals } from "./asserts.ts";
import {
  buildHeaders,
  classify,
  EXPIRATION_SECONDS,
  isInvalidTokenFailure,
  MAX_ATTEMPTS,
  retryDelaySeconds,
  send,
  type SendOptions,
  shouldRetry,
} from "../_shared/apns.ts";
import { TEST_DEVICE_TOKEN } from "./fixtures.ts";

Deno.test("classify maps every documented APNs outcome", () => {
  const cases: Array<[number, string | undefined, string]> = [
    [200, undefined, "delivered"],
    [400, "BadDeviceToken", "permanent"],
    [400, "DeviceTokenNotForTopic", "permanent"],
    [400, "PayloadTooLarge", "permanent"],
    [403, "InvalidProviderToken", "credential"],
    [403, "ExpiredProviderToken", "credential"],
    [410, "Unregistered", "permanent"],
    [429, "TooManyRequests", "transient"],
    [500, "InternalServerError", "transient"],
    [503, "ServiceUnavailable", "transient"],
    [0, "timeout", "transient"],
  ];

  for (const [status, reason, expected] of cases) {
    assertEquals(classify(status, reason), expected, `status ${status} / ${reason}`);
  }
});

Deno.test("only 410 and 400 BadDeviceToken invalidate a registration", () => {
  assert(isInvalidTokenFailure(410, "Unregistered"));
  assert(isInvalidTokenFailure(400, "BadDeviceToken"));
  assertEquals(isInvalidTokenFailure(400, "DeviceTokenNotForTopic"), false);
  assertEquals(isInvalidTokenFailure(429, "TooManyRequests"), false);
});

Deno.test("buildHeaders sets the topic for each device kind", () => {
  const ios = buildHeaders({}, "ios", 1_762_732_800);
  assertEquals(ios["apns-topic"], "me.fin.bark");

  const watch = buildHeaders({}, "watchos", 1_762_732_800);
  assertEquals(watch["apns-topic"], "me.fin.bark.watch");
});

Deno.test("buildHeaders sets alert priorities and a 24 hour expiration", () => {
  const headers = buildHeaders({ title: "t", body: "b" }, "ios", 1_762_732_800, {
    token: "jwt-value",
  });

  assertEquals(headers["apns-push-type"], "alert");
  assertEquals(headers["apns-priority"], "10");
  assertEquals(headers["apns-expiration"], String(1_762_732_800 + EXPIRATION_SECONDS));
  assertEquals(headers["authorization"], "bearer jwt-value");
  assertEquals(headers["content-type"], "application/json");
});

Deno.test("buildHeaders switches to a background push for delete", () => {
  const headers = buildHeaders({ delete: "1" }, "ios", 1_762_732_800);
  assertEquals(headers["apns-push-type"], "background");
  assertEquals(headers["apns-priority"], "5");
});

Deno.test("buildHeaders collapses on a valid id and drops an invalid one", () => {
  const collapsed = buildHeaders({ id: "notification-1" }, "ios", 0);
  assertEquals(collapsed["apns-collapse-id"], "notification-1");

  const tooLong = buildHeaders({ id: "a".repeat(65) }, "ios", 0);
  assertEquals(tooLong["apns-collapse-id"], undefined);

  const notPrintable = buildHeaders({ id: "hello\u0000world" }, "ios", 0);
  assertEquals(notPrintable["apns-collapse-id"], undefined);
});

Deno.test("buildHeaders honours overridden topics", () => {
  const headers = buildHeaders({}, "watchos", 0, {
    topics: { ios: "com.example.phone", watchos: "com.example.watch" },
  });
  assertEquals(headers["apns-topic"], "com.example.watch");
});

Deno.test("shouldRetry stops at attempt 3 and never retries terminal outcomes", () => {
  assert(shouldRetry("transient", 1));
  assert(shouldRetry("transient", 2));
  assertEquals(shouldRetry("transient", MAX_ATTEMPTS), false);

  assertEquals(shouldRetry("delivered", 1), false);
  assertEquals(shouldRetry("permanent", 1), false);
  assertEquals(shouldRetry("credential", 1), false);
  assertEquals(shouldRetry("suppressed", 1), false);
});

Deno.test("classify/send drive a stubbed transport without any network", async () => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const stub =
    (status: number, body: unknown = {}) => (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(input),
        headers: init?.headers as Record<string, string>,
      });
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json", "apns-id": "apns-123" },
        }),
      );
    };

  const base: SendOptions = {
    deviceToken: TEST_DEVICE_TOKEN,
    deviceKind: "ios",
    payload: { aps: { alert: { body: "hi" } } },
    params: { body: "hi" },
    token: "token-1",
    env: "sandbox",
    now: 1_762_732_800,
    fetchImpl: stub(200),
  };

  const delivered = await send(base);
  assertEquals(delivered.classification, "delivered");
  assertEquals(delivered.status, 200);
  assertEquals(delivered.apnsId, "apns-123");
  assertEquals(
    calls[0].url,
    `https://api.sandbox.push.apple.com/3/device/${TEST_DEVICE_TOKEN}`,
  );
  assertEquals(calls[0].headers["apns-topic"], "me.fin.bark");

  const invalid = await send({ ...base, fetchImpl: stub(400, { reason: "BadDeviceToken" }) });
  assertEquals(invalid.classification, "permanent");
  assertEquals(invalid.reason, "BadDeviceToken");
});

Deno.test("send re-signs once after ExpiredProviderToken and retries", async () => {
  let signed = 0;
  const statuses = [403, 200];
  const fetchImpl = () => {
    const status = statuses.shift() as number;
    return Promise.resolve(
      new Response(JSON.stringify(status === 403 ? { reason: "ExpiredProviderToken" } : {}), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  };

  const result = await send({
    deviceToken: TEST_DEVICE_TOKEN,
    deviceKind: "ios",
    payload: { aps: {} },
    params: {},
    token: "stale-token",
    fetchImpl,
    now: 0,
    resignToken: () => {
      signed += 1;
      return Promise.resolve("fresh-token");
    },
  });

  assertEquals(signed, 1);
  assertEquals(result.attempts, 2);
  assertEquals(result.classification, "delivered");
});

Deno.test("send classifies a timeout as transient", async () => {
  const fetchImpl = () => {
    const error = new Error("aborted");
    error.name = "AbortError";
    return Promise.reject(error);
  };

  const result = await send({
    deviceToken: TEST_DEVICE_TOKEN,
    deviceKind: "ios",
    payload: { aps: {} },
    params: {},
    token: "token",
    fetchImpl,
    now: 0,
    timeoutMs: 5,
  });

  assertEquals(result.status, 0);
  assertEquals(result.reason, "timeout");
  assertEquals(result.classification, "transient");
  assertEquals(result.timedOut, true);
});

Deno.test("retryDelaySeconds gives a minute for throttling and a quarter hour for 5xx", () => {
  assertEquals(retryDelaySeconds(429), 60);
  assertEquals(retryDelaySeconds(0), 60);
  assertEquals(retryDelaySeconds(500), 900);
  assertEquals(retryDelaySeconds(503), 900);
});
