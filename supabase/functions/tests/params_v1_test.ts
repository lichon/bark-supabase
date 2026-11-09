import { assertEquals } from "./asserts.ts";
import { formDataToObject, normalize, parseFormEncoded } from "../_shared/params.ts";
import { TEST_DEVICE_KEY } from "./fixtures.ts";

Deno.test("multipart form values normalise like a form-encoded body", () => {
  const form = new FormData();
  form.append("device_key", TEST_DEVICE_KEY);
  form.append("title", "From multipart");
  form.append("body", "Hello there");

  const fromMultipart = normalize({ body: formDataToObject(form) });
  const fromForm = normalize({ body: parseFormEncoded(`device_key=${TEST_DEVICE_KEY}`) });

  assertEquals(fromMultipart["device_key"], TEST_DEVICE_KEY);
  assertEquals(fromMultipart["title"], "From multipart");
  assertEquals(fromMultipart["body"], "Hello there");
  assertEquals(fromForm["device_key"], TEST_DEVICE_KEY);
});

Deno.test("legacy aliases map onto the canonical names", () => {
  const params = normalize({
    body: { key: TEST_DEVICE_KEY, devicetoken: "legacy-token" },
  });
  assertEquals(params["device_key"], TEST_DEVICE_KEY);
  assertEquals(params["device_token"], "legacy-token");
});

Deno.test("query-string aliases map too", () => {
  const params = normalize({
    query: parseFormEncoded(`key=${TEST_DEVICE_KEY}&devicetoken=abc123`),
  });
  assertEquals(params["device_key"], TEST_DEVICE_KEY);
  assertEquals(params["device_token"], "abc123");
});

Deno.test("each v1 path shape equals its JSON equivalent", () => {
  const cases: Array<{
    name: string;
    path?: Record<string, string>;
    json: Record<string, unknown>;
  }> = [
    {
      name: "key only",
      path: { device_key: TEST_DEVICE_KEY },
      json: { device_key: TEST_DEVICE_KEY },
    },
    {
      name: "key + body",
      path: { device_key: TEST_DEVICE_KEY, body: "the-body" },
      json: { device_key: TEST_DEVICE_KEY, body: "the-body" },
    },
    {
      name: "key + title + body",
      path: { device_key: TEST_DEVICE_KEY, title: "the-title", body: "the-body" },
      json: { device_key: TEST_DEVICE_KEY, title: "the-title", body: "the-body" },
    },
    {
      name: "key + title + subtitle + body",
      path: {
        device_key: TEST_DEVICE_KEY,
        title: "the-title",
        subtitle: "the-subtitle",
        body: "the-body",
      },
      json: {
        device_key: TEST_DEVICE_KEY,
        title: "the-title",
        subtitle: "the-subtitle",
        body: "the-body",
      },
    },
  ];

  for (const testCase of cases) {
    const fromPath = normalize({ path: testCase.path });
    const fromJson = normalize({ body: testCase.json });
    assertEquals(fromPath, fromJson, testCase.name);
  }
});

Deno.test("path values win over the same field in a form body", () => {
  const params = normalize({
    path: { device_key: TEST_DEVICE_KEY, body: "path-body" },
    body: { body: "form-body", title: "form-title" },
  });
  assertEquals(params["body"], "path-body");
  assertEquals(params["title"], "form-title");
});
