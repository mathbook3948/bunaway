import { tmpdir } from "node:os";
import { posix } from "node:path";
import { BunawayError, type NativeEnvironment } from "@bunaway/plugin";
import {
  type AppDirectory,
  type PathInstance,
  posixAbsolutePathSchema,
  type UserDirectory,
} from "#path/contract";

const DATA_ROOT_PARENT = "Library/Application Support/bunaway";
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

  /**
   * The worker's HOME and TMPDIR point at the host data root, so the user's home comes from the
   * data root's fixed layout `<home>/Library/Application Support/bunaway/<appId>`. Inside an App
   * Sandbox container the data root, and therefore this home, is the container's.
   */
  private home(): string {
    const suffix = `/${DATA_ROOT_PARENT}/${this.appId()}`;
    const { dataRoot } = this.environment;
    const home = dataRoot.endsWith(suffix)
      ? dataRoot.slice(0, -suffix.length)
      : undefined;
    if (
      home === undefined ||
      !posixAbsolutePathSchema.safeParse(home).success
    ) {
      throw new BunawayError({
        code: "INTERNAL",
        message: "The host data root does not match the macOS app layout.",
      });
    }
    return home;
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
        // TMPDIR comes from the host process and may be empty or relative.
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
