/**
 * The delivery pipeline, exercised through `createStore` over a fake database
 * client so the assertions are about the rows that would land in
 * `bark.delivery` / `bark.archive`, not about the internals of the pipeline.
 *
 * The invariants under test:
 *  - content is written on creation and dropped once the row is terminal
 *  - a suppressed (disabled/invalidated) device is never pushed to
 *  - `archived` mirrors the sender's retention request, and the retained copy is
 *    the `archive` row — a terminal delivery row keeps none
 */

import { assert, assertEquals } from "./asserts.ts";
import { parseConfig } from "../_shared/config.ts";
import { handlePush, type PushDeps, type SendNotification } from "../_shared/routes/push.ts";
import { createStore, type DatabaseClient } from "../_shared/store.ts";
import type { DeviceRecord } from "../_shared/types.ts";
import { PATH_PUSH_PARAMS, TEST_DEVICE_KEY, TEST_DEVICE_TOKEN, validEnv } from "./fixtures.ts";

const REQUEST_ID = "019a5d8c-838a-73ca-bb89-72b36f3f653d";
const NOW = new Date("2026-01-01T00:00:00.000Z");

type Row = Record<string, unknown>;

interface Harness {
  deps: PushDeps;
  deliveries: Row[];
  archives: Row[];
  updates: { match: Row; patch: Row }[];
  sends: number;
}

