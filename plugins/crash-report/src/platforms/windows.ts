import { join, win32 } from "node:path";
import {
  BunawayError,
  type NativeEnvironment,
  ResourceOwner,
} from "@bunaway/plugin";
import { DUMP_FOLDER_NAME } from "#crash-report/contract";
import { WindowsCrashReport } from "#crash-report/platforms/windows-crash-report";
import {
  localAppDataFolder,
  openWerLibrary,
} from "#crash-report/platforms/windows-wer";

/**
 * The dump folder as a path relative to local app data. Windows Error Reporting takes only that
 * relative form, so an app data directory outside local app data cannot be used.
 */
export function relativeDumpFolder(
  folder: string,
  localAppData: string,
): string {
  const relative = win32.relative(localAppData, folder);
  if (!relative || relative.startsWith("..") || win32.isAbsolute(relative)) {
    throw new BunawayError({
      code: "UNSUPPORTED",
      message:
        "Crash dumps need the app data directory inside the local app data directory.",
    });
  }
  return relative;
}

/** Load the Windows Error Reporting calls on the host I/O worker; the adapter unloads them when disposed. */
export function initialize(environment: NativeEnvironment): WindowsCrashReport {
  const folder = join(environment.dataRoot, DUMP_FOLDER_NAME);
  const relative = relativeDumpFolder(folder, localAppDataFolder());
  const owner = new ResourceOwner("Crash report library");
  const library = owner.acquire(openWerLibrary, (loaded) => loaded.close());
  return new WindowsCrashReport(library.bindings, folder, relative, () =>
    owner.dispose(),
  );
}

export function dispose(adapter: WindowsCrashReport): void {
  adapter.dispose();
}
