import {
  CFunction,
  dlopen,
  JSCallback,
  type Pointer,
  ptr,
  read,
  toArrayBuffer,
} from "bun:ffi";
import { COMBASE, pick } from "@bunaway/plugin/win32";
import { BunawayError } from "@bunaway/protocol";

const POINTER_BYTES = 8;
const E_NOINTERFACE = -2147467262;
const E_POINTER = -2147467261;
const E_FAIL = -2147467259;
const IUNKNOWN = guid("00000000-0000-0000-c000-000000000046");
type Argument = number | bigint | null;
type Abi = "ptr" | "i32" | "u32" | "i64" | "u8";

/** Convert metadata GUID spelling to the Windows ABI byte order. */
export function guid(value: string): Buffer {
  const bytes = Buffer.from(value.replaceAll("-", ""), "hex");
  bytes.subarray(0, 4).reverse();
  bytes.subarray(4, 6).reverse();
  bytes.subarray(6, 8).reverse();
  return bytes;
}
// Windows.Foundation.DateTime counts 100 ns ticks since 1601-01-01 UTC.
const WINDOWS_EPOCH_OFFSET_MS = 11_644_473_600_000n;
const TICKS_PER_MS = 10_000n;
export const TICKS_PER_SECOND = 10_000_000n;

/** Convert epoch milliseconds to a Windows.Foundation.DateTime tick count. */
export function toWindowsTicks(epochMs: number): bigint {
  return (BigInt(epochMs) + WINDOWS_EPOCH_OFFSET_MS) * TICKS_PER_MS;
}

/** Convert a Windows.Foundation.DateTime tick count to epoch milliseconds, truncating sub-millisecond ticks. */
export function fromWindowsTicks(ticks: bigint): number {
  return Number(ticks / TICKS_PER_MS - WINDOWS_EPOCH_OFFSET_MS);
}

/** HRESULTs reported when the toast activator or its registration is missing on this system. */
const UNSUPPORTED_TOAST_HRESULTS = new Set([
  0x80040154,
  0x80040111,
  0x80004002,
  0x80070490,
]);
const E_ACCESSDENIED_HRESULT = 0x80070005;
const E_INVALIDARG_HRESULT = 0x80070057;

/** Map a failed toast HRESULT to the public error code. */
function toastFailureCode(
  hresult: number,
): "PERMISSION_DENIED" | "UNSUPPORTED" | "INTERNAL" {
  if (hresult === E_ACCESSDENIED_HRESULT) {
    return "PERMISSION_DENIED";
  }
  return UNSUPPORTED_TOAST_HRESULTS.has(hresult) ? "UNSUPPORTED" : "INTERNAL";
}

export function checkToast(result: number, stage: string): void {
  if (result >= 0) {
    return;
  }
  const hresult = result >>> 0;
  throw new BunawayError({
    code: toastFailureCode(hresult),
    message: "Windows toast operation failed.",
    details: {
      stage,
      hresult,
    },
  });
}

/**
 * Like `checkToast` for scheduling calls, where E_INVALIDARG means the delivery time was not acceptable
 * (for example it passed between the caller's check and the OS call), which is the caller's input error.
 */
export function checkSchedule(result: number, stage: string): void {
  if (result >>> 0 === E_INVALIDARG_HRESULT) {
    throw new BunawayError({
      code: "INVALID_ARGUMENT",
      message: "Windows rejected the notification delivery time.",
      details: {
        stage,
        hresult: result >>> 0,
      },
    });
  }
  checkToast(result, stage);
}

/** One persistent STA reference, with scoped HSTRINGs and COM method bindings. No import-time DLL loads. */
export function createToastRuntime() {
  const library = dlopen("combase.dll", {
    ...pick(
      COMBASE,
      "RoInitialize",
      "RoUninitialize",
      "RoGetActivationFactory",
      "WindowsCreateString",
      "WindowsDeleteString",
      "WindowsGetStringRawBuffer",
    ),
    RoActivateInstance: {
      args: [
        "ptr",
        "ptr",
      ],
      returns: "i32",
    },
  });
  try {
    checkToast(library.symbols.RoInitialize(0), "RoInitialize");
  } catch (error) {
    library.close();
    throw error;
  }
  let disposed = false;
  const method = (
    object: Pointer,
    slot: number,
    args: Abi[],
    ...values: Argument[]
  ): number => {
    const address = read.ptr(read.ptr(object), slot * POINTER_BYTES);
    if (!address) {
      throw new BunawayError({
        code: "INTERNAL",
        message: "Missing toast COM method.",
      });
    }
    const call = CFunction({
      ptr: address as Pointer,
      args: [
        "ptr",
        ...args,
      ],
      returns: "i32",
    });
    try {
      return Number(call(object, ...values));
    } finally {
      call.close();
    }
  };
  const object = (invoke: (out: Pointer) => number, stage: string): Pointer => {
    const out = new BigUint64Array(1);
    const result = invoke(ptr(out));
    if (result < 0) {
      if (out[0]) {
        method(Number(out[0]) as Pointer, 2, []);
      }
      checkToast(result, stage);
    }
    if (!out[0]) {
      throw new BunawayError({
        code: "INTERNAL",
        message: "Missing toast COM object.",
      });
    }
    // Win64 COM out pointers occupy eight bytes and must be released by their caller.
    return Number(out[0]) as Pointer;
  };
  const string = <T>(value: string, use: (address: Pointer) => T): T => {
    const text = Buffer.from(value, "utf16le");
    const out = new BigUint64Array(1);
    checkToast(
      library.symbols.WindowsCreateString(ptr(text), value.length, ptr(out)),
      "WindowsCreateString",
    );
    const address = Number(out[0]) as Pointer;
    try {
      return use(address);
    } finally {
      library.symbols.WindowsDeleteString(address);
    }
  };
  /** Copy and release an HSTRING returned by a COM getter. A null handle is the empty string. */
  const takeString = (handle: Pointer | 0): string => {
    if (!handle) {
      return "";
    }
    try {
      const length = new Uint32Array(1);
      const buffer = library.symbols.WindowsGetStringRawBuffer(
        handle,
        ptr(length),
      );
      return buffer
        ? Buffer.from(toArrayBuffer(buffer, 0, (length[0] ?? 0) * 2)).toString(
            "utf16le",
          )
        : "";
    } finally {
      library.symbols.WindowsDeleteString(handle);
    }
  };
  return {
    method,
    object,
    string,
    takeString,
    query: (value: Pointer, iid: string) =>
      object(
        (out) =>
          method(
            value,
            0,
            [
              "ptr",
              "ptr",
            ],
            ptr(guid(iid)),
            out,
          ),
        "QueryInterface",
      ),
    release: (value: Pointer) => {
      method(value, 2, []);
    },
    factory: (name: string, iid: string) =>
      string(name, (text) =>
        object(
          (out) =>
            library.symbols.RoGetActivationFactory(text, ptr(guid(iid)), out),
          "RoGetActivationFactory",
        ),
      ),
    activate: (name: string) =>
      string(name, (text) =>
        object(
          (out) => library.symbols.RoActivateInstance(text, out),
          "RoActivateInstance",
        ),
      ),
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      library.symbols.RoUninitialize();
      library.close();
    },
  };
}

