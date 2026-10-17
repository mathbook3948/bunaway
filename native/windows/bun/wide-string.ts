import { type Pointer, read, toArrayBuffer } from "bun:ffi";

/**
 * Copies a NUL-terminated UTF-16LE string from native memory. Returns `null`
 * when no terminator appears before `maxBytes`, so callers can reject
 * unterminated or oversized text. The caller keeps ownership of the memory.
 */
export function readWideString(
  address: Pointer,
  maxBytes: number,
): string | null {
  let length = 0;
  while (length < maxBytes && read.u16(address, length)) {
    length += 2;
  }
  if (length >= maxBytes) {
    return null;
  }
  return Buffer.from(toArrayBuffer(address, 0, length)).toString("utf16le");
}
