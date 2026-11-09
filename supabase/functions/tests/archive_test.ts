import { assertEquals } from "./asserts.ts";
import {
  archiveDecision,
  archivedPayload,
  clampTtl,
  DEFAULT_TTL_SECONDS,
  MAX_TTL_SECONDS,
  MIN_TTL_SECONDS,
} from "../_shared/archive.ts";
import { buildAlertPayload } from "../_shared/payload.ts";
import { normalize } from "../_shared/params.ts";
import { TEST_DEVICE_KEY } from "./fixtures.ts";

Deno.test("isArchive=1 requests an archive with the default lifetime", () => {
  const decision = archiveDecision(normalize({ body: { isArchive: "1", body: "b" } }));
  assertEquals(decision, { archive: true, ttlSeconds: DEFAULT_TTL_SECONDS });
});

Deno.test("a ttl alone requests an archive", () => {
  const decision = archiveDecision({ ttl: 120 });
  assertEquals(decision, { archive: true, ttlSeconds: 120 });
});

Deno.test("neither isArchive nor ttl archives nothing", () => {
  const decision = archiveDecision(normalize({ body: { body: "b" } }));
  assertEquals(decision, { archive: false, ttlSeconds: DEFAULT_TTL_SECONDS });
});

Deno.test("ttl is clamped to 60 – 2592000 seconds", () => {
  assertEquals(clampTtl(1), MIN_TTL_SECONDS);
  assertEquals(clampTtl(0), MIN_TTL_SECONDS);
  assertEquals(clampTtl(60), 60);
  assertEquals(clampTtl(MAX_TTL_SECONDS), MAX_TTL_SECONDS);
  assertEquals(clampTtl(MAX_TTL_SECONDS + 1), MAX_TTL_SECONDS);
  assertEquals(clampTtl(undefined), DEFAULT_TTL_SECONDS);

  assertEquals(archiveDecision({ isArchive: "1", ttl: 5 }).ttlSeconds, MIN_TTL_SECONDS);
  assertEquals(archiveDecision({ isArchive: "1", ttl: 9_999_999 }).ttlSeconds, MAX_TTL_SECONDS);
});

Deno.test("a ciphertext-only payload keeps the ciphertext byte-identical", () => {
  const ciphertext = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
  const params = normalize({
    body: { device_key: TEST_DEVICE_KEY, isArchive: "1", ciphertext },
  });

  const archived = archivedPayload(params);
  assertEquals(archived["ciphertext"], ciphertext);
  assertEquals(JSON.stringify(archived["ciphertext"]), JSON.stringify(ciphertext));

  const payload = buildAlertPayload(params);
  assertEquals(payload["ciphertext"], ciphertext);
  assertEquals(
    (payload.aps.alert as Record<string, string>).body,
    "Empty Message",
    "an encrypted push keeps a placeholder body the app replaces",
  );
});
