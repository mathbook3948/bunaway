import { createHash } from "node:crypto";
import {
  closeSync,
  lstatSync,
  opendirSync,
  openSync,
  readSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import {
  type CrashDump,
  type CrashDumpKind,
  MAX_CRASH_DUMP_TOTAL_BYTES,
  MAX_CRASH_DUMPS,
  MAX_SCANNED_ENTRIES,
} from "#crash-report/contract";

const DUMP_EXTENSION = ".dmp";
const HEADER_BYTES = 32;
const MINIDUMP_SIGNATURE = "MDMP";
const FLAGS_OFFSET = 24;
/** MiniDumpWithFullMemory in the MINIDUMP_TYPE flags the header records. */
const FULL_MEMORY_FLAG = 0x2;

/** Name the host keeps for a dump next to the metadata it reports; the name never leaves the adapter. */
export interface DumpEntry extends CrashDump {
  name: string;
}

function dumpKind(path: string): CrashDumpKind {
  const header = Buffer.alloc(HEADER_BYTES);
  const file = openSync(path, "r");
  let read: number;
  try {
    read = readSync(file, header, 0, HEADER_BYTES, 0);
  } finally {
    closeSync(file);
  }
  if (
    read < HEADER_BYTES ||
    header.toString("latin1", 0, MINIDUMP_SIGNATURE.length) !==
      MINIDUMP_SIGNATURE
  ) {
    return "unknown";
  }
  return Number(header.readBigUInt64LE(FLAGS_OFFSET) & BigInt(FULL_MEMORY_FLAG))
    ? "full"
    : "mini";
}

/** Hash of what identifies one file, so a name reused by a later crash gets a new id. */
function dumpId(name: string, modifiedMs: number, size: number): string {
  return createHash("sha256")
    .update(`${name}\0${modifiedMs}\0${size}`)
    .digest("hex")
    .slice(0, 32);
}

function entryNames(folder: string): string[] | null {
  let directory: ReturnType<typeof opendirSync>;
  try {
    directory = opendirSync(folder);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  const names: string[] = [];
  try {
    for (
      let entry = directory.readSync();
      entry && names.length < MAX_SCANNED_ENTRIES;
      entry = directory.readSync()
    ) {
      names.push(entry.name);
    }
  } finally {
    directory.closeSync();
  }
  return names;
}

/**
 * Regular `.dmp` files directly inside `folder`, newest first. Links, reparse points, directories and
 * other names are ignored, so nothing outside the folder is read or reported. A missing folder is empty.
 */
export function scanDumps(folder: string): DumpEntry[] {
  const entries: DumpEntry[] = [];
  for (const name of entryNames(folder) ?? []) {
    if (!name.toLowerCase().endsWith(DUMP_EXTENSION)) {
      continue;
    }
    const path = join(folder, name);
    const stat = lstatSync(path, {
      throwIfNoEntry: false,
    });
    if (!stat?.isFile() || stat.isSymbolicLink()) {
      continue;
    }
    entries.push({
      name,
      id: dumpId(name, stat.mtimeMs, stat.size),
      createdAtMs: Math.floor(stat.mtimeMs),
      sizeBytes: stat.size,
      kind: dumpKind(path),
    });
  }
  return entries.sort(
    (a, b) => b.createdAtMs - a.createdAtMs || a.name.localeCompare(b.name),
  );
}

/** Delete the oldest dumps until at most MAX_CRASH_DUMPS remain and they fit MAX_CRASH_DUMP_TOTAL_BYTES; the newest stays. */
export function pruneDumps(folder: string): void {
  let total = 0;
  scanDumps(folder).forEach((entry, index) => {
    total += entry.sizeBytes;
    const overBytes = index > 0 && total > MAX_CRASH_DUMP_TOTAL_BYTES;
    if (index >= MAX_CRASH_DUMPS || overBytes) {
      rmSync(join(folder, entry.name), {
        force: true,
      });
    }
  });
}

/** Delete the dump with this id; false when none has it. */
export function removeDump(folder: string, id: string): boolean {
  const entry = scanDumps(folder).find((candidate) => candidate.id === id);
  if (!entry) {
    return false;
  }
  rmSync(join(folder, entry.name), {
    force: true,
  });
  return true;
}
