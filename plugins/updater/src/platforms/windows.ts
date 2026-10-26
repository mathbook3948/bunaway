import type { NativeEnvironment } from "@bunaway/plugin";
import { createUpdater } from "#updater/adapter";
import type { UpdaterInstance } from "#updater/contract";
import { createPackageFiles } from "#updater/platforms/package-files";
import { createAuthenticodeVerifier } from "#updater/platforms/windows-authenticode";
import {
  createPackageQueries,
  isManagedByStore,
} from "#updater/platforms/windows-package-identity";

/**
 * The check and download are platform neutral; this adapter names the update target and the
 * update folder, supplies the Authenticode check an app can require of the package, and refuses
 * the update on an MSIX install, which only the package manager can replace.
 */
export function initialize(environment: NativeEnvironment): UpdaterInstance {
  const packageQueries = createPackageQueries();
  return createUpdater("windows", process.arch, environment, {
    managedByStore: () => isManagedByStore(packageQueries),
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
