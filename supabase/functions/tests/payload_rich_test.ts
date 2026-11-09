import { assertEquals } from "./asserts.ts";
import { buildHeaders } from "../_shared/apns.ts";
import { buildPayload } from "../_shared/payload.ts";
import { normalize, parseFormEncoded, validate } from "../_shared/params.ts";
import { RICH_PUSH_PARAMS, TEST_DEVICE_KEY } from "./fixtures.ts";

function payloadFor(values: Record<string, unknown>) {
  const { params } = validate(normalize({ body: values }));
  return buildPayload(params);
}

Deno.test("level maps to aps.interruption-level", () => {
  for (const level of ["passive", "timeSensitive", "critical"]) {
    const payload = payloadFor({ body: "b", level });
    assertEquals(payload.aps["interruption-level"], level, level);
  }
});

Deno.test("the default level is omitted from the payload", () => {
  assertEquals(payloadFor({ body: "b" }).aps["interruption-level"], undefined);
  assertEquals(payloadFor({ body: "b", level: "active" }).aps["interruption-level"], undefined);
});

Deno.test("volume produces the critical sound object", () => {
  const payload = payloadFor({ body: "b", sound: "alarm", volume: "0.5" });
  assertEquals(payload.aps.sound, { critical: 1, name: "alarm.caf", volume: 0.5 });
});

Deno.test("volume without a sound name uses the default sound", () => {
  const payload = payloadFor({ body: "b", volume: 1 });
  assertEquals(payload.aps.sound, { critical: 1, name: "default", volume: 1 });
});

Deno.test("group maps to aps.thread-id", () => {
  assertEquals(payloadFor({ body: "b", group: "ops" }).aps["thread-id"], "ops");
});

Deno.test("badge maps to an integer aps.badge", () => {
  assertEquals(payloadFor({ body: "b", badge: "3" }).aps.badge, 3);
  assertEquals(typeof payloadFor({ body: "b", badge: "3" }).aps.badge, "number");
});

Deno.test("sound naming keeps an explicit extension", () => {
  assertEquals(payloadFor({ body: "b", sound: "minuet.caf" }).aps.sound, "minuet.caf");
  assertEquals(payloadFor({ body: "b", sound: "minuet" }).aps.sound, "minuet.caf");
});

Deno.test("delete produces a background push with content-available", () => {
  const params = normalize({ body: { device_key: TEST_DEVICE_KEY, delete: "1" } });
  const payload = buildPayload(params);
  assertEquals(payload.aps, { "content-available": 1 });

  const headers = buildHeaders(params, "ios", 1_762_732_800);
  assertEquals(headers["apns-push-type"], "background");
  assertEquals(headers["apns-priority"], "5");
});

Deno.test("delete also clears the alert push type for a normal push", () => {
  const headers = buildHeaders({ body: "b" }, "ios", 1_762_732_800);
  assertEquals(headers["apns-push-type"], "alert");
  assertEquals(headers["apns-priority"], "10");
});

Deno.test("unknown parameters are forwarded lower-cased and stringified", () => {
  const payload = payloadFor({
    body: "b",
    markdown: "# heading",
    image: "https://example.test/i.png",
    mute: 1,
  });

  assertEquals(payload["markdown"], "# heading");
  assertEquals(payload["image"], "https://example.test/i.png");
  assertEquals(payload["mute"], "1");
});

Deno.test("the rich parameter set maps every documented field", () => {
  const payload = payloadFor(RICH_PUSH_PARAMS as unknown as Record<string, unknown>);

  assertEquals(payload.aps.alert, {
    title: "Rich",
    subtitle: "sub",
    body: "Body",
  });
  assertEquals(payload.aps["interruption-level"], "timeSensitive");
  assertEquals(payload.aps.sound, { critical: 1, name: "alarm.caf", volume: 0.5 });
  assertEquals(payload.aps.badge, 3);
  assertEquals(payload.aps["thread-id"], "ops");
  assertEquals(payload["icon"], "https://example.test/icon.png");
  assertEquals(payload["url"], "https://bark.day.app");
  assertEquals(payload["action"], "none");
  assertEquals(payload["autocopy"], "1");
  assertEquals(payload["copy"], "copied");
  assertEquals(payload["call"], "1");
  assertEquals(payload["ttl"], "120");
});

Deno.test("a form body maps the same way as JSON", () => {
  const fromForm = normalize({
    body: parseFormEncoded("body=b&group=g&sound=minuet&badge=2"),
  });
  const payload = buildPayload(validate(fromForm).params);
  assertEquals(payload.aps["thread-id"], "g");
  assertEquals(payload.aps.sound, "minuet.caf");
  assertEquals(payload.aps.badge, 2);
});
