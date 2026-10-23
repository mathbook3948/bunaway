import type { NativeEnvironment } from "@bunaway/plugin";
import { createUpdater } from "#updater/adapter";
import type { UpdaterInstance } from "#updater/contract";
import { createPackageFiles } from "#updater/platforms/package-files";
import { createAuthenticodeVerifier } from "#updater/platforms/windows-authenticode";

/**
 * The check and download are platform neutral; this adapter names the update target and the
 * update folder, and supplies the Authenticode check an app can require of the package.
 */
export function initialize(environment: NativeEnvironment): UpdaterInstance {
  return createUpdater("windows", process.arch, environment, {
    files: createPackageFiles(environment.dataRoot),
    signature: createAuthenticodeVerifier(),
  });
}

export function dispose(instance: UpdaterInstance): Promise<void> {
  return instance.dispose();
}

export function busy(instance: UpdaterInstance): boolean {
  return instance.busy();
}
