import {
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import {
  MAX_WINDOW_INSTANCES,
  type WindowSpec,
} from "@bunaway/plugin-api/native";
import { viewDirName } from "./view-profile.ts";

const PROFILE_CLEANUP_TIMEOUT_MS = 3_000;
const PROFILE_CLEANUP_RETRY_MS = 100;
// Allow escaped filesystem basenames while bounding corrupt metadata reads.
const PROFILE_CURSOR_MAX_BYTES = 4_096;

/** Own temporary profiles by logical instance, so recreation changes HWND IDs without losing storage. */
export class WindowProfiles {
  private readonly isolated = new Map<string, string>();
  private readonly pending = new Map<
    string,
    {
      deadline: number;
      retryAt: number;
      deferred: boolean;
    }
  >();
  private readonly temporaryRoot: string;
  private readonly cursorPath: string;
  constructor(
    private readonly dataRoot: string,
    private readonly legacy: boolean,
    private readonly log: (event: string, data: object) => void,
  ) {
    this.temporaryRoot = resolve(dataRoot, "webview", "temporary");
    this.cursorPath = resolve(dataRoot, "webview", ".temporary-cleanup-cursor");
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

  /** Keep storage through approved recreation; failed final deletion retains ownership and retries until removal succeeds. */
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

  /**
   * Resume orphan checks across startups using a persisted name in sorted order.
   * Enumeration and sorting cover the entire directory; only entry checks, PID
   * probes and deletion attempts are bounded by MAX_WINDOW_INSTANCES per call.
   * Live, unknown and locked entries consume a slot but cannot starve later names.
   */
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
    if (names.length === 0) {
      return;
    }
    names.sort();
    const cursor = this.readCursor();
    const next =
      cursor === undefined ? 0 : names.findIndex((name) => name > cursor);
    const start = next < 0 ? 0 : next;
    const count = Math.min(names.length, MAX_WINDOW_INSTANCES);
    const batch = names.slice(start, start + count);
    if (batch.length < count) {
      batch.push(...names.slice(0, count - batch.length));
    }
    for (const name of batch) {
      const match = /^p([0-9]+)-[0-9a-f-]{36}$/.exec(name);
      if (!match) {
        continue;
      }
      const pid = Number(match[1]);
      if (!Number.isSafeInteger(pid) || pid <= 0) {
        continue;
      }
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
    // A name anchor survives deletions and insertions, unlike a listing offset.
    // Only enumerated names become deletion paths; cursor data never does.
    const lastName = batch.at(-1);
    if (lastName !== undefined) {
      this.writeCursor(lastName);
    }
  }

  private readCursor(): string | undefined {
    let file: number | undefined;
    try {
      // Ignore links and special files when reading progress metadata.
      if (!lstatSync(this.cursorPath).isFile()) {
        return undefined;
      }
      file = openSync(this.cursorPath, "r");
      const stat = fstatSync(file);
      if (!stat.isFile() || stat.size > PROFILE_CURSOR_MAX_BYTES) {
        return undefined;
      }
      const buffer = Buffer.alloc(PROFILE_CURSOR_MAX_BYTES);
      const bytes = readSync(file, buffer, 0, buffer.length, 0);
      const cursor: unknown = JSON.parse(
        buffer.subarray(0, bytes).toString("utf8"),
      );
      return typeof cursor === "string" ? cursor : undefined;
    } catch {
      // Missing, corrupt or unreadable progress restarts checks conservatively.
      return undefined;
    } finally {
      if (file !== undefined) {
        closeSync(file);
      }
    }
  }

  private writeCursor(name: string): void {
    const temporaryPath = `${this.cursorPath}-${crypto.randomUUID()}.tmp`;
    let created = false;
    try {
      // Exclusive creation and rename avoid following a pre-existing cursor link
      // and preserve the previous complete checkpoint if the write fails.
      const file = openSync(temporaryPath, "wx");
      created = true;
      try {
        writeFileSync(file, JSON.stringify(name));
      } finally {
        closeSync(file);
      }
      renameSync(temporaryPath, this.cursorPath);
    } catch (error) {
      this.log("profile-cleanup-progress-failed", {
        message: String(error),
      });
    } finally {
      if (created) {
        try {
          unlinkSync(temporaryPath);
        } catch {
          // A successful rename already removed this name. Failed cleanup of a
          // checkpoint staging file cannot authorize deleting any profile.
        }
      }
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
          deferred: false,
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
      if (now >= retry.deadline && !retry.deferred) {
        retry.deferred = true;
        this.log("profile-cleanup-deferred", {
          path,
          message: String(error),
        });
      }
      retry.retryAt = now + PROFILE_CLEANUP_RETRY_MS;
      return false;
    }
  }
}
