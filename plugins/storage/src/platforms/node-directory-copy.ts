import { type BigIntStats, type Dirent, lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { BunawayError } from "@bunaway/plugin";
import type { StorageDirectorySize } from "#storage/contract";
import {
  cancelled,
  createCheckpoint,
  type DirectorySizeLimits,
  entryInfo,
  isLink,
  limitExceeded,
  openFrame,
} from "#storage/platforms/node-directory";

const DIRECTORY_MODE = 0o700;

/** Copies one regular file to a new name; the destination must not exist. */
export type CopyFileContents = (from: string, to: string) => void;

/** A directory of the source tree paired with the destination directory created for it. */
type CopyFrame = {
  from: string;
  to: string;
  depth: number;
};

/** The destination root is inside the source tree, so the copy would keep copying its own output. */
function insideSource(): BunawayError {
  return new BunawayError({
    code: "INVALID_ARGUMENT",
    message: "Cannot copy a directory into itself.",
  });
}

/** Links, sockets, FIFOs and devices have no faithful copy, so they fail instead of being skipped. */
function unsupportedEntry(): BunawayError {
  return new BunawayError({
    code: "INVALID_ARGUMENT",
    message: "Storage directory contains an entry that cannot be copied.",
  });
}

/** What one copy has done so far, shared by the walk and the per-entry step. */
type CopyProgress = {
  bytes: bigint;
  files: number;
  directories: number;
  visited: number;
  /** Identity of the destination root, to recognise it when the walk reaches it. */
  destination: BigIntStats;
  pending: CopyFrame[];
};

/** Whether the listed directory is the destination root itself, which a link placed inside the source. */
function isDestinationRoot(info: BigIntStats, destination: BigIntStats) {
  // Some file systems report no stable identity (0), which must not match every directory.
  return (
    destination.ino !== 0n &&
    info.ino === destination.ino &&
    info.dev === destination.dev
  );
}

/** Copy one listed entry of `frame`, or queue it when it is a directory. */
function copyEntry(
  frame: CopyFrame,
  entry: Dirent,
  info: BigIntStats,
  progress: CopyProgress,
  limits: DirectorySizeLimits,
  copyFile: CopyFileContents,
): void {
  if (isLink(entry, info)) {
    throw unsupportedEntry();
  }
  const source = join(frame.from, entry.name);
  const target = join(frame.to, entry.name);
  if (info.isFile()) {
    copyFile(source, target);
    progress.files++;
    progress.bytes += info.size;
    return;
  }
  if (!info.isDirectory()) {
    throw unsupportedEntry();
  }
  if (frame.depth + 1 > limits.depth) {
    throw limitExceeded();
  }
  if (isDestinationRoot(info, progress.destination)) {
    throw insideSource();
  }
  mkdirSync(target, {
    mode: DIRECTORY_MODE,
  });
  progress.directories++;
  progress.pending.push({
    from: source,
    to: target,
    depth: frame.depth + 1,
  });
}

/**
 * Copy the directory tree at `from` to the new directory `to`, depth first with an explicit stack.
 * `to` is created exclusively, so an existing file or directory is never merged into or replaced;
 * its parent must exist. Regular files go through `copyFile`, subdirectories are created as they
 * are reached, and the first failure ends the copy and leaves what was already copied. Links and
 * special files fail the copy. A directory below the source that is the destination itself, found
 * by file identity so a link into the source cannot hide it, fails instead of being copied
 * recursively. `alive` throws when the owner went away; the abort signal ends the copy with
 * CANCELLED between entries. The result counts what was copied, with file sizes taken from the
 * listing; the root is not counted in directories.
 */
export async function copyDirectoryTree(
  from: string,
  to: string,
  limits: DirectorySizeLimits,
  copyFile: CopyFileContents,
  signal: AbortSignal | undefined,
  alive: () => void,
): Promise<StorageDirectorySize> {
  const checkpoint = createCheckpoint(signal, alive);
  await checkpoint();
  mkdirSync(to, {
    mode: DIRECTORY_MODE,
  });
  const progress: CopyProgress = {
    bytes: 0n,
    files: 0,
    directories: 0,
    visited: 0,
    destination: lstatSync(to, {
      bigint: true,
    }),
    pending: [
      {
        from,
        to,
        depth: 0,
      },
    ],
  };
  for (
    let frame = progress.pending.pop();
    frame;
    frame = progress.pending.pop()
  ) {
    await checkpoint();
    const directory = openFrame(frame.from, frame.depth);
    if (!directory) {
      continue;
    }
    try {
      for (
        let entry = directory.readSync();
        entry;
        entry = directory.readSync()
      ) {
        await checkpoint();
        if (++progress.visited > limits.entries) {
          throw limitExceeded();
        }
        const info = entryInfo(frame.from, entry);
        if (info) {
          copyEntry(frame, entry, info, progress, limits, copyFile);
        }
      }
    } finally {
      directory.closeSync();
    }
  }
  // A cancellation or disposal that arrived during the last step still ends the copy.
  alive();
  if (signal?.aborted) {
    throw cancelled();
  }
  if (progress.bytes > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Storage size cannot be represented safely.");
  }
  return {
    bytes: Number(progress.bytes),
    files: progress.files,
    directories: progress.directories,
  };
}
