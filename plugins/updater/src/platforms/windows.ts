import type { NativeEnvironment } from "@bunaway/plugin";
import { createUpdater } from "#updater/adapter";
import type { UpdaterInstance } from "#updater/contract";
import { createPackageFiles } from "#updater/platforms/package-files";

/** The check and download are platform neutral; this adapter names the update target and the update folder. */
export function initialize(environment: NativeEnvironment): UpdaterInstance {
  return createUpdater("windows", process.arch, environment, {
    files: createPackageFiles(environment.dataRoot),
  });
}

export function dispose(instance: UpdaterInstance): Promise<void> {
  return instance.dispose();
}

export function busy(instance: UpdaterInstance): boolean {
  return instance.busy();
}
