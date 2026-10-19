import { tmpdir } from "node:os";
import { win32 } from "node:path";
import { BunawayError, type NativeEnvironment } from "@bunaway/plugin";
import {
  type AppDirectory,
  type PathInstance,
  qualifiedPathSchema,
  type UserDirectory,
} from "#path/contract";
import {
  type KnownFolder,
  WindowsKnownFolders,
} from "#path/platforms/windows-known-folders";
/** Windows path semantics never inherit the I/O Worker's current working directory. */
export class WindowsPath implements PathInstance {
  private folders: WindowsKnownFolders | undefined;

  constructor(
    private readonly environment: Pick<NativeEnvironment, "app" | "dataRoot">,
  ) {}

  getDirectory(directory: UserDirectory): string {
    return this.knownFolder(directory);
  }

  private knownFolder(folder: KnownFolder): string {
    this.folders ??= new WindowsKnownFolders();
    return this.folders.get(folder);
  }

  /**
   * Resolve an app directory from the host's app identifier without creating it.
   *
   * Local directories live under the host's `dataRoot` (`%LOCALAPPDATA%\bunaway\<appId>`),
   * so `logs` matches the log plugin. `dataRoot` itself is never returned because the host
   * keeps WebView profiles and its lock there; app files go in its `data` and `cache` children.
   * Roaming `appConfig` and `appData` share `%APPDATA%\bunaway\<appId>`, and `temp` is the
   * per-user system temporary directory.
   */
  getAppDirectory(directory: AppDirectory): string {
    if (directory === "temp") {
      // TEMP and TMP come from the host process and may be empty or relative.
      const temp = tmpdir();
      if (!qualifiedPathSchema.safeParse(temp).success) {
        throw new BunawayError({
          code: "INTERNAL",
          message: "The temporary directory is not a fully qualified path.",
        });
      }
      return temp;
    }
    const appId = this.environment.app?.id;
    if (!appId) {
      throw new BunawayError({
        code: "INTERNAL",
        message: "The host did not provide an app identifier.",
      });
    }
    switch (directory) {
      case "appConfig":
      case "appData":
        return win32.join(this.knownFolder("roamingAppData"), "bunaway", appId);
      case "appLocalData":
        return win32.join(this.environment.dataRoot, "data");
      case "cache":
        return win32.join(this.environment.dataRoot, "cache");
      case "logs":
        return win32.join(this.environment.dataRoot, "logs");
    }
  }

  join(paths: string[]): string {
    return win32.join(...paths);
  }

  resolve(base: string, paths: string[]): string {
    return win32.resolve(base, ...paths);
  }

  normalize(path: string): string {
    return win32.normalize(path);
  }

  basename(path: string, suffix?: string): string {
    return win32.basename(path, suffix);
  }

  dirname(path: string): string {
    return win32.dirname(path);
  }

  extname(path: string): string {
    return win32.extname(path);
  }

  isAbsolute(path: string): boolean {
    return win32.isAbsolute(path);
  }

  dispose(): void {
    this.folders?.dispose();
    this.folders = undefined;
  }
}

export function initialize(environment: NativeEnvironment): WindowsPath {
  return new WindowsPath(environment);
}

export function dispose(instance: WindowsPath): void {
  instance.dispose();
}
