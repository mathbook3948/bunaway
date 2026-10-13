import {
  CFunction,
  dlopen,
  type Pointer,
  ptr,
  read,
  toArrayBuffer,
} from "bun:ffi";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

// Windows SDK GUIDs in the byte order of the COM ABI.
const CLSID_SHELL_LINK = Buffer.from("0114020000000000c000000000000046", "hex");
const IID_SHELL_LINK_W = Buffer.from("f914020000000000c000000000000046", "hex");
const IID_PERSIST_FILE = Buffer.from("0b01000000000000c000000000000046", "hex");
const IID_PROPERTY_STORE = Buffer.from(
  "eb8e6d88f28c46448d02cdba1dbdcf99",
  "hex",
);
const FOLDERID_PROGRAMS = Buffer.from(
  "775d7fa72b2ec344a6a2aba601054a51",
  "hex",
);
const PKEY_APP_USER_MODEL_ID = Buffer.from(
  "55284c9f799f394ba8d0e1d42de1d5f305000000",
  "hex",
);
const VT_LPWSTR = 31;
const POINTER_BYTES = 8;
const MAX_TEXT_CHARACTERS = 32768;
const SHCNE_CREATE = 0x2;
const SHCNE_DELETE = 0x4;
const SHCNF_PATHW = 0x5;

function wide(value: string): Buffer {
  return Buffer.from(`${value}\0`, "utf16le");
}
function text(address: Pointer): string {
  let characters = 0;
  while (
    characters < MAX_TEXT_CHARACTERS &&
    read.u16(address, characters * 2)
  ) {
    characters++;
  }
  assert(characters < MAX_TEXT_CHARACTERS, "Unterminated native shortcut text");
  return Buffer.from(toArrayBuffer(address, 0, characters * 2)).toString(
    "utf16le",
  );
}

/**
 * Create one UUID-named current-user Start Menu shortcut with the installer's AppUserModelID property.
 * Run only in a fresh fixture process: the process identity persists until that process exits.
 * The returned cleanup removes only our shortcut; no activator, association or production registration is written.
 */
