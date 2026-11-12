import { assertEquals } from "./asserts.ts";
import { matchFilters } from "../_shared/store.ts";

Deno.test("matchFilters maps null to is.null and every other value to eq", () => {
  assertEquals(matchFilters({ disabled_at: null, device_kind: "ios" }), [
    { op: "is", column: "disabled_at", value: null },
    { op: "eq", column: "device_kind", value: "ios" },
  ]);
});
