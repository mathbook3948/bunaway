import {
  MAX_FILENAME_CHARACTERS,
  type StorageDirectoryEntry,
} from "#storage/contract";

const FILE_ATTRIBUTE_DIRECTORY = 0x10;
const FILE_ATTRIBUTE_REPARSE_POINT = 0x400;
const ENTRY_HEADER_BYTES = 104;
const ENTRY_ATTRIBUTES_OFFSET = 56;
const ENTRY_NAME_BYTES_OFFSET = 60;
const ENTRY_END_OF_FILE_OFFSET = 40;
const WCHAR_BYTES = 2;
const ENTRY_ALIGNMENT_BYTES = 8;

/** A listed child with its logical size (EndOfFile), meaningful for files only. */
export type ScannedDirectoryEntry = StorageDirectoryEntry & {
  endOfFile: bigint;
};

/** Decode one batch into public entries, dropping sizes. */
export function directoryEntries(buffer: Buffer): StorageDirectoryEntry[] {
  return scanDirectoryEntries(buffer).map(({ name, kind }) => ({
    name,
    kind,
  }));
}

/** Decode one native FILE_ID_BOTH_DIR_INFO batch, checking offsets before reading names. */
export function scanDirectoryEntries(buffer: Buffer): ScannedDirectoryEntry[] {
  const entries: ScannedDirectoryEntry[] = [];
  let offset = 0;
  while (true) {
    if (offset + ENTRY_HEADER_BYTES > buffer.length) {
      throw new Error("Invalid native directory entry header.");
    }
    const nextOffset = buffer.readUInt32LE(offset);
    const nameBytes = buffer.readUInt32LE(offset + ENTRY_NAME_BYTES_OFFSET);
    const recordEnd = nextOffset ? offset + nextOffset : buffer.length;
    if (
      recordEnd > buffer.length ||
      (nextOffset &&
        (nextOffset < ENTRY_HEADER_BYTES ||
          nextOffset % ENTRY_ALIGNMENT_BYTES)) ||
      nameBytes === 0 ||
      nameBytes % WCHAR_BYTES ||
      nameBytes > MAX_FILENAME_CHARACTERS * WCHAR_BYTES ||
      offset + ENTRY_HEADER_BYTES + nameBytes > recordEnd
    ) {
      throw new Error("Invalid native directory entry bounds.");
    }
    const name = buffer
      .subarray(
        offset + ENTRY_HEADER_BYTES,
        offset + ENTRY_HEADER_BYTES + nameBytes,
      )
      .toString("utf16le");
    if (name !== "." && name !== "..") {
      const attributes = buffer.readUInt32LE(offset + ENTRY_ATTRIBUTES_OFFSET);
      let kind: StorageDirectoryEntry["kind"] = "file";
      if (attributes & FILE_ATTRIBUTE_REPARSE_POINT) {
        kind = "link";
      } else if (attributes & FILE_ATTRIBUTE_DIRECTORY) {
        kind = "directory";
      }
      entries.push({
        name,
        kind,
        endOfFile: buffer.readBigInt64LE(offset + ENTRY_END_OF_FILE_OFFSET),
      });
    }
    if (!nextOffset) {
      return entries;
    }
    offset += nextOffset;
  }
}
