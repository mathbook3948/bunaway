import type { FFIType, Pointer } from "bun:ffi";
import { CFunction, JSCallback, ptr, read, toArrayBuffer } from "bun:ffi";
import assert from "node:assert/strict";
import { MAX_MESSAGE_BYTES } from "../../../packages/protocol/src/index.ts";
import { hr, kernel, ole, withBuffer, withWide } from "./win32-bindings.ts";

const thread = kernel.symbols.GetCurrentThreadId();
export type Arg = number | bigint | null;
export type Abi = FFIType | "ptr" | "i32" | "u32" | "i64" | "u64";
type NativeCall = ((...values: Arg[]) => number) & {
  close(): void;
};
const methods = new Map<string, NativeCall>();
/** Bind and cache a COM vtable slot; calls supply object as the implicit this pointer. */
export function method(
  object: Pointer,
  slot: number,
  args: Abi[] = [],
  returns: Abi = "i32",
) {
  const address = read.ptr(read.ptr(object), slot * 8);
  assert(address, "Null COM method");
  const key = `${address}:${args}:${returns}`;
  let binding = methods.get(key);
  if (!binding) {
    binding = CFunction({
      ptr: address as Pointer,
      args: [
        "ptr",
        ...args,
      ],
      returns,
    }) as NativeCall;
    methods.set(key, binding);
  }
  return (...values: Arg[]) => binding(object, ...values);
}
export const addRef = (object: Pointer) => method(object, 1, [], "u32")();
export const release = (object: Pointer) => method(object, 2, [], "u32")();
/** Read and free COM UTF-16 text by slot or property name; absent or oversized values return empty. */
export function getString(object: Pointer, slot: number, name?: string) {
  const out = new BigUint64Array(1);
  hr(
    name === undefined
      ? method(object, slot, [
          "ptr",
        ])(ptr(out))
      : withWide(name, (key) =>
          method(object, slot, [
            "ptr",
            "ptr",
          ])(key, ptr(out)),
        ),
    "get string",
  );
  const address = Number(out[0]) as Pointer;
  if (!address) {
    return "";
  }
  try {
    let bytes = 0;
    while (bytes <= 2 * MAX_MESSAGE_BYTES && read.u16(address, bytes)) {
      bytes += 2;
    }
    // Empty is invalid for both a Web message and an allowed URL. Reject oversized
    // input without returning a truncated value or poisoning the COM callback state.
    if (bytes > 2 * MAX_MESSAGE_BYTES) {
      return "";
    }
    return Buffer.from(toArrayBuffer(address, 0, bytes)).toString("utf16le");
  } finally {
    ole.symbols.CoTaskMemFree(address);
  }
}
/** Convert GUID text to the byte order used by the Windows COM ABI. */
export function guid(value: string) {
  const result = Buffer.from(value.replaceAll("-", ""), "hex");
  result.subarray(0, 4).reverse();
  result.subarray(4, 6).reverse();
  result.subarray(6, 8).reverse();
  return result;
}
const unknown = guid("00000000-0000-0000-c000-000000000046");
let callbackDepth = 0;
let maxCallbackDepth = 0;
let invokeDepth = 0;
let maxInvokeDepth = 0;
let failure: unknown;
/** Owns the JS memory backing a COM object and tracks its native references and calls. */
export type ComHandler = {
  name: string;
  object: BigUint64Array;
  vtable: BigUint64Array;
  callbacks: JSCallback[];
  pointer: Pointer;
  readonly refs: number;
  readonly calls: number;
  dropOwner(): void;
  dispose(): void;
};
const handlers: ComHandler[] = [];
/**
 * Expose invoke as a COM object while retaining its vtable and callbacks for native use.
 * Calls must stay on the creating STA; callback exceptions are saved for checkCallbacks.
 */
