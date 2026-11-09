import { assert, assertEquals } from "./asserts.ts";
import type { Classification } from "../_shared/apns.ts";
import {
  MAX_ATTEMPTS,
  retryDelaySeconds,
  SERVER_ERROR_DELAY_SECONDS,
  shouldRetry,
  TRANSIENT_DELAY_SECONDS,
} from "../_shared/apns.ts";

Deno.test("a throttled request backs off one minute", () => {
  assertEquals(retryDelaySeconds(429), TRANSIENT_DELAY_SECONDS);
  assertEquals(retryDelaySeconds(429), 60);
});

Deno.test("a timeout backs off one minute", () => {
  assertEquals(retryDelaySeconds(0), 60);
});

Deno.test("a 5xx backs off fifteen minutes", () => {
  assertEquals(retryDelaySeconds(500), SERVER_ERROR_DELAY_SECONDS);
  assertEquals(retryDelaySeconds(503), 15 * 60);
});

Deno.test("attempt 3 is terminal", () => {
  assertEquals(MAX_ATTEMPTS, 3);
  assert(shouldRetry("transient", 1));
  assert(shouldRetry("transient", 2));
  assertEquals(shouldRetry("transient", 3), false);
});

Deno.test("attempt_count can never exceed the cap", () => {
  let attemptCount = 0;
  // Simulates the pipeline: attempt, then retry while the rules allow it.
  do {
    attemptCount += 1;
  } while (shouldRetry("transient", attemptCount) && attemptCount < 100);

  assertEquals(attemptCount, MAX_ATTEMPTS);
});

Deno.test("terminal states are never retried", () => {
  for (const classification of ["delivered", "failed", "suppressed"] as Classification[]) {
    assertEquals(shouldRetry(classification, 1), false, classification);
    assertEquals(shouldRetry(classification, 2), false, classification);
  }
});

Deno.test("only transient classifications are retryable", () => {
  for (const classification of ["delivered", "credential", "permanent", "suppressed"] as const) {
    assertEquals(shouldRetry(classification, 1), false, classification);
  }
  assert(shouldRetry("transient", 1));
});
