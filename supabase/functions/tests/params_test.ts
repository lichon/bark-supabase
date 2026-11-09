import { assertEquals, assertThrows } from "./asserts.ts";
import {
  boolParam,
  intParam,
  normalize,
  parseFormEncoded,
  requireDeviceKey,
  stringParam,
} from "../_shared/params.ts";
import { TEST_DEVICE_KEY } from "./fixtures.ts";

Deno.test("normalize applies path > body > query precedence", () => {
  const params = normalize({
    path: { body: "from-path" },
    body: { body: "from-body", title: "body-title" },
    query: { title: "query-title", subtitle: "query-subtitle" },
  });

  assertEquals(params["body"], "from-path");
  assertEquals(params["title"], "body-title");
  assertEquals(params["subtitle"], "query-subtitle");
});

Deno.test("normalize URL-decodes path segments exactly once", () => {
  assertEquals(normalize({ path: { body: "hello%20world" } })["body"], "hello world");
  assertEquals(normalize({ path: { body: "%E4%BD%A0%E5%A5%BD" } })["body"], "你好");
  // A pre-encoded percent must not be decoded twice.
  assertEquals(normalize({ path: { body: "100%2525" } })["body"], "100%25");
});

Deno.test("normalize keeps + literal in paths and a space in forms", () => {
  assertEquals(normalize({ path: { body: "a+b" } })["body"], "a+b");
  const form = parseFormEncoded("body=a+b&title=t");
  assertEquals(form["body"], "a b");
  assertEquals(normalize({ body: form })["body"], "a b");
});

Deno.test("normalize decodes UTF-8 from a form body", () => {
  const form = parseFormEncoded("body=%E4%BD%A0%E5%A5%BD+world");
  assertEquals(form["body"], "你好 world");
});

Deno.test("the path shape matches the JSON shape for the same notification", () => {
  const fromPath = normalize({
    path: { device_key: TEST_DEVICE_KEY, title: "Title", body: "Body" },
  });
  const fromJson = normalize({
    body: { device_key: TEST_DEVICE_KEY, title: "Title", body: "Body" },
  });
  assertEquals(fromPath, fromJson);
});

Deno.test("requireDeviceKey rejects a missing or empty key", () => {
  assertThrows(() => requireDeviceKey({}), /device key is empty/);
  assertThrows(() => requireDeviceKey({ device_key: "   " }), /device key is empty/);
  assertEquals(requireDeviceKey({ device_key: ` ${TEST_DEVICE_KEY} ` }), TEST_DEVICE_KEY);
});

Deno.test("typed accessors coerce and bound values", () => {
  const params = { badge: "3", volume: "0.5", delete: "1", title: "hello" };

  assertEquals(intParam(params, "badge"), 3);
  assertEquals(stringParam(params, "title"), "hello");
  assertEquals(boolParam(params, "delete"), true);
  assertEquals(boolParam(params, "isArchive"), false);
  assertEquals(intParam({}, "badge"), undefined);

  assertThrows(() => intParam({ badge: "1.5" }, "badge"), /must be an integer/);
  assertThrows(() => intParam({ badge: "10" }, "badge", { max: 5 }), /at most 5/);
});

Deno.test("non-string body values are stringified consistently", () => {
  assertEquals(stringParam({ badge: 3 }, "badge"), "3");
  assertEquals(stringParam({ autoCopy: true }, "autoCopy"), "true");
});
