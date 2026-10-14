import {
  CFunction,
  dlopen,
  JSCallback,
  type Pointer,
  ptr,
  read,
  toArrayBuffer,
} from "bun:ffi";
import { BunawayError } from "@bunaway/plugin";

const CLSCTX_INPROC_SERVER = 1;
const DRIVE_FIXED = 3;
const E_ABORT = -2147467260;
const E_NOINTERFACE = -2147467262;
const E_POINTER = -2147467261;
const TSF_DELETE_RECYCLE_IF_POSSIBLE = 0x80;
const FOF_SILENT = 0x4;
const FOF_NOCONFIRMATION = 0x10;
const FOF_NOERRORUI = 0x400;
const FOF_NO_CONNECTED_ELEMENTS = 0x2000;
const FOF_WANTNUKEWARNING = 0x4000;
const FOFX_RECYCLEONDELETE = 0x80000;
const FOFX_EARLYFAILURE = 0x100000;
const FOFX_NOCOPYHOOKS = 0x800000;
const SLOT = {
  release: 2,
  setFlags: 5,
  deleteItem: 18,
  perform: 21,
  aborted: 22,
} as const;

function guid(value: string): Buffer {
  const bytes = Buffer.from(value.replaceAll("-", ""), "hex");
  bytes.subarray(0, 4).reverse();
  bytes.subarray(4, 6).reverse();
  bytes.subarray(6, 8).reverse();
  return bytes;
}
const CLSID_FILE_OPERATION = guid("3ad05575-8857-4850-9277-11b85bdb8e09");
const IID_FILE_OPERATION = guid("947aab5f-0a5c-4c13-b4d6-4bf7836fc9f8");
const IID_SHELL_ITEM = guid("43826d1e-e718-42ee-bc55-a1e261c37bfe");
const IID_PROGRESS_SINK = guid("04b0f1a7-9490-44bc-96e1-4296a31252e2");
const IID_UNKNOWN = guid("00000000-0000-0000-c000-000000000046");

function checkSinkReferences(refs: number): void {
  if (refs !== 1) {
    throw new Error("Windows trash progress sink retained native references.");
  }
}

function failed(): BunawayError {
  return new BunawayError({
    code: "INTERNAL",
    message: "Windows could not recycle the file.",
  });
}
function checkResult(result: number): void {
  if (result >= 0) {
    return;
  }
  const code = result >>> 0;
  if (code === 0x80070005 || code === 0x80070020) {
    throw new BunawayError({
      code: "PERMISSION_DENIED",
      message: "Windows denied recycling the file.",
    });
  }
  if (code === 0x80070002 || code === 0x80070003) {
    throw new BunawayError({
      code: "INVALID_ARGUMENT",
      message: "Opener file not found.",
      details: {
        reason: "FILE_NOT_FOUND",
      },
    });
  }
  throw failed();
}

