import { assertEquals, assertThrows } from "./asserts.ts";
import { normalizeLevel, validate } from "../_shared/params.ts";
import { type ApnsPayload, assertPayloadSize, buildAlertPayload } from "../_shared/payload.ts";

Deno.test("an unknown level falls back to active with a warning", () => {
  const { params, warnings } = validate({ body: "b", level: "urgent" });
  assertEquals(params["level"], "active");
  assertEquals(warnings.length, 1);
  assertEquals(warnings[0].includes("urgent"), true);
});

Deno.test("a known level is preserved and produces no warning", () => {
  const { params, warnings } = validate({ body: "b", level: "timeSensitive" });
  assertEquals(params["level"], "timeSensitive");
  assertEquals(warnings, []);
});

Deno.test("level matching is case-insensitive", () => {
  assertEquals(normalizeLevel("CRITICAL").level, "critical");
  assertEquals(normalizeLevel("").level, "active");
});

Deno.test("badge is bounded to 0 – 999999", () => {
  assertEquals(validate({ badge: "0" }).params["badge"], 0);
  assertEquals(validate({ badge: "999999" }).params["badge"], 999999);

  assertThrows(() => validate({ badge: "-1" }), /badge must be at least 0/);
  assertThrows(() => validate({ badge: "1000000" }), /badge must be at most 999999/);
  assertThrows(() => validate({ badge: "3.5" }), /badge must be an integer/);
});

Deno.test("volume is bounded to 0.0 – 1.0", () => {
  assertEquals(validate({ volume: "0" }).params["volume"], 0);
  assertEquals(validate({ volume: "1" }).params["volume"], 1);
  assertEquals(validate({ volume: "0.35" }).params["volume"], 0.35);

  assertThrows(() => validate({ volume: "-0.1" }), /volume must be between 0 and 1/);
  assertThrows(() => validate({ volume: "1.01" }), /volume must be between 0 and 1/);
  assertThrows(() => validate({ volume: "loud" }), /volume must be a number/);
});

Deno.test("ttl must be a non-negative integer", () => {
  assertEquals(validate({ ttl: "60" }).params["ttl"], 60);
  assertThrows(() => validate({ ttl: "-1" }), /ttl must be at least 0/);
  assertThrows(() => validate({ ttl: "abc" }), /ttl must be an integer/);
});

Deno.test("an oversized payload is rejected before any transport call", () => {
  const transport = { calls: 0 };
  const attemptSend = (payload: ApnsPayload) => {
    assertPayloadSize(payload);
    transport.calls += 1;
  };

  assertThrows(
    () => attemptSend(buildAlertPayload({ body: "a".repeat(6000) })),
    /payload too large/,
  );
  assertEquals(transport.calls, 0, "the transport must not be reached");

  // Sanity: the same guard passes for a normal payload.
  attemptSend(buildAlertPayload({ body: "short" }));
  assertEquals(transport.calls, 1);
});
