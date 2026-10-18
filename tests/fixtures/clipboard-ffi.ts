import { ptr, toArrayBuffer } from "bun:ffi";

export { ptr, toArrayBuffer };

// Process-local Win32 replacement. Real native allocations are represented by
// retained Buffers so the production pointer copy and UTF-16 decoder still run.
// Results follow the shared tables: BOOL is an i32 and window handles are u64.
const initialData: Buffer = Buffer.from("old\0", "utf16le");
export const state = {
  fail: "",
  occupied: false,
  opened: false,
  windows: 0,
  libraries: 0,
  locks: 0,
  frees: 0,
  transferred: 0,
  clears: 0,
  format: true,
  data: initialData,
  allocations: new Map<number, Buffer>(),
  formats: new Map<number, Buffer>(),
  registered: new Map<string, number>(),
  failAtAllocation: 0,
  allocationCalls: 0,
  failAtSet: 0,
  setCalls: 0,
};
const succeeds = (name: string) => state.fail !== name;
export function dlopen(name: string) {
  if (!succeeds(name)) {
    throw new Error("DLL load failed");
  }
  state.libraries++;
  const symbols = {
    CreateWindowExW() {
      if (!succeeds("create")) {
        return 0n;
      }
      state.windows++;
      return 1n;
    },
    DestroyWindow() {
      state.windows--;
      return 1;
    },
    GetModuleHandleW() {
      return 1n;
    },
    OpenClipboard(owner: bigint) {
      if (!owner) {
        throw new Error("Missing owner");
      }
      if (state.occupied) {
        return 0;
      }
      state.opened = true;
      return 1;
    },
    CloseClipboard() {
      if (!succeeds("close")) {
        return 0;
      }
      state.opened = false;
      return 1;
    },
    EmptyClipboard() {
      if (!succeeds("empty")) {
        return 0;
      }
      state.clears++;
      state.format = false;
      state.formats.clear();
      return 1;
    },
    IsClipboardFormatAvailable(format: number) {
      const available =
        format === 13 ? state.format : state.formats.has(format);
      return available ? 1 : 0;
    },
    GetClipboardData(format: number) {
      const bytes = format === 13 ? state.data : state.formats.get(format);
      return succeeds("get") && bytes ? ptr(bytes) : null;
    },
    SetClipboardData(format: number, handle: number) {
      state.setCalls++;
      if (!succeeds("set") || state.setCalls === state.failAtSet) {
        return null;
      }
      const data = state.allocations.get(handle);
      if (!data) {
        throw new Error("Unknown allocation");
      }
      if (format === 13) {
        state.data = data;
        state.format = true;
      } else {
        state.formats.set(format, data);
      }
      state.allocations.delete(handle);
      state.transferred++;
      return handle;
    },
    RegisterClipboardFormatW(address: number) {
      if (!succeeds("register")) {
        return 0;
      }
      const bytes: number[] = [];
      for (let offset = 0; ; offset += 2) {
        const pair = new Uint8Array(toArrayBuffer(address, offset, 2));
        if (pair[0] === 0 && pair[1] === 0) {
          break;
        }
        bytes.push(pair[0] ?? 0, pair[1] ?? 0);
      }
      const key = Buffer.from(bytes).toString("utf16le");
      const existing = state.registered.get(key);
      if (existing !== undefined) {
        return existing;
      }
      const format = 0xc000 + state.registered.size;
      state.registered.set(key, format);
      return format;
    },
    GlobalSize(handle: number) {
      const bytes = [
        ...state.formats.values(),
        ...state.allocations.values(),
        state.data,
      ].find((value) => ptr(value) === handle);
      if (!bytes) {
        throw new Error("Unknown borrowed handle");
      }
      return bytes.byteLength;
    },
    GlobalAlloc(_flags: number, size: number) {
      state.allocationCalls++;
      if (
        !succeeds("alloc") ||
        state.allocationCalls === state.failAtAllocation
      ) {
        return null;
      }
      const data = Buffer.alloc(size);
      const handle = ptr(data);
      state.allocations.set(handle, data);
      return handle;
    },
    GlobalFree(handle: number) {
      state.frees++;
      state.allocations.delete(handle);
      return null;
    },
    GlobalLock(handle: number) {
      if (!succeeds("lock")) {
        return null;
      }
      state.locks++;
      return handle;
    },
    GlobalUnlock() {
      state.locks--;
      return 0;
    },
    SetLastError() {},
    GetLastError() {
      return 0;
    },
  };
  return {
    symbols,
    close() {
      state.libraries--;
    },
  };
}
