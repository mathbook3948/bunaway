import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, type WriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { PackageFiles, PackageSink } from "#updater/contract";

const PACKAGE_SUFFIX = ".package";
const PARTIAL_SUFFIX = ".partial";

async function digestOf(path: string, signal: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, {
    signal,
  })) {
    hash.update(chunk as Uint8Array);
  }
  return hash.digest("hex");
}

class FileSink implements PackageSink {
  private readonly hash = createHash("sha256");
  private readonly stream: WriteStream;
  private failure: Error | undefined;

  constructor(
    readonly pendingPath: string,
    private readonly target: string,
  ) {
    this.stream = createWriteStream(pendingPath, {
      flags: "w",
    });
    this.stream.on("error", (error) => {
      this.failure = error;
    });
  }

  write(chunk: Uint8Array): Promise<void> {
    this.hash.update(chunk);
    return new Promise((resolve, reject) => {
      if (this.failure) {
        reject(this.failure);
        return;
      }
      this.stream.write(chunk, (error) => (error ? reject(error) : resolve()));
    });
  }

  /** Resolves once the file handle is closed, so the rename that follows never meets an open handle. */
  finish(): Promise<string> {
    return new Promise((resolve, reject) => {
      if (this.failure) {
        reject(this.failure);
        return;
      }
      this.stream.once("close", () =>
        this.failure ? reject(this.failure) : resolve(this.hash.digest("hex")),
      );
      this.stream.end();
    });
  }

  async publish(): Promise<string> {
    await rename(this.pendingPath, this.target);
    return this.target;
  }

  async discard(): Promise<void> {
    if (!this.stream.closed) {
      await new Promise<void>((resolve) => {
        this.stream.once("close", () => resolve());
        this.stream.destroy();
      });
    }
    await rm(this.pendingPath, {
      force: true,
    });
  }
}

/** Packages live in `<dataRoot>/data/updates`, named by digest so the manifest cannot choose a file name. */
export function createPackageFiles(dataRoot: string): PackageFiles {
  const directory = join(dataRoot, "data", "updates");
  const finalPath = (sha256: string) =>
    join(directory, sha256 + PACKAGE_SUFFIX);
  return {
    async reuse(sha256, size, signal) {
      const path = finalPath(sha256);
      try {
        if (
          (await stat(path)).size === size &&
          (await digestOf(path, signal)) === sha256
        ) {
          return path;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return null;
        }
        throw error;
      }
      await rm(path, {
        force: true,
      });
      return null;
    },
    async remove(sha256) {
      await rm(finalPath(sha256), {
        force: true,
      });
    },
    async create(sha256) {
      await mkdir(directory, {
        recursive: true,
      });
      return new FileSink(
        join(directory, sha256 + PARTIAL_SUFFIX),
        finalPath(sha256),
      );
    },
    async prune(sha256) {
      const keep = sha256 + PACKAGE_SUFFIX;
      for (const name of await readdir(directory)) {
        if (
          name !== keep &&
          (name.endsWith(PACKAGE_SUFFIX) || name.endsWith(PARTIAL_SUFFIX))
        ) {
          try {
            await rm(join(directory, name), {
              force: true,
            });
          } catch {
            // A file another process holds stays until a later download; the others are still removed.
          }
        }
      }
    },
  };
}