export async function createNotificationShortcut(appId: string) {
  assert(
    /^test\.[a-f0-9-]{36}$/.test(appId),
    "Only fixture UUID identities may be registered",
  );
  const ole = dlopen("ole32.dll", {
    CoInitializeEx: {
      args: [
        "ptr",
        "u32",
      ],
      returns: "i32",
    },
    CoUninitialize: {
      args: [],
      returns: "void",
    },
    CoCreateInstance: {
      args: [
        "ptr",
        "ptr",
        "u32",
        "ptr",
        "ptr",
      ],
      returns: "i32",
    },
    CoTaskMemFree: {
      args: [
        "ptr",
      ],
      returns: "void",
    },
  });
  const shell = (() => {
    try {
      return dlopen("shell32.dll", {
        SetCurrentProcessExplicitAppUserModelID: {
          args: [
            "ptr",
          ],
          returns: "i32",
        },
        GetCurrentProcessExplicitAppUserModelID: {
          args: [
            "ptr",
          ],
          returns: "i32",
        },
        SHGetKnownFolderPath: {
          args: [
            "ptr",
            "u32",
            "ptr",
            "ptr",
          ],
          returns: "i32",
        },
        SHChangeNotify: {
          args: [
            "i32",
            "u32",
            "ptr",
            "ptr",
          ],
          returns: "void",
        },
      });
    } catch (error) {
      ole.close();
      throw error;
    }
  })();
  let initialized = false;
  let path: string | undefined;
  const objects: Pointer[] = [];
  const bindings: ReturnType<typeof CFunction>[] = [];
  const method = (
    object: Pointer,
    slot: number,
    args: ("ptr" | "i32")[] = [],
  ) => {
    const address = read.ptr(read.ptr(object), slot * POINTER_BYTES);
    assert(address, "Missing shortcut COM method");
    const binding = CFunction({
      ptr: address as Pointer,
      args: [
        "ptr",
        ...args,
      ],
      returns: "i32",
    });
    bindings.push(binding);
    return (...values: (number | null)[]) => Number(binding(object, ...values));
  };
  const own = (invoke: (output: Pointer) => number): Pointer => {
    const output = new BigUint64Array(1);
    assert(invoke(ptr(output)) >= 0, "Shortcut COM operation failed");
    assert(output[0], "Missing shortcut COM object");
    // An owned Win64 interface pointer occupies the eight-byte out slot.
    const object = Number(output[0]) as Pointer;
    objects.push(object);
    return object;
  };
  const query = (object: Pointer, iid: Buffer) =>
    own((output) =>
      method(object, 0, [
        "ptr",
        "ptr",
      ])(ptr(iid), output),
    );
  const allocatedText = (invoke: (output: Pointer) => number) => {
    const output = new BigUint64Array(1);
    const result = invoke(ptr(output));
    const address = Number(output[0]) as Pointer;
    try {
      assert(result >= 0, "Shortcut identity lookup failed");
      assert(address);
      return text(address);
    } finally {
      if (address) {
        ole.symbols.CoTaskMemFree(address);
      }
    }
  };
  let closed = false;
  const cleanup = async () => {
    if (closed) {
      return;
    }
    try {
      if (path) {
        await rm(path, {
          force: true,
        });
        shell.symbols.SHChangeNotify(
          SHCNE_DELETE,
          SHCNF_PATHW,
          ptr(wide(path)),
          null,
        );
        path = undefined;
      }
    } finally {
      closed = true;
      shell.close();
    }
  };
  try {
    try {
      // The real UI host sets this before UI ready and backend setup. Assign the same ID in this isolated process.
      assert(
        shell.symbols.SetCurrentProcessExplicitAppUserModelID(
          ptr(wide(appId)),
        ) >= 0,
      );
      assert.equal(
        allocatedText((output) =>
          shell.symbols.GetCurrentProcessExplicitAppUserModelID(output),
        ),
        appId,
      );
      const programs = allocatedText((output) =>
        shell.symbols.SHGetKnownFolderPath(
          ptr(FOLDERID_PROGRAMS),
          0,
          null,
          output,
        ),
      );
      await mkdir(programs, {
        recursive: true,
      });
      const candidate = join(programs, `bunaway-notification-${appId}.lnk`);
      assert(!existsSync(candidate), "Never replace an existing shortcut");
      path = candidate;
      assert(ole.symbols.CoInitializeEx(null, 2) >= 0);
      initialized = true;
      const link = own((output) =>
        ole.symbols.CoCreateInstance(
          ptr(CLSID_SHELL_LINK),
          null,
          1,
          ptr(IID_SHELL_LINK_W),
          output,
        ),
      );
      assert(
        method(link, 20, [
          "ptr",
        ])(ptr(wide(process.execPath))) >= 0,
        "Shortcut target failed",
      );
      const properties = query(link, IID_PROPERTY_STORE);
      const identity = wide(appId);
      const variant = Buffer.alloc(24);
      variant.writeUInt16LE(VT_LPWSTR);
      variant.writeBigUInt64LE(BigInt(ptr(identity)), 8);
      assert(
        method(properties, 6, [
          "ptr",
          "ptr",
        ])(ptr(PKEY_APP_USER_MODEL_ID), ptr(variant)) >= 0,
        "Shortcut AppUserModelID failed",
      );
      assert(method(properties, 7)() >= 0, "Shortcut properties commit failed");
      const persistent = query(link, IID_PERSIST_FILE);
      assert(
        method(persistent, 6, [
          "ptr",
          "i32",
        ])(ptr(wide(path)), 1) >= 0,
        "Shortcut save failed",
      );
      shell.symbols.SHChangeNotify(
        SHCNE_CREATE,
        SHCNF_PATHW,
        ptr(wide(path)),
        null,
      );
    } finally {
      try {
        for (const object of objects.reverse()) {
          method(object, 2)();
        }
      } finally {
        for (const binding of bindings) {
          binding.close();
        }
        if (initialized) {
          ole.symbols.CoUninitialize();
        }
        ole.close();
      }
    }
  } catch (error) {
    // Native objects and bindings have already been released before unloading their shell library.
    await cleanup();
    throw error;
  }
  return cleanup;
}
