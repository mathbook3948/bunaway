import { type Pointer, ptr } from "bun:ffi";
/** Build a NUL-terminated UTF-16LE buffer for Win32 W functions. */
export const wide = (text: string) => Buffer.from(`${text}\0`, "utf16le");
const nativeBuffers = new Set<Buffer>();
/** Hold the buffer until the synchronous native call returns. */
export function withBuffer<T extends number | bigint>(
  buffer: Buffer,
  invoke: (address: Pointer) => T,
): T {
  nativeBuffers.add(buffer);
  try {
    return invoke(ptr(buffer));
  } finally {
    nativeBuffers.delete(buffer);
  }
}
/** Pass a temporary UTF-16LE string buffer to a synchronous native call. */
export function withWide<T extends number | bigint>(
  text: string,
  invoke: (address: Pointer) => T,
): T {
  return withBuffer(wide(text), invoke);
}
