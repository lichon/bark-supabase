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
}

export interface MiscHandlers {
  root(): Response;
  ping(): Response;
  healthz(): Promise<Response>;
  info(): Response;
}

export function createMiscHandlers(deps: MiscDeps): MiscHandlers {
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

    info(): Response {
      return jsonResponse(
        success({
          version: deps.config.version,
          build: deps.config.build,
          arch: deps.config.arch,
          commit: deps.config.commit,
        }),
      );
    },
  };
}