// IXmlDocumentIO: LoadXml(6).
const XML_IO_IID = "6cd0e74e-ee65-4489-9ebf-ca43e87ba637";

/** Parse toast XML into a new XmlDocument. The caller owns and releases the returned reference. */
export function loadXmlDocument(
  runtime: ReturnType<typeof createToastRuntime>,
  xml: string,
): Pointer {
  const document = runtime.activate("Windows.Data.Xml.Dom.XmlDocument");
  try {
    const io = runtime.query(document, XML_IO_IID);
    try {
      runtime.string(xml, (text) =>
        checkToast(
          runtime.method(
            io,
            6,
            [
              "ptr",
            ],
            text,
          ),
          "XmlDocument.LoadXml",
        ),
      );
    } finally {
      runtime.release(io);
    }
    return document;
  } catch (error) {
    runtime.release(document);
    throw error;
  }
}

/**
 * Non-agile WinRT delegate. Windows marshals Invoke to the creating UI STA and its existing message pump.
 * Deliberately reject IAgileObject/IMarshal: JS callbacks cannot execute on arbitrary native threads.
 * Keep the owner reference until event revocation AND all native references have drained.
 */
export function createToastDelegate(
  iid: string,
  invoke: (argument: Pointer) => void,
) {
  const interfaceId = guid(iid);
  const object = new BigUint64Array(1);
  let references = 1;
  let depth = 0;
  let disposed = false;
  const query = new JSCallback(
    (_self: Pointer, requested: Pointer, output: Pointer) => {
      if (!output) {
        return E_POINTER;
      }
      const out = new DataView(toArrayBuffer(output, 0, POINTER_BYTES));
      out.setBigUint64(0, 0n, true);
      if (!requested) {
        return E_POINTER;
      }
      const id = Buffer.from(toArrayBuffer(requested, 0, 16));
      if (!id.equals(IUNKNOWN) && !id.equals(interfaceId)) {
        return E_NOINTERFACE;
      }
      out.setBigUint64(0, BigInt(ptr(object)), true);
      references++;
      return 0;
    },
    {
      args: [
        "ptr",
        "ptr",
        "ptr",
      ],
      returns: "i32",
    },
  );
  const retain = new JSCallback(() => ++references, {
    args: [
      "ptr",
    ],
    returns: "u32",
  });
  const release = new JSCallback(() => --references, {
    args: [
      "ptr",
    ],
    returns: "u32",
  });
  const call = new JSCallback(
    (_self: Pointer, _sender: Pointer, argument: Pointer) => {
      depth++;
      try {
        invoke(argument);
        return 0;
      } catch {
        return E_FAIL;
      } finally {
        // Never unwind JS exceptions through COM.
        depth--;
      }
    },
    {
      args: [
        "ptr",
        "ptr",
        "ptr",
      ],
      returns: "i32",
    },
  );
  const callbacks = [
    query,
    retain,
    release,
    call,
  ];
  const vtable = new BigUint64Array(
    callbacks.map((callback) => BigInt(callback.ptr ?? 0)),
  );
  object[0] = BigInt(ptr(vtable));
  return {
    pointer: ptr(object),
    // Strong references keep the native object/vtable alive through delayed Release calls.
    object,
    vtable,
    dispose() {
      if (disposed) {
        return;
      }
      if (depth || references !== 1) {
        throw new BunawayError({
          code: "BUSY",
          message: "Windows still owns a toast callback.",
        });
      }
      disposed = true;
      references = 0;
      for (const callback of callbacks) {
        callback.close();
      }
    },
  };
}
