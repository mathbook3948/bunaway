import type { NativeEnvironment } from "@bunaway/plugin";
import { BunawayError } from "@bunaway/protocol";
import { checkForUpdate } from "#updater/check";
import {
  settingsSchema,
  UPDATER_TARGETS,
  type UpdaterInstance,
  type UpdaterPlatform,
  type UpdaterSettings,
} from "#updater/contract";
import { validateEndpointTemplate } from "#updater/endpoint";

/** Update manifest architecture words for the CPUs the hosts run on. */
const ARCHITECTURES: Readonly<Record<string, string>> = {
  x64: "x86_64",
  arm64: "aarch64",
};

/** Read and validate the app's `plugins.updater` clause; an absent clause leaves the plugin unconfigured. */
function readSettings(environment: NativeEnvironment): UpdaterSettings | null {
  const clause = environment.app?.pluginSettings?.updater;
  if (clause === undefined) {
    return null;
  }
  const parsed = settingsSchema.safeParse(clause);
  if (!parsed.success) {
    throw new BunawayError({
      code: "INVALID_ARGUMENT",
      message:
        "bunaway.json plugins.updater must be { endpoint: string, channel?: string }.",
    });
  }
  validateEndpointTemplate(
    parsed.data.endpoint,
    environment.app?.launch.mode === "development",
  );
  return parsed.data;
}

/**
 * The same neutral check on every platform: the endpoint and channel come from the app's settings,
 * never from the caller. `arch` is the host CPU (`process.arch`); `fetchImpl` is a seam for tests.
 */
export function createUpdater(
  platform: UpdaterPlatform,
  arch: string,
  environment: NativeEnvironment,
  seams: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  } = {},
): UpdaterInstance {
  const settings = readSettings(environment);
  const active = new Set<AbortController>();
  let disposed = false;
  return {
    async check(signal) {
      if (disposed) {
        throw new BunawayError({
          code: "CANCELLED",
          message: "Updater adapter is disposed.",
        });
      }
      if (!settings) {
        throw new BunawayError({
          code: "UNSUPPORTED",
          message: "bunaway.json has no plugins.updater settings.",
          details: {
            reason: "notConfigured",
          },
        });
      }
      const controller = new AbortController();
      active.add(controller);
      try {
        return await checkForUpdate({
          template: settings.endpoint,
          channel: settings.channel,
          target: UPDATER_TARGETS[platform],
          arch: ARCHITECTURES[arch] ?? null,
          appVersion: environment.app?.version ?? null,
          development: environment.app?.launch.mode === "development",
          fetch: seams.fetchImpl ?? fetch,
          signal: signal
            ? AbortSignal.any([
                signal,
                controller.signal,
              ])
            : controller.signal,
          ...(seams.timeoutMs === undefined
            ? {}
            : {
                timeoutMs: seams.timeoutMs,
              }),
        });
      } finally {
        active.delete(controller);
      }
    },
    dispose() {
      disposed = true;
      for (const controller of active) {
        controller.abort();
      }
    },
  };
}
