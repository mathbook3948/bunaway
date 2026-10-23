import type { NativeEnvironment } from "@bunaway/plugin";
import { BunawayError } from "@bunaway/protocol";
import { checkForUpdateTarget } from "#updater/check";
import {
  type PackageFiles,
  settingsSchema,
  UPDATER_TARGETS,
  type UpdaterInstance,
  type UpdaterPlatform,
  type UpdaterSettings,
  type UpdateTarget,
} from "#updater/contract";
import { downloadPackage } from "#updater/download";
import { validateEndpointTemplate } from "#updater/endpoint";
import type { SignatureVerifier } from "#updater/signature";

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
        "bunaway.json plugins.updater must be { endpoint: string, channel?: string, authenticode?: { publisherNames: string[] } }.",
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
    downloadTimeoutMs?: number;
    /** The update folder; a platform without one cannot download. */
    files?: PackageFiles;
    /**
     * Signature check for the platform's installers, with the owner of its resources. A platform
     * without one refuses a download when the app asks for a signature.
     */
    signature?: {
      verify: SignatureVerifier;
      close(): void;
    };
  } = {},
): UpdaterInstance {
  const settings = readSettings(environment);
  const active = new Set<AbortController>();
  let disposed = false;
  let target: UpdateTarget | null = null;
  let downloading: Promise<unknown> | undefined;
  function requireConfigured(): UpdaterSettings {
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
    return settings;
  }
  const development = environment.app?.launch.mode === "development";
  return {
    async check(signal) {
      const configured = requireConfigured();
      const controller = new AbortController();
      active.add(controller);
      try {
        const checked = await checkForUpdateTarget({
          template: configured.endpoint,
          channel: configured.channel,
          target: UPDATER_TARGETS[platform],
          arch: ARCHITECTURES[arch] ?? null,
          appVersion: environment.app?.version ?? null,
          development,
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
        target = checked.target;
        return checked.result;
      } finally {
        active.delete(controller);
      }
    },
    async download(signal) {
      requireConfigured();
      if (!target) {
        throw new BunawayError({
          code: "UNSUPPORTED",
          message: "No update was found by the last check.",
          details: {
            reason: "notChecked",
          },
        });
      }
      if (!seams.files) {
        throw new BunawayError({
          code: "UNSUPPORTED",
          message: "This platform has no update folder.",
          details: {
            reason: "notAvailable",
          },
        });
      }
      if (downloading !== undefined) {
        throw new BunawayError({
          code: "BUSY",
          message: "An update download is already running.",
          details: {
            reason: "downloadInProgress",
          },
        });
      }
      const controller = new AbortController();
      active.add(controller);
      const running = downloadPackage({
        target,
        files: seams.files,
        authenticode: settings?.authenticode,
        verifySignature: seams.signature?.verify,
        development,
        fetch: seams.fetchImpl ?? fetch,
        signal: signal
          ? AbortSignal.any([
              signal,
              controller.signal,
            ])
          : controller.signal,
        ...(seams.downloadTimeoutMs === undefined
          ? {}
          : {
              timeoutMs: seams.downloadTimeoutMs,
            }),
      });
      downloading = running;
      try {
        return await running;
      } finally {
        downloading = undefined;
        active.delete(controller);
      }
    },
    busy() {
      return downloading !== undefined;
    },
    async dispose() {
      disposed = true;
      for (const controller of active) {
        controller.abort();
      }
      // The download's own caller receives its outcome; here only the cleanup it finishes matters.
      await downloading?.then(
        (value) => value,
        (error: unknown) => error,
      );
      seams.signature?.close();
    },
  };
}
