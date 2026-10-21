import type { NativeEnvironment } from "@bunaway/plugin";
import { createUpdater } from "#updater/adapter";
import type { UpdaterInstance } from "#updater/contract";

/** The check is platform neutral; this adapter only names the update target. */
export function initialize(environment: NativeEnvironment): UpdaterInstance {
  return createUpdater("windows", process.arch, environment);
}

export function dispose(instance: UpdaterInstance): void {
  instance.dispose();
}
