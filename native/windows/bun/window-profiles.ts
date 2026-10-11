import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import {
  MAX_WINDOW_INSTANCES,
  type WindowSpec,
} from "@bunaway/plugin-api/native";
import { viewDirName } from "./view-profile.ts";

const PROFILE_CLEANUP_TIMEOUT_MS = 3_000;
const PROFILE_CLEANUP_RETRY_MS = 100;

/** Own temporary profiles by logical instance, so recreation changes HWND IDs without losing storage. */
export class WindowProfiles {
  private readonly isolated = new Map<string, string>();
  private readonly pending = new Map<
    string,
    {
      deadline: number;
      retryAt: number;
    }
  >();
  private readonly temporaryRoot: string;
  constructor(
    private readonly dataRoot: string,
    private readonly legacy: boolean,
    private readonly log: (event: string, data: object) => void,
  ) {
    this.temporaryRoot = resolve(dataRoot, "webview", "temporary");
  }

  /** Return a persistent view path or allocate a fresh temporary owner, never replaying orphan profiles. */
  path(spec: WindowSpec, key: string): string {
    if (spec.profile !== "isolated") {
      return resolve(
        this.dataRoot,
        "webview",
        ...(this.legacy
          ? []
          : [
              viewDirName(spec.view),
            ]),
      );
    }
    let path = this.isolated.get(key);
    if (!path) {
      path = resolve(
        this.temporaryRoot,
        `p${process.pid}-${crypto.randomUUID()}`,
      );
      mkdirSync(path, {
        recursive: true,
      });
      this.isolated.set(key, path);
    }
    return path;
  }

  /** Keep storage through approved recreation; final closure retries locked files for a bounded interval. */
  release(key: string, preserve: boolean): boolean {
    if (preserve) {
      return true;
    }
    const path = this.isolated.get(key);
    if (!path) {
      return true;
    }
    if (!this.remove(path)) {
      return false;
    }
    this.isolated.delete(key);
    return true;
  }

  /** Best-effort bounded cleanup of abandoned profiles whose owning process no longer exists. */
  collectOrphans(): void {
    let names: string[];
    try {
      names = readdirSync(this.temporaryRoot);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return;
      }
      this.log("profile-cleanup-scan-failed", {
        message: String(error),
      });
      return;
    }
    let scanned = 0;
    for (const name of names) {
      if (scanned++ >= MAX_WINDOW_INSTANCES) {
        break;
      }
      const match = /^p([0-9]+)-[0-9a-f-]{36}$/.exec(name);
      if (!match) {
        continue;
      }
      const pid = Number(match[1]);
      try {
        process.kill(pid, 0);
        continue;
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          error.code !== "ESRCH"
        ) {
          continue;
        }
      }
      this.remove(resolve(this.temporaryRoot, name));
    }
  }

  private remove(path: string): boolean {
    const now = Date.now();
    let retry = this.pending.get(path);
    if (retry && now < retry.retryAt) {
      return false;
    }
    try {
      // fs.rm removes symlinks themselves and does not follow them into another profile.
      rmSync(path, {
        recursive: true,
        force: true,
      });
      this.pending.delete(path);
      return true;
    } catch (error) {
      if (!retry) {
        retry = {
          deadline: now + PROFILE_CLEANUP_TIMEOUT_MS,
          retryAt: now,
        };
        // Failed abandoned profiles must not grow the in-memory retry queue without bound.
        if (this.pending.size >= MAX_WINDOW_INSTANCES) {
          const oldest = this.pending.keys().next().value;
          if (oldest !== undefined) {
            this.pending.delete(oldest);
          }
        }
        this.pending.set(path, retry);
        this.log("profile-cleanup-retry", {
          path,
          message: String(error),
        });
      }
      if (now >= retry.deadline) {
        this.pending.delete(path);
        this.log("profile-cleanup-deferred", {
          path,
          message: String(error),
        });
        return true;
      }
      retry.retryAt = now + PROFILE_CLEANUP_RETRY_MS;
      return false;
    }
  }
}
