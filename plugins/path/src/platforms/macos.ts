import { tmpdir } from "node:os";
import { posix } from "node:path";
import { BunawayError, type NativeEnvironment } from "@bunaway/plugin";
import { macosUserHome } from "@bunaway/plugin/macos-home";
import {
  type AppDirectory,
  type PathInstance,
  posixAbsolutePathSchema,
  type UserDirectory,
} from "#path/contract";

const USER_FOLDERS: Record<Exclude<UserDirectory, "home">, string> = {
  documents: "Documents",
  downloads: "Downloads",
  desktop: "Desktop",
  pictures: "Pictures",
  music: "Music",
  videos: "Movies",
};

/** macOS path semantics are POSIX and never inherit the I/O Worker's current working directory. */
export class MacosPath implements PathInstance {
  constructor(
    private readonly environment: Pick<NativeEnvironment, "app" | "dataRoot">,
  ) {}

  getDirectory(directory: UserDirectory): string {
    const home = this.home();
    return directory === "home"
      ? home
      : posix.join(home, USER_FOLDERS[directory]);
  }

  /** The user's home, derived from the host data root's fixed layout. */
  private home(): string {
    return macosUserHome(this.environment.dataRoot, this.appId());
  }

  private appId(): string {
    const appId = this.environment.app?.id;
    if (!appId) {
      throw new BunawayError({
        code: "INTERNAL",
        message: "The host did not provide an app identifier.",
      });
    }
    return appId;
  }

  /**
   * Resolve an app directory from the host's app identifier without creating it.
   *
   * Config, data and local data share `<dataRoot>/data`; `dataRoot` itself is never returned
   * because the host keeps WebView profiles and its lock there. `cache` lives under
   * `~/Library/Caches`, `logs` matches the log plugin's `<dataRoot>/logs`, and `temp` is the
   * host-created per-app temporary directory.
   */
  getAppDirectory(directory: AppDirectory): string {
    const { dataRoot } = this.environment;
    switch (directory) {
      case "temp": {
        // The host sets TMPDIR; os.tmpdir falls back to /tmp when it is empty, and a relative value is rejected.
        const temp = tmpdir();
        if (!posixAbsolutePathSchema.safeParse(temp).success) {
          throw new BunawayError({
            code: "INTERNAL",
            message: "The temporary directory is not an absolute path.",
          });
        }
        return temp;
      }
      case "appConfig":
      case "appData":
      case "appLocalData":
        this.home();
        return posix.join(dataRoot, "data");
      case "logs":
        this.home();
        return posix.join(dataRoot, "logs");
      case "cache":
        return posix.join(this.home(), "Library/Caches/bunaway", this.appId());
    }
  }

  join(paths: string[]): string {
    return posix.join(...paths);
  }

  resolve(base: string, paths: string[]): string {
    return posix.resolve(base, ...paths);
  }

  normalize(path: string): string {
    return posix.normalize(path);
  }

  basename(path: string, suffix?: string): string {
    return posix.basename(path, suffix);
  }

  dirname(path: string): string {
    return posix.dirname(path);
  }

  extname(path: string): string {
    return posix.extname(path);
  }

  isAbsolute(path: string): boolean {
    return posix.isAbsolute(path);
  }
}

export function initialize(environment: NativeEnvironment): MacosPath {
  return new MacosPath(environment);
}
