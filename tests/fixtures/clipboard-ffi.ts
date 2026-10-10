import { ptr, toArrayBuffer } from "bun:ffi";
export { ptr, toArrayBuffer };

// Process-local Win32 replacement. Real native allocations are represented by
// retained Buffers so the production pointer copy and UTF-16 decoder still run.
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
        return null;
      }
      state.windows++;
      return 1;
    },
    DestroyWindow() {
      state.windows--;
      return true;
    },
    GetModuleHandleW() {
      return 1;
    },
    OpenClipboard(owner: number) {
      if (!owner) {
        throw new Error("Missing owner");
      }
      if (state.occupied) {
        return false;
      }
      state.opened = true;
      return true;
    },
    CloseClipboard() {
      if (!succeeds("close")) {
        return false;
      }
      state.opened = false;
      return true;
    },
    EmptyClipboard() {
      if (!succeeds("empty")) {
        return false;
      }
      state.clears++;
      state.format = false;
      return true;
    },
    IsClipboardFormatAvailable() {
      return state.format;
    },
    GetClipboardData() {
      return succeeds("get") ? ptr(state.data) : null;
    },
    SetClipboardData(_format: number, handle: number) {
      if (!succeeds("set")) {
        return null;
      }
      const data = state.allocations.get(handle);
      if (!data) {
        throw new Error("Unknown allocation");
      }
      state.data = data;
      state.allocations.delete(handle);
      state.transferred++;
      state.format = true;
      return handle;
    },
    GlobalSize() {
      return state.data.byteLength;
    },
    GlobalAlloc(_flags: number, size: number) {
      if (!succeeds("alloc")) {
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
      return false;
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
