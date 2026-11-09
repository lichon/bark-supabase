import { assertEquals } from "./asserts.ts";
import { buildRouteTable } from "../_shared/routes/table.ts";
import {
  matchRoute,
  methodNotAllowedResponse,
  notFoundResponse,
  splitPath,
  stripPrefix,
} from "../_shared/router.ts";
import { TEST_DEVICE_KEY } from "./fixtures.ts";

const ROUTES = buildRouteTable();

// The Supabase edge runtime hands the function a path with `/functions/v1`
// already stripped, so the default mount is `/<slug>`.
Deno.test("stripPrefix removes the /<slug> prefix the runtime delivers", () => {
  assertEquals(stripPrefix("/bark/ping", "bark"), "/ping");
  assertEquals(stripPrefix("/bark", "bark"), "/");
  assertEquals(stripPrefix("/bark/", "bark"), "/");
  assertEquals(
    stripPrefix(`/bark/${TEST_DEVICE_KEY}/hello`, "bark"),
    `/${TEST_DEVICE_KEY}/hello`,
  );
});

Deno.test("stripPrefix can strip an explicit /functions/v1 mount", () => {
  assertEquals(stripPrefix("/functions/v1/bark/ping", "bark", "/functions/v1"), "/ping");
  assertEquals(stripPrefix("/functions/v1/bark", "bark", "/functions/v1"), "/");
});

Deno.test("stripPrefix rejects a different or missing prefix", () => {
  assertEquals(stripPrefix("/functions/v1/other/ping", "bark"), null);
  assertEquals(stripPrefix("/ping", "bark"), null);
  assertEquals(stripPrefix("/functions/v1/barkish/ping", "bark"), null);
});

Deno.test("splitPath drops empty segments", () => {
  assertEquals(splitPath("/a//b/"), ["a", "b"]);
  assertEquals(splitPath("/"), []);
});

Deno.test("static routes resolve", () => {
  assertEquals(matchRoute(ROUTES, "GET", "/ping").route?.name, "ping");
  assertEquals(matchRoute(ROUTES, "GET", "/healthz").route?.name, "healthz");
  assertEquals(matchRoute(ROUTES, "GET", "/info").route?.name, "info");
  assertEquals(matchRoute(ROUTES, "GET", "/").route?.name, "root");
  assertEquals(matchRoute(ROUTES, "POST", "/register").route?.name, "register");
});

Deno.test("registration check wins over the catch-all key route", () => {
  const result = matchRoute(ROUTES, "GET", `/register/${TEST_DEVICE_KEY}`);
  assertEquals(result.kind, "route");
  assertEquals(result.route?.name, "register_check");
  assertEquals(result.params["device_key"], TEST_DEVICE_KEY);
});

Deno.test("the four v1 path variants map to key/title/subtitle/body", () => {
  const keyOnly = matchRoute(ROUTES, "GET", `/${TEST_DEVICE_KEY}`);
  assertEquals(keyOnly.route?.name, "push_v1_key");
  assertEquals(keyOnly.params, { device_key: TEST_DEVICE_KEY });

  const body = matchRoute(ROUTES, "GET", `/${TEST_DEVICE_KEY}/the-body`);
  assertEquals(body.route?.name, "push_v1_body");
  assertEquals(body.params, { device_key: TEST_DEVICE_KEY, body: "the-body" });

  const titleBody = matchRoute(ROUTES, "POST", `/${TEST_DEVICE_KEY}/title/the-body`);
  assertEquals(titleBody.route?.name, "push_v1_title_body");
  assertEquals(titleBody.params, {
    device_key: TEST_DEVICE_KEY,
    title: "title",
    body: "the-body",
  });

  const full = matchRoute(ROUTES, "GET", `/${TEST_DEVICE_KEY}/title/sub/the-body`);
  assertEquals(full.route?.name, "push_v1_title_subtitle_body");
  assertEquals(full.params, {
    device_key: TEST_DEVICE_KEY,
    title: "title",
    subtitle: "sub",
    body: "the-body",
  });
});

Deno.test("an unknown path is not_found", () => {
  const result = matchRoute(ROUTES, "GET", "/nope/deeper/path/still/more");
  assertEquals(result.kind, "not_found");
  assertEquals(result.allow, []);
});

Deno.test("a wrong method on a matched path reports the allowed methods", async () => {
  const result = matchRoute(ROUTES, "DELETE", "/push");
  assertEquals(result.kind, "method_not_allowed");
  assertEquals(result.allow, ["POST"]);

  const response = methodNotAllowedResponse(result.allow);
  assertEquals(response.status, 405);
  assertEquals(response.headers.get("allow"), "POST");
  const body = await response.json();
  assertEquals(body.code, 405);
});

Deno.test("notFoundResponse returns the 404 envelope", async () => {
  const response = notFoundResponse();
  assertEquals(response.status, 404);
  const body = await response.json();
  assertEquals(body.code, 404);
  assertEquals(typeof body.timestamp, "number");
});
