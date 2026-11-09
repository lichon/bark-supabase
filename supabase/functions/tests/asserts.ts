/**
 * Minimal assertion helpers.
 *
 * The suite deliberately depends on nothing outside this directory, so
 * `deno test` runs without a network fetch or a remote import map.
 */

export function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const aKeys = Object.keys(a as Record<string, unknown>).sort();
    const bKeys = Object.keys(b as Record<string, unknown>).sort();
    if (!deepEqual(aKeys, bKeys)) return false;
    return aKeys.every((key) =>
      deepEqual(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
      )
    );
  }
  return false;
}

export function assertEquals<T>(actual: T, expected: T, message?: string): void {
  if (!deepEqual(actual, expected)) {
    throw new Error(
      message ??
        `expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`,
    );
  }
}

export function assertNotEquals<T>(actual: T, expected: T, message?: string): void {
  if (deepEqual(actual, expected)) {
    throw new Error(message ?? `expected value to differ from ${JSON.stringify(expected)}`);
  }
}

function matches(error: unknown, matcher?: RegExp | ((error: unknown) => boolean)): boolean {
  if (!matcher) return true;
  if (typeof matcher === "function") return matcher(error);
  const message = error instanceof Error ? error.message : String(error);
  return matcher.test(message);
}

export function assertThrows(
  fn: () => unknown,
  matcher?: RegExp | ((error: unknown) => boolean),
  message = "expected function to throw",
): unknown {
  try {
    fn();
  } catch (error) {
    if (!matches(error, matcher)) {
      throw new Error(`${message}: thrown error did not match (${String(error)})`);
    }
    return error;
  }
  throw new Error(message);
}

export async function assertRejects(
  fn: () => Promise<unknown>,
  matcher?: RegExp | ((error: unknown) => boolean),
  message = "expected promise to reject",
): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    if (!matches(error, matcher)) {
      throw new Error(`${message}: rejection did not match (${String(error)})`);
    }
    return error;
  }
  throw new Error(message);
}
