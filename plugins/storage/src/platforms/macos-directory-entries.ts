import { BunawayError } from "@bunaway/plugin";
import {
  MAX_FILENAME_CHARACTERS,
  type StorageDirectoryEntry,
} from "#storage/contract";
// Darwin arm64's 64-bit inode dirent layout, used by its unversioned readdir symbol.
export const DARWIN_DIRENT_HEADER_BYTES = 21;
const MAX_DARWIN_NAME_BYTES = 1023;
const MAX_DARWIN_RECORD_BYTES = 1048;
const RECORD_LENGTH_OFFSET = 16;
const NAME_LENGTH_OFFSET = 18;
const KIND_OFFSET = 20;
const DT_DIRECTORY = 4;
const DT_REGULAR = 8;
const DT_LINK = 10;

/** Check the fixed header before reading the stream's variable-sized native record. */
export function darwinDirectoryRecordLength(header: Buffer): number {
  if (header.length < DARWIN_DIRENT_HEADER_BYTES) {
    throw new Error("Invalid native directory entry header.");
  }
  const recordLength = header.readUInt16LE(RECORD_LENGTH_OFFSET);
  const nameLength = header.readUInt16LE(NAME_LENGTH_OFFSET);
  if (
    !nameLength ||
    nameLength > MAX_DARWIN_NAME_BYTES ||
    recordLength < DARWIN_DIRENT_HEADER_BYTES + nameLength + 1 ||
    recordLength > MAX_DARWIN_RECORD_BYTES ||
    recordLength % 4
  ) {
    throw new Error("Invalid native directory entry bounds.");
  }
  return recordLength;
}

/** Copy an observed name and kind without resolving or opening its child. */
export function darwinDirectoryEntry(
  record: Buffer,
): StorageDirectoryEntry | null {
  const recordLength = darwinDirectoryRecordLength(record);
  const nameLength = record.readUInt16LE(NAME_LENGTH_OFFSET);
  const end = DARWIN_DIRENT_HEADER_BYTES + nameLength;
  if (record.length < recordLength || record[end] !== 0) {
    throw new Error("Invalid native directory entry terminator.");
  }
  const name = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  }).decode(record.subarray(DARWIN_DIRENT_HEADER_BYTES, end));
  if (name.includes("/") || name.includes("\0")) {
    throw new Error("Invalid native directory entry name.");
  }
  if (name === "." || name === "..") {
    return null;
  }
  if (name.length > MAX_FILENAME_CHARACTERS) {
    throw new BunawayError({
      code: "INVALID_ARGUMENT",
      message: "Storage directory name exceeds the entry limit.",
    });
  }
  let kind: StorageDirectoryEntry["kind"];
  switch (record[KIND_OFFSET]) {
    case DT_DIRECTORY:
      kind = "directory";
      break;
    case DT_REGULAR:
      kind = "file";
      break;
    case DT_LINK:
      kind = "link";
      break;
    default:
      // Unknown and special kinds cannot be honestly represented by the public schema.
      throw new BunawayError({
        code: "UNSUPPORTED",
        message: "Storage directory entry kind is unsupported.",
      });
  }
  return {
    name,
    kind,
  };
}
