import { assertEquals, assertThrows } from "./asserts.ts";
import { expandDeviceKeys, isBatchPush, normalize } from "../_shared/params.ts";
import {
  BATCH_KEY_LIST,
  BATCH_KEY_STRING,
  TEST_DEVICE_KEY,
  TEST_DEVICE_KEY_2,
} from "./fixtures.ts";

Deno.test("device_keys accepts an array", () => {
  const params = normalize({ body: { device_keys: BATCH_KEY_LIST, body: "hi" } });
  assertEquals(expandDeviceKeys(params), BATCH_KEY_LIST);
  assertEquals(isBatchPush(params), true);
});

Deno.test("device_keys accepts a comma-separated string", () => {
  const params = normalize({ body: { device_keys: BATCH_KEY_STRING, body: "hi" } });
  assertEquals(expandDeviceKeys(params), BATCH_KEY_LIST);
});

Deno.test("device_keys accepts a mixed array of values and comma strings", () => {
  const params = normalize({
    body: {
      device_keys: [`${TEST_DEVICE_KEY},${TEST_DEVICE_KEY_2}`, "ThirdKey123"],
    },
  });
  assertEquals(expandDeviceKeys(params), [TEST_DEVICE_KEY, TEST_DEVICE_KEY_2, "ThirdKey123"]);
});

Deno.test("device_keys trims whitespace around each key", () => {
  const params = normalize({
    body: { device_keys: ` ${TEST_DEVICE_KEY} , ${TEST_DEVICE_KEY_2} ` },
  });
  assertEquals(expandDeviceKeys(params), BATCH_KEY_LIST);
});

Deno.test("a single device_key is a list of one", () => {
  const params = normalize({ body: { device_key: TEST_DEVICE_KEY } });
  assertEquals(expandDeviceKeys(params), [TEST_DEVICE_KEY]);
  assertEquals(isBatchPush(params), false);
});

Deno.test("100 keys are accepted", () => {
  const keys = Array.from({ length: 100 }, (_, index) => `Key${String(index).padStart(5, "0")}`);
  const params = normalize({ body: { device_keys: keys } });
  assertEquals(expandDeviceKeys(params).length, 100);
});

Deno.test("101 keys are rejected with the documented message", () => {
  const keys = Array.from({ length: 101 }, (_, index) => `Key${String(index).padStart(5, "0")}`);
  const params = normalize({ body: { device_keys: keys } });
  assertThrows(
    () => expandDeviceKeys(params),
    /batch push count exceeds the maximum limit: 100/,
  );
});

Deno.test("duplicate keys are preserved in order", () => {
  const params = normalize({
    body: { device_keys: [TEST_DEVICE_KEY, TEST_DEVICE_KEY_2, TEST_DEVICE_KEY] },
  });
  assertEquals(expandDeviceKeys(params), [
    TEST_DEVICE_KEY,
    TEST_DEVICE_KEY_2,
    TEST_DEVICE_KEY,
  ]);
});

Deno.test("empty entries are dropped, not delivered", () => {
  const params = normalize({ body: { device_keys: `${TEST_DEVICE_KEY},,${TEST_DEVICE_KEY_2},` } });
  assertEquals(expandDeviceKeys(params), BATCH_KEY_LIST);
});
