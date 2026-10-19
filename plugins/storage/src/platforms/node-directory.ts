import {
  type BigIntStats,
  type Dir,
  type Dirent,
  lstatSync,
  opendirSync,
} from "node:fs";
import { join } from "node:path";
import { BunawayError } from "@bunaway/plugin";
import {
  MAX_DIRECTORY_ENTRIES,
  MAX_FILENAME_CHARACTERS,
  type StorageDirectoryEntry,
  type StorageDirectorySize,
} from "#storage/contract";

/** Walk steps (opened directories or listed entries) between event loop yields. */
const YIELD_STEPS = 32;

/** Cost bounds of one directory size scan. */
export type DirectorySizeLimits = {
  entries: number;
  depth: number;
};

function isMissingEntry(error: unknown): boolean {
  return error instanceof Error && Reflect.get(error, "code") === "ENOENT";
}

/** An entry that vanished, or was replaced by a file, after it was listed. */
function isGone(error: unknown): boolean {
  return (
    isMissingEntry(error) ||
    (error instanceof Error && Reflect.get(error, "code") === "ENOTDIR")
  );
}

/**
 * Whether an entry is a link. Either source may report it: a drive-letter junction is a link to
 * both, but a mount point or a cloud folder can be reported as a link by the directory listing
 * only, and following one would walk or delete data outside the directory.
 */
export function isLink(entry: Dirent, info: BigIntStats): boolean {
  return entry.isSymbolicLink() || info.isSymbolicLink();
}

function entryInfo(parent: string, entry: Dirent): BigIntStats | null {
  try {
    return lstatSync(join(parent, entry.name), {
      bigint: true,
    });
  } catch (error) {
    // An entry removed after the listing is gone, not a failure of the scan.
    if (isMissingEntry(error)) {
      return null;
    }
    throw error;
  }
}

/**
 * Stats for a listing. System files such as pagefile.sys can fail `lstat` with EBUSY while
 * their listing type is still known, so any failure but a vanished entry falls back to it.
 */
function listingInfo(
  parent: string,
  entry: Dirent,
): BigIntStats | undefined | null {
  try {
    return entryInfo(parent, entry);
  } catch (error) {
    if (entry.isSymbolicLink() || entry.isDirectory() || entry.isFile()) {
      return undefined;
    }
    // Without a listing type the failure is the real answer, such as a denied access.
    throw error;
  }
}

function entryKind(
  entry: Dirent,
  info: BigIntStats | undefined,
): StorageDirectoryEntry["kind"] {
  if (entry.isSymbolicLink() || info?.isSymbolicLink()) {
    return "link";
  }
  if (info ? info.isDirectory() : entry.isDirectory()) {
    return "directory";
  }
  if (info ? info.isFile() : entry.isFile()) {
    return "file";
  }
  // The public schema has no honest kind for sockets, FIFOs and devices.
  throw new BunawayError({
    code: "UNSUPPORTED",
    message: "Storage directory entry kind is unsupported.",
  });
}

/** List the names and kinds of a directory's children without following any link, sorted by name. */
export function listDirectory(path: string): StorageDirectoryEntry[] {
  const entries: StorageDirectoryEntry[] = [];
  const directory = opendirSync(path);
  try {
    for (
      let child = directory.readSync();
      child;
      child = directory.readSync()
    ) {
      if (entries.length >= MAX_DIRECTORY_ENTRIES) {
        throw new BunawayError({
          code: "INVALID_ARGUMENT",
          message: "Storage directory exceeds the entry limit.",
        });
      }
      if (child.name.length > MAX_FILENAME_CHARACTERS) {
        throw new BunawayError({
          code: "INVALID_ARGUMENT",
          message: "Storage directory name exceeds the entry limit.",
        });
      }
      const info = listingInfo(path, child);
      if (info !== null) {
        entries.push({
          name: child.name,
          kind: entryKind(child, info),
        });
      }
    }
  } finally {
    directory.closeSync();
  }
  return entries.sort((left, right) =>
    left.name < right.name ? -1 : Number(left.name > right.name),
  );
}

/** Open a directory for the scan; one removed after it was listed is gone, not a failure. */
function openIfPresent(path: string): Dir | null {
  try {
    return opendirSync(path);
  } catch (error) {
    if (isGone(error)) {
      return null;
    }
    throw error;
  }
}

/** The root was checked by the caller, so only a descendant may have vanished. */
function openFrame(path: string, depth: number): Dir | null {
  return depth === 0 ? opendirSync(path) : openIfPresent(path);
}

/** Let queued host messages, such as cancellation, run before the scan continues. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function cancelled(): BunawayError {
  return new BunawayError({
    code: "CANCELLED",
    message: "Storage directory scan was cancelled.",
  });
}

function limitExceeded(): BunawayError {
  return new BunawayError({
    code: "INVALID_ARGUMENT",
    message: "Storage directory exceeds the size scan limit.",
  });
}

/**
 * Total the file sizes below a directory, depth first with an explicit stack. Files add their
 * size per name, directories are entered, and links and special files are skipped. `alive`
 * throws when the owner went away; the abort signal ends the scan with CANCELLED.
 */
export async function sumDirectory(
  root: string,
  limits: DirectorySizeLimits,
  signal: AbortSignal | undefined,
  alive: () => void,
): Promise<StorageDirectorySize> {
  let bytes = 0n;
  let files = 0;
  let directories = 0;
  let visited = 0;
  let steps = 0;
  const pending: {
    path: string;
    depth: number;
  }[] = [
    {
      path: root,
      depth: 0,
    },
  ];
  /** Yield now and then, and stop when the caller cancelled or the adapter was disposed. */
  const checkpoint = async (): Promise<void> => {
    alive();
    if (signal?.aborted) {
      throw cancelled();
    }
    if (++steps % YIELD_STEPS === 0) {
      await yieldToEventLoop();
    }
  };
  await checkpoint();
  for (let frame = pending.pop(); frame; frame = pending.pop()) {
    await checkpoint();
    const directory = openFrame(frame.path, frame.depth);
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
        if (++visited > limits.entries) {
          throw limitExceeded();
        }
        const info = entryInfo(frame.path, entry);
        if (!info || isLink(entry, info)) {
          continue;
        }
        if (info.isFile()) {
          files++;
          bytes += info.size;
        } else if (info.isDirectory()) {
          if (frame.depth + 1 > limits.depth) {
            throw limitExceeded();
          }
          directories++;
          pending.push({
            path: join(frame.path, entry.name),
            depth: frame.depth + 1,
          });
        }
      }
    } finally {
      directory.closeSync();
    }
  }
  // A cancellation or disposal that arrived during the last step still ends the scan.
  alive();
  if (signal?.aborted) {
    throw cancelled();
  }
  if (bytes > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Storage size cannot be represented safely.");
  }
  return {
    bytes: Number(bytes),
    files,
    directories,
  };
}
