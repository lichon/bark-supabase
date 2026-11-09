/**
 * Liveness, readiness and build information.
 *
 * `/`, `/ping`, `/healthz` and `/info` are the operator-facing endpoints from the
 * client contract. `/healthz` reports the *name* of a missing or unusable
 * credential and never its value.
 *
 * Contract: specs/001-bark-server-supabase/contracts/http-api.md
 */

import { type BarkConfig, readiness } from "../config.ts";
import { jsonResponse, success, textResponse } from "../response.ts";

export interface MiscDeps {
  config: BarkConfig;
  env: Record<string, string | undefined>;
  countDevices?: () => Promise<number>;
}

export interface MiscHandlers {
  root(): Response;
  ping(): Response;
  healthz(): Promise<Response>;
  info(): Promise<Response>;
}

export function createMiscHandlers(deps: MiscDeps): MiscHandlers {
  const countDevices = deps.countDevices ?? (() => Promise.resolve(0));

  return {
    root(): Response {
      return textResponse("ok");
    },

    ping(): Response {
      return jsonResponse(success(undefined, "pong"));
    },

    async healthz(): Promise<Response> {
      const result = await readiness(deps.env);
      if (!result.ready) {
        const reason = result.message ?? `${result.failingVariable} is not usable`;
        return textResponse(`not ready: ${reason}`, { status: 503 });
      }
      return textResponse("ok");
    },

    async info(): Promise<Response> {
      let devices = 0;
      try {
        devices = await countDevices();
      } catch {
        devices = 0;
      }
      return jsonResponse(
        success({
          version: deps.config.version,
          build: deps.config.build,
          arch: deps.config.arch,
          commit: deps.config.commit,
          devices,
        }),
      );
    },
  };
}