/** Own a synchronous COM progress sink, requiring recycle flags and complete results. */
export function createTrashProgressSink(verifyIdentity: () => void) {
  const callbacks: JSCallback[] = [];
  let callbackFailure: unknown;
  let recycled = false;
  let preDeleteCalls = 0;
  let postDeleteCalls = 0;
  let refs = 1;
  const object = new BigUint64Array(1);
  const callback = (
    args: ("ptr" | "u32" | "i32")[],
    run: (...values: number[]) => number,
  ) => {
    const binding = new JSCallback(
      (...values: number[]) => {
        try {
          return run(...values);
        } catch (error) {
          callbackFailure ??= error;
          return E_ABORT;
        }
      },
      {
        args: [
          "ptr",
          ...args,
        ],
        returns: "i32",
      },
    );
    callbacks.push(binding);
    return BigInt(binding.ptr ?? 0);
  };
  // IFileOperationProgressSink has 19 vtable slots including IUnknown.
  const vtable = (() => {
    try {
      return new BigUint64Array([
        callback(
          [
            "ptr",
            "ptr",
          ],
          (_self, requested, out) => {
            if (!out) {
              return E_POINTER;
            }
            const output = new DataView(toArrayBuffer(out as Pointer, 0, 8));
            output.setBigUint64(0, 0n, true);
            if (!requested) {
              return E_POINTER;
            }
            const iid = Buffer.from(toArrayBuffer(requested as Pointer, 0, 16));
            if (!iid.equals(IID_UNKNOWN) && !iid.equals(IID_PROGRESS_SINK)) {
              return E_NOINTERFACE;
            }
            output.setBigUint64(0, BigInt(ptr(object)), true);
            refs++;
            return 0;
          },
        ),
        callback([], () => ++refs),
        callback([], () => --refs),
        callback([], () => 0), // StartOperations
        callback(
          [
            "i32",
          ],
          () => 0,
        ), // FinishOperations; per-item status is checked below.
        callback(
          [
            "u32",
            "ptr",
            "ptr",
          ],
          () => E_ABORT,
        ), // PreRenameItem
        callback(
          [
            "u32",
            "ptr",
            "ptr",
            "i32",
            "ptr",
          ],
          () => E_ABORT,
        ),
        callback(
          [
            "u32",
            "ptr",
            "ptr",
            "ptr",
          ],
          () => E_ABORT,
        ), // PreMoveItem
        callback(
          [
            "u32",
            "ptr",
            "ptr",
            "ptr",
            "i32",
            "ptr",
          ],
          () => E_ABORT,
        ),
        callback(
          [
            "u32",
            "ptr",
            "ptr",
            "ptr",
          ],
          () => E_ABORT,
        ), // PreCopyItem
        callback(
          [
            "u32",
            "ptr",
            "ptr",
            "ptr",
            "i32",
            "ptr",
          ],
          () => E_ABORT,
        ),
        callback(
          [
            "u32",
            "ptr",
          ],
          (_self, flags) => {
            // Veto callbacks without recycle intent, including a retry after failure.
            if (
              ++preDeleteCalls !== 1 ||
              !(flags & TSF_DELETE_RECYCLE_IF_POSSIBLE)
            ) {
              callbackFailure ??= new BunawayError({
                code: "UNSUPPORTED",
                message: "Windows cannot recycle this file.",
              });
              return E_ABORT;
            }
            verifyIdentity();
            return 0;
          },
        ),
        callback(
          [
            "u32",
            "ptr",
            "i32",
            "ptr",
          ],
          (_self, _flags, _item, result, newItem) => {
            postDeleteCalls++;
            checkResult(result);
            // A null new item means permanent deletion. Never report that as trash success.
            recycled = !!newItem;
            if (!recycled) {
              throw failed();
            }
            return 0;
          },
        ),
        callback(
          [
            "u32",
            "ptr",
            "ptr",
          ],
          () => E_ABORT,
        ), // PreNewItem
        callback(
          [
            "u32",
            "ptr",
            "ptr",
            "ptr",
            "u32",
            "i32",
            "ptr",
          ],
          () => E_ABORT,
        ),
        callback(
          [
            "u32",
            "u32",
          ],
          () => 0,
        ), // UpdateProgress
        callback([], () => 0), // ResetTimer
        callback([], () => 0), // PauseTimer
        callback([], () => 0), // ResumeTimer
      ]);
    } catch (error) {
      for (const binding of callbacks) {
        binding.close();
      }
      throw error;
    }
  })();
  object[0] = BigInt(ptr(vtable));
  let disposed = false;
  return {
    pointer: ptr(object),
    checkFailure(): void {
      if (callbackFailure) {
        throw callbackFailure;
      }
    },
    complete(aborted: boolean): void {
      if (callbackFailure) {
        throw callbackFailure;
      }
      if (
        aborted ||
        !recycled ||
        preDeleteCalls !== 1 ||
        postDeleteCalls !== 1
      ) {
        throw failed();
      }
    },
    dispose(): void {
      if (disposed) {
        return;
      }
      checkSinkReferences(refs);
      disposed = true;
      for (const binding of callbacks) {
        binding.close();
      }
      // Own the vtable and object buffers until native references have drained.
      object.fill(0n);
      vtable.fill(0n);
    },
  };
}