export function handler(
  name: string,
  iid: string,
  args: Abi[],
  invoke: (...values: Arg[]) => void,
): ComHandler {
  let refs = 1;
  let calls = 0;
  const interfaceId = guid(iid);
  const object = new BigUint64Array(1);
  const wrap =
    (fn: (...values: Arg[]) => number) =>
    (...values: Arg[]) => {
      callbackDepth++;
      maxCallbackDepth = Math.max(callbackDepth, maxCallbackDepth);
      try {
        assert.equal(
          kernel.symbols.GetCurrentThreadId(),
          thread,
          `${name} foreign thread`,
        );
        assert(refs > 0, `${name} used after Release`);
        return fn(...values);
      } catch (error) {
        failure ??= error;

        return -2147467259; // E_FAIL; never unwind JS exceptions through COM.
      } finally {
        callbackDepth--;
      }
    };
  const query = new JSCallback(
    wrap((_self, requested, out) => {
      if (!out) {
        return -2147467261; // E_POINTER
      }
      const output = new DataView(toArrayBuffer(out as Pointer, 0, 8));
      output.setBigUint64(0, 0n, true);
      if (!requested) {
        return -2147467261;
      }
      const id = Buffer.from(toArrayBuffer(requested as Pointer, 0, 16));
      if (!id.equals(unknown) && !id.equals(interfaceId)) {
        return -2147467262;
      }
      output.setBigUint64(0, BigInt(ptr(object)), true);
      refs++;
      return 0;
    }),
    {
      args: [
        "ptr",
        "ptr",
        "ptr",
      ],
      returns: "i32",
    },
  );
  const retain = new JSCallback(
    wrap(() => ++refs),
    {
      args: [
        "ptr",
      ],
      returns: "u32",
    },
  );
  const drop = new JSCallback(
    wrap(() => --refs),
    {
      args: [
        "ptr",
      ],
      returns: "u32",
    },
  );
  const call = new JSCallback(
    wrap((_self, ...values) => {
      calls++;
      invokeDepth++;
      maxInvokeDepth = Math.max(maxInvokeDepth, invokeDepth);
      try {
        invoke(...values);
      } finally {
        invokeDepth--;
      }
      return 0;
    }),
    {
      args: [
        "ptr",
        ...args,
      ],
      returns: "i32",
    },
  );
  const callbacks = [
    query,
    retain,
    drop,
    call,
  ];
  const vtable = new BigUint64Array(
    callbacks.map((callback) => BigInt(callback.ptr ?? 0)),
  );
  object[0] = BigInt(ptr(vtable));
  const result = {
    name,
    object,
    vtable,
    callbacks,
    pointer: ptr(object),
    get refs() {
      return refs;
    },
    get calls() {
      return calls;
    },
    dropOwner() {
      assert(refs > 0);
      refs--;
    },
    dispose() {
      assert.equal(refs, 0, `${name} outstanding COM refs`);
      for (const callback of callbacks) {
        callback.close();
      }
    },
  };
  handlers.push(result);
  return result;
}

/** Read an owned interface pointer from an out slot; the caller must release it. */
export function getObject(object: Pointer, slot: number): Pointer {
  const out = new BigUint64Array(1);
  hr(
    method(object, slot, [
      "ptr",
    ])(ptr(out)),
    "get object",
  );
  assert(out[0], "Null COM object");
  return Number(out[0]) as Pointer;
}
/** Acquire an interface with QueryInterface; the caller must release its reference. */
export function query(object: Pointer, iid: string): Pointer {
  const out = new BigUint64Array(1);
  hr(
    withBuffer(guid(iid), (address) =>
      method(object, 0, [
        "ptr",
        "ptr",
      ])(address, ptr(out)),
    ),
    "QueryInterface",
  );
  assert(out[0], "Null COM interface");
  return Number(out[0]) as Pointer;
}
/** Rethrow saved callback failures and assert COM Invoke is inactive before pumping. */
export function checkCallbacks() {
  if (failure) {
    throw failure;
  }
  assert.equal(invokeDepth, 0, "Do not pump inside COM Invoke");
}
export function callbackCalls() {
  return handlers.map((callback) => callback.calls);
}
/**
 * Dispose a retired view's callbacks after native detach and quiescence.
 * Cached method bindings are closed when the last view is removed.
 */
export function disposeHandlers(retired: readonly ComHandler[]) {
  assert.equal(
    callbackDepth,
    0,
    "Callback disposal while native stack is active",
  );
  assert.equal(invokeDepth, 0, "Invoke disposal while native stack is active");
  for (const callback of retired) {
    assert.equal(callback.refs, 1, `${callback.name} outstanding COM refs`);
    callback.dropOwner();
    callback.dispose();
    const index = handlers.indexOf(callback);
    assert(index >= 0, "Unknown COM handler");
    handlers.splice(index, 1);
  }
  if (!handlers.length) {
    for (const binding of methods.values()) {
      binding.close();
    }
    methods.clear();
  }
}

/**
 * Dispose process-wide callbacks and FFI bindings after shutdown.
 * Native references and active callbacks must have drained first.
 */
export function disposeCom() {
  assert.equal(
    callbackDepth,
    0,
    "Callback disposal while native stack is active",
  );
  assert.equal(invokeDepth, 0, "Invoke disposal while native stack is active");
  for (const callback of handlers) {
    callback.dropOwner();
    callback.dispose();
  }
  for (const binding of methods.values()) {
    binding.close();
  }
  return {
    maxCallbackDepth,
    maxInvokeDepth,
    handlers: handlers.map(({ name, refs, calls }) => ({
      name,
      refs,
      calls,
    })),
  };
}
