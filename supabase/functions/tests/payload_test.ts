import { assertEquals, assertThrows } from "./asserts.ts";
import {
  assertPayloadSize,
  buildAlertPayload,
  buildPayload,
  DEFAULT_CATEGORY,
  EMPTY_MESSAGE,
  MAX_PAYLOAD_BYTES,
  payloadBytes,
  soundName,
} from "../_shared/payload.ts";
import { TEST_DEVICE_KEY } from "./fixtures.ts";

Deno.test("buildAlertPayload maps the alert block, category and mutable content", () => {
  const payload = buildAlertPayload({
    device_key: TEST_DEVICE_KEY,
    title: "Hello",
    subtitle: "Sub",
    body: "World",
  });

  assertEquals(payload.aps, {
    "mutable-content": 1,
    alert: { title: "Hello", subtitle: "Sub", body: "World" },
  });
  assertEquals(payload.category, DEFAULT_CATEGORY);
  assertEquals(payload["device_key"], undefined, "routing fields never reach APNs");
});

Deno.test("an empty subtitle is omitted and a title-only push stays valid", () => {
  const payload = buildAlertPayload({ title: "Title only", subtitle: "" });
  assertEquals(payload.aps.alert, { title: "Title only" });
});

Deno.test("sound gets a .caf suffix unless it already has an extension", () => {
  assertEquals(soundName("minuet"), "minuet.caf");
  assertEquals(soundName("minuet.caf"), "minuet.caf");
  assertEquals(soundName("ring.wav"), "ring.wav");
  assertEquals(buildAlertPayload({ body: "b", sound: "minuet" }).aps.sound, "minuet.caf");
});

Deno.test("a ciphertext-only payload keeps the ciphertext and adds a body placeholder", () => {
  const ciphertext = "T8g2hQ==";
  const payload = buildAlertPayload({ ciphertext });

  assertEquals(payload["ciphertext"], ciphertext);
  assertEquals((payload.aps.alert as Record<string, string>).body, EMPTY_MESSAGE);
});

Deno.test("an oversized payload is rejected before any network call", () => {
  const payload = buildAlertPayload({ body: "a".repeat(MAX_PAYLOAD_BYTES) });
  assertThrows(() => assertPayloadSize(payload), /payload too large/);
  assertEquals(payloadBytes(buildAlertPayload({ body: "ok" })) < MAX_PAYLOAD_BYTES, true);
});

Deno.test("custom parameters are lower-cased and stringified", () => {
  const payload = buildAlertPayload({
    body: "b",
    url: "https://bark.day.app",
    autoCopy: "1",
    image: "https://example.test/image.png",
  });

  assertEquals(payload["url"], "https://bark.day.app");
  assertEquals(payload["autocopy"], "1");
  assertEquals(payload["image"], "https://example.test/image.png");
});

Deno.test("delete builds a silent background payload with no alert block", () => {
  const payload = buildPayload({ device_key: TEST_DEVICE_KEY, delete: "1", body: "" });
  assertEquals(payload.aps, { "content-available": 1 });
  assertEquals(payload.aps.alert, undefined);
});