/** Reject remote and removable paths before filesystem access or Shell queuing. */
export function validateTrashDrive(path: string): void {
  const kernel = dlopen("kernel32.dll", {
    GetDriveTypeW: {
      args: [
        "ptr",
      ],
      returns: "u32",
    },
  });
  try {
    if (
      path.startsWith("\\\\") ||
      kernel.symbols.GetDriveTypeW(
        ptr(Buffer.from(`${path.slice(0, 3)}\0`, "utf16le")),
      ) !== DRIVE_FIXED
    ) {
      throw new BunawayError({
        code: "UNSUPPORTED",
        message: "Recycling requires a local fixed drive.",
      });
    }
  } finally {
    kernel.close();
  }
}

/**
 * Recycle a checked file on the opener's initialized I/O STA. Own and release every
 * interface, callback and binding within this synchronous operation, before COM teardown.
 */
export function trashWindowsFile(
  path: string,
  verifyIdentity: () => void,
): void {
  const ole = dlopen("ole32.dll", {
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
  });
  const shell = (() => {
    try {
      return dlopen("shell32.dll", {
        SHCreateItemFromParsingName: {
          args: [
            "ptr",
            "ptr",
            "ptr",
            "ptr",
          ],
          returns: "i32",
        },
      });
    } catch (error) {
      ole.close();
      throw error;
    }
  })();
  const bindings: ReturnType<typeof CFunction>[] = [];
  const releases: (() => void)[] = [];
  const method = (object: Pointer, slot: number, args: ("ptr" | "u32")[]) => {
    const address = read.ptr(read.ptr(object), slot * 8);
    if (!address) {
      throw failed();
    }
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
  const objectFrom = (create: (out: Pointer) => number): Pointer => {
    const out = new BigUint64Array(1);
    checkResult(create(ptr(out)));
    if (!out[0]) {
      throw failed();
    }
    const object = Number(out[0]) as Pointer;
    const release = method(object, SLOT.release, []);
    releases.push(() => release());
    return object;
  };
  const sink = (() => {
    try {
      return createTrashProgressSink(verifyIdentity);
    } catch (error) {
      shell.close();
      ole.close();
      throw error;
    }
  })();
  try {
    const operation = objectFrom((out) =>
      ole.symbols.CoCreateInstance(
        ptr(CLSID_FILE_OPERATION),
        null,
        CLSCTX_INPROC_SERVER,
        ptr(IID_FILE_OPERATION),
        out,
      ),
    );
    const item = objectFrom((out) =>
      shell.symbols.SHCreateItemFromParsingName(
        ptr(Buffer.from(`${path}\0`, "utf16le")),
        null,
        ptr(IID_SHELL_ITEM),
        out,
      ),
    );
    // Ask Windows to recycle, suppress companion deletion and copy hooks, and retain
    // permanent-delete warnings. Missing recycle flags are vetoed by our sink; a
    // recycled-item result is also required. Do not add a framework delete fallback.
    checkResult(
      method(operation, SLOT.setFlags, [
        "u32",
      ])(
        FOF_SILENT |
          FOF_NOCONFIRMATION |
          FOF_NOERRORUI |
          FOF_NO_CONNECTED_ELEMENTS |
          FOF_WANTNUKEWARNING |
          FOFX_RECYCLEONDELETE |
          FOFX_EARLYFAILURE |
          FOFX_NOCOPYHOOKS,
      ),
    );
    checkResult(
      method(operation, SLOT.deleteItem, [
        "ptr",
        "ptr",
      ])(item, sink.pointer),
    );
    const result = method(operation, SLOT.perform, [])();
    sink.checkFailure();
    checkResult(result);
    const aborted = new Int32Array(1);
    checkResult(
      method(operation, SLOT.aborted, [
        "ptr",
      ])(ptr(aborted)),
    );
    sink.complete(!!aborted[0]);
  } finally {
    // Release both items and IFileOperation: the latter owns the per-item sink.
    for (const release of releases.reverse()) {
      release();
    }
    for (const binding of bindings) {
      binding.close();
    }
    // Keep backing memory alive through Release and close callbacks only afterwards.
    try {
      sink.dispose();
    } finally {
      shell.close();
      ole.close();
    }
  }
}
