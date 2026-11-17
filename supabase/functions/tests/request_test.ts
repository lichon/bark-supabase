import { assertEquals } from "./asserts.ts";
import { requestIdFrom } from "../_shared/request.ts";

const GATEWAY_ID = "019a5d8c-838a-73ca-bb89-72b36f3f653d";
const CALLER_ID = "11111111-2222-4333-8444-555555555555";
const EXECUTION_ID = "aa00cfc9-14a2-4f3e-a2bf-3d22435220b8";

function headers(entries: Record<string, string>): Headers {
  return new Headers(entries);
}

Deno.test("requestIdFrom reuses the Supabase gateway request id", () => {
  assertEquals(requestIdFrom(headers({ "sb-request-id": GATEWAY_ID })), GATEWAY_ID);
});

Deno.test("requestIdFrom prefers the gateway id over caller and runtime ids", () => {
  const result = requestIdFrom(headers({
    "sb-request-id": GATEWAY_ID,
    "x-request-id": CALLER_ID,
    "x-deno-execution-id": EXECUTION_ID,
  }));
  assertEquals(result, GATEWAY_ID);
});

Deno.test("requestIdFrom falls back to the caller id, then the execution id", () => {
  assertEquals(
    requestIdFrom(headers({ "x-request-id": CALLER_ID, "x-deno-execution-id": EXECUTION_ID })),
    CALLER_ID,
  );
  assertEquals(requestIdFrom(headers({ "x-deno-execution-id": EXECUTION_ID })), EXECUTION_ID);
});

Deno.test("requestIdFrom normalises case", () => {
  assertEquals(requestIdFrom(headers({ "sb-request-id": GATEWAY_ID.toUpperCase() })), GATEWAY_ID);
});

Deno.test("requestIdFrom ignores non-UUID ids and generates one", () => {
  const generated = requestIdFrom(
    headers({ "cf-ray": "99aba53fda5803f-MIA", "sb-request-id": "" }),
  );
  assertEquals(generated.length, 36);
  assertEquals(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(generated),
    true,
  );

  const blank = requestIdFrom(new Headers());
  assertEquals(blank.length, 36);
  assertEquals(blank === generated, false);
});
