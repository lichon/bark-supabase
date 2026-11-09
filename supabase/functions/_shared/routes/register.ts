/**
 * Device registration.
 *
 * Accepts JSON, form-encoded and query input for the same fields, because the app
 * and third-party clients use different shapes (FR-001 – FR-004, FR-024).
 *
 * Contract: specs/001-bark-server-supabase/contracts/http-api.md
 */

import {
  DEVICE_KEY_PATTERN,
  deviceKindParam,
  normalize,
  type NormalizeInput,
  requireDeviceToken,
  stringParam,
} from "../params.ts";
import { BarkError, jsonResponse, success } from "../response.ts";
import type { Store } from "../store.ts";

export interface RegisterDeps {
  store: Store;
}

export interface RegisterData {
  key: string;
  device_key: string;
  device_token: string;
  device_type: string;
}

/** `POST /register` and legacy `GET /register` (query parameters). */
export async function handleRegister(
  deps: RegisterDeps,
  input: NormalizeInput,
): Promise<Response> {
  const params = normalize(input);
  const deviceToken = requireDeviceToken(params);
  const deviceKind = deviceKindParam(params);

  const suppliedKey = stringParam(params, "device_key")?.trim();
  if (suppliedKey !== undefined && suppliedKey !== "" && !DEVICE_KEY_PATTERN.test(suppliedKey)) {
    throw new BarkError("invalid device key");
  }

  const device = await deps.store.registerDevice({
    deviceKey: suppliedKey === "" ? null : (suppliedKey ?? null),
    deviceToken,
    deviceKind,
  });

  const payload: RegisterData = {
    key: device.device_key,
    device_key: device.device_key,
    device_token: device.device_token,
    device_type: device.device_kind,
  };
  return jsonResponse(success(payload));
}

/** `GET /register/{device_key}` — existence check. */
export async function handleRegisterCheck(
  deps: RegisterDeps,
  deviceKey: string,
): Promise<Response> {
  const device = await deps.store.lookupDevice(deviceKey);
  if (!device || device.disabled_at !== null) {
    throw new BarkError("device not found");
  }
  return jsonResponse(success());
}