function device(overrides: Partial<DeviceRecord> = {}): DeviceRecord {
  return {
    device_key: TEST_DEVICE_KEY,
    device_token: TEST_DEVICE_TOKEN,
    device_kind: "ios",
    disabled_at: null,
    invalidated_at: null,
    last_error: null,
    created_at: "2025-01-01T00:00:00.000Z",
    updated_at: "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function harness(
  target: DeviceRecord | null,
  send: SendNotification = () => Promise.reject(new Error("sendNotification must not be called")),
): Harness {
  const deliveries: Row[] = [];
  const archives: Row[] = [];
  const updates: { match: Row; patch: Row }[] = [];
  const state = { sends: 0 };

  const client: DatabaseClient = {
    rpc: <T>(name: string) => {
      if (name === "bark_lookup_device") return Promise.resolve({ data: target as T, error: null });
      return Promise.resolve({ data: null, error: null });
    },
    insert: <T>(table: string, row: Row) => {
      if (table === "archive") archives.push(row);
      else deliveries.push(row);
      return Promise.resolve({
        data: { id: `row-${deliveries.length}`, ...row } as T,
        error: null,
      });
    },
    update: <T>(table: string, match: Row, patch: Row) => {
      assert(table === "delivery", `unexpected update on ${table}`);
      updates.push({ match, patch });
      return Promise.resolve({ data: null, error: null });
    },
  };

  const deps: PushDeps = {
    store: createStore(client),
    config: parseConfig(validEnv()),
    requestId: REQUEST_ID,
    now: () => NOW,
    log: () => {},
    sendNotification: async (input) => {
      state.sends += 1;
      return await send(input);
    },
  };

  return {
    deps,
    deliveries,
    archives,
    updates,
    get sends() {
      return state.sends;
    },
  };
}

function delivered() {
  return {
    status: 200,
    classification: "delivered" as const,
    apnsId: "apns-1",
    latencyMs: 12,
    attempts: 1,
    timedOut: false,
  };
}

function transient() {
  return {
    status: 503,
    reason: "ServiceUnavailable",
    classification: "transient" as const,
    latencyMs: 12,
    attempts: 1,
    timedOut: false,
  };
}

Deno.test("a suppressed device is never pushed to and its row keeps no content", async () => {
  const h = harness(device({ disabled_at: "2025-06-01T00:00:00.000Z" }));
  const response = await handlePush(h.deps, PATH_PUSH_PARAMS, "v1_path");

  assertEquals(response.status, 400);
  assertEquals(
    await response.json().then((body) => (body as Row)["message"]),
    "device is disabled",
  );
  assertEquals(h.sends, 0);

  assertEquals(h.deliveries.length, 1);
  assertEquals(h.deliveries[0]["status"], "suppressed");
  assertEquals(h.deliveries[0]["payload"], null);
  assertEquals(h.deliveries[0]["archived"], false);
  assertEquals(h.deliveries[0]["request_id"], REQUEST_ID);
});

Deno.test("a suppressed device asked for an archive records the flag and the copy", async () => {
  const h = harness(device({ invalidated_at: "2025-06-01T00:00:00.000Z" }));
  const response = await handlePush(
    h.deps,
    { ...PATH_PUSH_PARAMS, isArchive: "1" },
    "v2_json",
  );

  assertEquals(response.status, 400);
  assertEquals(h.sends, 0);

  assertEquals(h.deliveries[0]["status"], "suppressed");
  assertEquals(h.deliveries[0]["archived"], true);
  assertEquals(h.deliveries[0]["payload"], null, "content belongs to the archive row only");

  assertEquals(h.archives.length, 1);
  assertEquals(h.archives[0]["delivery_id"], "row-1");
  assertEquals(h.archives[0]["payload"], { ...PATH_PUSH_PARAMS, isArchive: "1" });
  assertEquals(h.archives[0]["expires_at"], "2026-01-02T00:00:00.000Z");
});

Deno.test("ttl alone requests retention and is clamped to the one-minute floor", async () => {
  const h = harness(device({ disabled_at: "2025-06-01T00:00:00.000Z" }));
  await handlePush(h.deps, { ...PATH_PUSH_PARAMS, ttl: "0" }, "v1_form");

  assertEquals(h.deliveries[0]["archived"], true);
  assertEquals(h.archives[0]["expires_at"], "2026-01-01T00:01:00.000Z");
});

Deno.test("a delivered push clears the payload it wrote on creation", async () => {
  const h = harness(device(), () => Promise.resolve(delivered()));
  const response = await handlePush(h.deps, PATH_PUSH_PARAMS, "v1_path");

  assertEquals(response.status, 200);
  assertEquals(h.deliveries[0]["status"], "pending");
  assertEquals(h.deliveries[0]["payload"], PATH_PUSH_PARAMS, "written before the send");

  assertEquals(h.updates.length, 1);
  assertEquals(h.updates[0]["patch"]["status"], "delivered");
  assertEquals(h.updates[0]["patch"]["payload"], null);
  assertEquals(h.updates[0]["patch"]["archived"], false);
  assertEquals(h.updates[0]["patch"]["apns_id"], "apns-1");
  assertEquals(h.updates[0]["patch"]["next_attempt_at"], null);
  assertEquals(h.archives.length, 0);
});

Deno.test("a transient failure keeps the payload and schedules the retry", async () => {
  const h = harness(device(), () => Promise.resolve(transient()));
  const response = await handlePush(h.deps, PATH_PUSH_PARAMS, "v1_path");

  assertEquals(response.status, 503);
  assertEquals(h.updates[0]["patch"]["status"], "pending");
  assertEquals(h.updates[0]["patch"]["payload"], PATH_PUSH_PARAMS);
  assertEquals(h.updates[0]["patch"]["next_attempt_at"], "2026-01-01T00:15:00.000Z");
});

Deno.test("an archived push keeps the flag and the archive row on a terminal outcome", async () => {
  const h = harness(device(), () => Promise.resolve(delivered()));
  await handlePush(h.deps, { ...PATH_PUSH_PARAMS, isArchive: "1", ttl: "3600" }, "v1_path");

  assertEquals(h.updates[0]["patch"]["archived"], true);
  assertEquals(h.updates[0]["patch"]["payload"], null);
  assertEquals(h.archives[0]["expires_at"], "2026-01-01T01:00:00.000Z");
});

Deno.test("a batch shares one request id across every device row", async () => {
  const h = harness(device(), () => Promise.resolve(delivered()));
  const response = await handlePush(
    h.deps,
    { ...PATH_PUSH_PARAMS, device_keys: `${TEST_DEVICE_KEY},${TEST_DEVICE_KEY}` },
    "v2_json",
  );

  assertEquals(response.status, 200);
  assertEquals(h.deliveries.length, 2);
  assertEquals(h.deliveries[0]["request_id"], REQUEST_ID);
  assertEquals(h.deliveries[1]["request_id"], REQUEST_ID);
  assertEquals(h.deliveries[0]["origin"], "v2_batch");
});
