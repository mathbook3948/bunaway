import { dlopen, ptr } from "bun:ffi";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  BunawayError,
  type JsonValue,
  type NativeAdapter,
  type NativeEnvironment,
} from "@bunaway/plugin";
import type { StorageLocation, StorageWrite } from "./index.ts";

export function createOperations(environment: NativeEnvironment): NativeAdapter {
  const storage = new ScopedStorage(environment.dataRoot);
  return {
    execute(operation: string, input: JsonValue): JsonValue {
      const location = input as StorageLocation;
      return storage.execute(
        location.scope,
        location.path,
        operation === "storage.writeText" ? (input as StorageWrite).text : undefined,
      );
    },
    dispose: disposeStorageBindings,
  };
}

const wide = (text: string) => Buffer.from(`${text}\0`, "utf16le");
const api = dlopen("kernel32.dll", {
  CreateFileW: { args: ["ptr", "u32", "u32", "ptr", "u32", "u32", "u64"], returns: "u64" },
  CreateDirectoryW: { args: ["ptr", "ptr"], returns: "i32" },
  GetLastError: { args: [], returns: "u32" },
  GetFileInformationByHandle: { args: ["u64", "ptr"], returns: "i32" },
  GetFinalPathNameByHandleW: { args: ["u64", "ptr", "u32", "u32"], returns: "u32" },
  GetFileSizeEx: { args: ["u64", "ptr"], returns: "i32" },
  ReadFile: { args: ["u64", "ptr", "u32", "ptr", "ptr"], returns: "i32" },
  WriteFile: { args: ["u64", "ptr", "u32", "ptr", "ptr"], returns: "i32" },
  SetEndOfFile: { args: ["u64"], returns: "i32" },
  CloseHandle: { args: ["u64"], returns: "i32" },
});
const deny = (message: string): never => {
  throw new BunawayError({ code: "PERMISSION_DENIED", message });
};
function check(value: number | bigint, message: string) {
  if (!value) throw new Error(message);
}
export class ScopedStorage {
  private readonly roots: Record<"appData" | "temp", string>;
  constructor(dataRoot: string) {
    const root = (name: string) => {
      const path = resolve(dataRoot, name);
      mkdirSync(path, { recursive: true });
      const handle = this.open(path, 0, 7, 3, 0x02200000);
      try {
        if (this.info(handle).readUInt32LE(0) & 0x400) deny("Scope root must not be a link.");
        return this.canonical(handle);
      } finally {
        this.close(handle);
      }
    };
    this.roots = { appData: root("data"), temp: root("temp") };
  }
  private close(handle: bigint) {
    check(api.symbols.CloseHandle(handle), "CloseHandle failed");
  }
  private open(
    path: string,
    access: number,
    share: number,
    disposition: number,
    flags: number,
  ): bigint {
    const handle = api.symbols.CreateFileW(
      ptr(wide(path)),
      access,
      share,
      null,
      disposition,
      flags,
      0n,
    );
    if (handle === 0n || handle === 0xffffffffffffffffn) {
      const code = api.symbols.GetLastError();
      if (code === 2 || code === 3)
        throw new BunawayError({ code: "INVALID_ARGUMENT", message: "Storage target not found." });
      throw new Error(`Storage open failed (${code})`);
    }
    return handle;
  }
  private info(handle: bigint) {
    const info = Buffer.alloc(52);
    check(api.symbols.GetFileInformationByHandle(handle, ptr(info)), "Storage stat failed");
    return info;
  }
  private canonical(handle: bigint) {
    const text = Buffer.alloc(65536);
    const length = api.symbols.GetFinalPathNameByHandleW(handle, ptr(text), 32768, 0);
    if (!length || length >= 32768) throw new Error("Storage path check failed");
    return text.subarray(0, length * 2).toString("utf16le");
  }
  execute(scope: "appData" | "temp", path: string, text?: string): string | null {
    const segments = path.split("/");
    if (
      !segments.length ||
      segments.some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          Buffer.byteLength(part) > 255 ||
          /[<>:"|?*\\]/.test(part) ||
          [...part].some((character) => character.charCodeAt(0) < 32) ||
          /[ .]$/.test(part),
      )
    )
      throw new BunawayError({ code: "INVALID_ARGUMENT", message: "Invalid storage path." });
    const root = this.roots[scope];
    if (!root) deny("Unknown storage scope.");
    const parents: bigint[] = [];
    let file = 0n;
    try {
      let dir = root;
      // No write/delete sharing: every checked parent stays pinned through final I/O.
      for (let index = 0; index < segments.length; index++) {
        if (index) {
          dir += `\\${segments[index - 1]}`;
          if (
            text !== undefined &&
            !api.symbols.CreateDirectoryW(ptr(wide(dir)), null) &&
            api.symbols.GetLastError() !== 183
          )
            throw new Error("Storage directory creation failed");
        }
        const parent = this.open(dir, 0x80, 1, 3, 0x02200000);
        parents.push(parent);
        const attributes = this.info(parent).readUInt32LE(0);
        if (attributes & 0x400 || !(attributes & 0x10))
          deny("Storage path is not a plain directory.");
      }
      file = this.open(
        `${root}\\${segments.join("\\")}`,
        text === undefined ? 0x80000000 : 0x40000000,
        7,
        text === undefined ? 3 : 4,
        0x00200000,
      );
      const info = this.info(file);
      if (info.readUInt32LE(0) & 0x410 || info.readUInt32LE(40) > 1)
        deny("Storage target is not a plain in-scope file.");
      const actual = this.canonical(file);
      if (!actual.toLowerCase().startsWith(`${root}\\`.toLowerCase()))
        deny("Storage target is outside the named scope.");
      const transferred = new Uint32Array(1);
      if (text !== undefined) {
        const bytes = Buffer.from(text);
        let offset = 0;
        while (offset < bytes.length) {
          check(
            api.symbols.WriteFile(
              file,
              ptr(bytes.subarray(offset)),
              Math.min(bytes.length - offset, 1 << 20),
              ptr(transferred),
              null,
            ),
            "Storage write failed",
          );
          if (!transferred[0]) throw new Error("Storage write made no progress");
          offset += transferred[0];
        }
        check(api.symbols.SetEndOfFile(file), "Storage truncate failed");
        return null;
      }
      const size = new BigInt64Array(1);
      check(api.symbols.GetFileSizeEx(file, ptr(size)), "Storage size failed");
      if (size[0] === undefined || size[0] < 0n || size[0] > 4n * 1024n * 1024n)
        throw new Error("Storage file too large");
      return readStorageText(file, Number(size[0]));
    } finally {
      if (file) this.close(file);
      for (const parent of parents.reverse()) this.close(parent);
    }
  }
}
export function disposeStorageBindings() {
  api.close();
}

export function readStorageText(file: bigint, size: number): string {
  if (!Number.isSafeInteger(size) || size < 0 || size > 4 * 1024 * 1024)
    throw new Error("Storage file too large");
  const bytes = Buffer.alloc(size);
  const transferred = new Uint32Array(1);
  let offset = 0;
  while (offset < bytes.length) {
    check(
      api.symbols.ReadFile(
        file,
        ptr(bytes.subarray(offset)),
        bytes.length - offset,
        ptr(transferred),
        null,
      ),
      "Storage read failed",
    );
    if (!transferred[0]) throw new Error("Storage file changed during read");
    offset += transferred[0];
  }
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}
