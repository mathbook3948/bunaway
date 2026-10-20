import { dlopen, ptr } from "bun:ffi";
import { win32CallError } from "@bunaway/plugin/win32";
import { BunawayError } from "@bunaway/protocol";
import { MAX_PRINTER_NAME_CHARS, MAX_PRINTERS } from "#os/contract";

const PRINTER_ENUM_LOCAL = 0x2;
const PRINTER_ENUM_CONNECTIONS = 0x4;
const PRINTER_INFO_LEVEL_4 = 4;
/** PRINTER_INFO_4W: `pPrinterName` and `pServerName` pointers, then the `Attributes` DWORD, padded to 8 bytes. */
const PRINTER_INFO_4_BYTES = 24;
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_INSUFFICIENT_BUFFER = 122;
/** The size query plus retries when the printer list grew between the size query and the read. */
const MAX_ENUM_ATTEMPTS = 3;
/** Bytes of one name with its terminating NUL at the longest allowed length. */
const MAX_NAME_BYTES = (MAX_PRINTER_NAME_CHARS + 1) * 2;
/** Upper bound for the enumeration buffer: every allowed entry with a maximum-length name. */
const MAX_ENUM_BYTES = MAX_PRINTERS * (PRINTER_INFO_4_BYTES + MAX_NAME_BYTES);
/** `GetDefaultPrinterW` counts characters including the terminating NUL. */
const DEFAULT_PRINTER_BUFFER_CHARS = MAX_PRINTER_NAME_CHARS + 1;

/** Open winspool.drv; the caller owns the returned library and closes it on dispose. */
export function openWinspool() {
  return dlopen("winspool.drv", {
    EnumPrintersW: {
      args: [
        "u32",
        "ptr",
        "u32",
        "ptr",
        "u32",
        "ptr",
        "ptr",
      ],
      returns: "i32",
    },
    GetDefaultPrinterW: {
      args: [
        "ptr",
        "ptr",
      ],
      returns: "i32",
    },
  });
}

/** The native calls the printer reads need. Buffers stay alive for the duration of each synchronous call. */
export interface PrinterBindings {
  /** `EnumPrintersW` at level 4 with the given flags; `buffer` is null for the size query. */
  enumPrinters(
    flags: number,
    buffer: Buffer | null,
    needed: Uint32Array,
    returned: Uint32Array,
  ): number;
  /** `GetDefaultPrinterW`; `chars` holds the buffer size in characters and receives the length including NUL. */
  getDefaultPrinter(buffer: Buffer, chars: Uint32Array): number;
  /** The calling thread's last Win32 error. */
  lastError(): number;
}

function failure(message: string): never {
  throw new BunawayError({
    code: "INTERNAL",
    message,
  });
}

/** Adapt the loaded winspool symbols and `GetLastError` to the narrow interface above. */
export function printerBindings(
  winspool: ReturnType<typeof openWinspool>,
  lastError: () => number,
): PrinterBindings {
  return {
    enumPrinters(flags, buffer, needed, returned) {
      return winspool.symbols.EnumPrintersW(
        flags,
        null,
        PRINTER_INFO_LEVEL_4,
        buffer === null ? null : ptr(buffer),
        buffer === null ? 0 : buffer.length,
        ptr(needed),
        ptr(returned),
      );
    },
    getDefaultPrinter(buffer, chars) {
      return winspool.symbols.GetDefaultPrinterW(ptr(buffer), ptr(chars));
    },
    lastError,
  };
}

/**
 * Read the NUL-terminated UTF-16 name entry `entry` points at. The pointer is an absolute
 * address inside the enumeration buffer, so it becomes an offset that must land in the string
 * area after the entry array, on a character boundary, with its terminator before `bytes`.
 */
function readPrinterName(
  buffer: Buffer,
  address: bigint,
  bytes: number,
  entryBytes: number,
  entry: number,
): string {
  const offset = buffer.readBigUInt64LE(entry * PRINTER_INFO_4_BYTES) - address;
  if (
    offset < BigInt(entryBytes) ||
    offset >= BigInt(bytes) ||
    offset % 2n !== 0n
  ) {
    failure("Windows printer list is malformed.");
  }
  const start = Number(offset);
  const limit = Math.min(bytes, start + MAX_NAME_BYTES);
  for (let end = start; end + 2 <= limit; end += 2) {
    if (buffer.readUInt16LE(end) === 0) {
      if (end === start) {
        break;
      }
      return buffer.toString("utf16le", start, end);
    }
  }
  return failure("Windows printer list is malformed.");
}

function parsePrinters(
  buffer: Buffer | null,
  bytes: number,
  count: number,
): string[] {
  if (count === 0) {
    return [];
  }
  const entryBytes = count * PRINTER_INFO_4_BYTES;
  if (
    buffer === null ||
    count > MAX_PRINTERS ||
    bytes > buffer.length ||
    entryBytes > bytes
  ) {
    return failure("Windows printer list is malformed.");
  }
  const address = BigInt(ptr(buffer));
  const names: string[] = [];
  for (let entry = 0; entry < count; entry += 1) {
    names.push(readPrinterName(buffer, address, bytes, entryBytes, entry));
  }
  return names;
}

/**
 * Names of the local and connected printers in the order Windows enumerates them. The size is
 * asked first and the call repeated when printers were added in between. Level 4 returns only
 * name, server and attributes, so it does not contact print servers the way the detailed levels
 * do. More than `MAX_PRINTERS` printers are an error instead of a silently shortened list.
 */
export function listPrinterNames(bindings: PrinterBindings): string[] {
  const flags = PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS;
  const needed = new Uint32Array(1);
  const returned = new Uint32Array(1);
  let buffer: Buffer | null = null;
  for (let attempt = 0; attempt < MAX_ENUM_ATTEMPTS; attempt += 1) {
    const error = win32CallError(() => {
      needed[0] = 0;
      returned[0] = 0;
      return bindings.enumPrinters(flags, buffer, needed, returned);
    }, bindings.lastError);
    if (error === 0) {
      return parsePrinters(buffer, needed[0] ?? 0, returned[0] ?? 0);
    }
    const size = needed[0] ?? 0;
    if (
      error !== ERROR_INSUFFICIENT_BUFFER ||
      size === 0 ||
      size > MAX_ENUM_BYTES
    ) {
      failure("Windows printer list query failed.");
    }
    buffer = Buffer.alloc(size);
  }
  return failure("Windows printer list changed during the query.");
}

/** The default printer's name, or null when the user has none (no printers or none chosen). */
export function defaultPrinterName(bindings: PrinterBindings): string | null {
  const buffer = Buffer.alloc(DEFAULT_PRINTER_BUFFER_CHARS * 2);
  const chars = new Uint32Array(1);
  const error = win32CallError(() => {
    chars[0] = DEFAULT_PRINTER_BUFFER_CHARS;
    return bindings.getDefaultPrinter(buffer, chars);
  }, bindings.lastError);
  if (error === ERROR_FILE_NOT_FOUND) {
    return null;
  }
  const length = chars[0] ?? 0;
  if (
    error !== 0 ||
    length < 2 ||
    length > DEFAULT_PRINTER_BUFFER_CHARS ||
    buffer.readUInt16LE((length - 1) * 2) !== 0
  ) {
    failure("Windows default printer query failed.");
  }
  return buffer.toString("utf16le", 0, (length - 1) * 2);
}

/** Printer names compare case-insensitively on Windows. */
export function samePrinter(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}
