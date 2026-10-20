import { CFunction, type Pointer, ptr, read } from "bun:ffi";
import type { BunawayError } from "@bunaway/protocol";

const POINTER_BYTES = 8;
const COM_SLOT = {
  queryInterface: 0,
  release: 2,
} as const;

/** Encode a GUID string in the in-memory layout COM expects. */
export function guid(value: string): Buffer {
  const bytes = Buffer.from(value.replaceAll("-", ""), "hex");
  bytes.subarray(0, 4).reverse();
  bytes.subarray(4, 6).reverse();
  bytes.subarray(6, 8).reverse();
  return bytes;
}

/** `IShellLinkW` vtable slots, counting the three `IUnknown` methods. */
export const SHELL_LINK_SLOT = {
  getPath: 3,
  getDescription: 6,
  setDescription: 7,
  getWorkingDirectory: 8,
  setWorkingDirectory: 9,
  getArguments: 10,
  setArguments: 11,
  getIconLocation: 16,
  setIconLocation: 17,
  setPath: 20,
} as const;

export type ComArgument = "ptr" | "i32" | "u32";

/**
 * COM objects and vtable bindings owned for one request. Every acquired interface pointer is
 * released in reverse order and every binding closed by `release`, which the caller runs
 * once in a `finally` block. `fail` builds the error for a failed acquisition.
 */
export class ComScope {
  readonly #bindings: ReturnType<typeof CFunction>[] = [];
  readonly #releases: (() => void)[] = [];
  readonly #fail: () => BunawayError;

  constructor(fail: () => BunawayError) {
    this.#fail = fail;
  }

  /** Bind a vtable slot of `object`; the call returns the raw HRESULT. */
  call(object: Pointer, slot: number, args: ComArgument[]) {
    const address = read.ptr(read.ptr(object), slot * POINTER_BYTES);
    if (!address) {
      throw this.#fail();
    }
    const binding = CFunction({
      ptr: address as Pointer,
      args: [
        "ptr",
        ...args,
      ],
      returns: "i32",
    });
    this.#bindings.push(binding);
    return (...values: (number | Pointer | null)[]) =>
      Number(binding(object, ...values));
  }

  /** Take ownership of an interface pointer the invoked call writes to its output slot. */
  acquire(invoke: (out: Pointer) => number): Pointer {
    const object = this.acquireOptional(invoke);
    if (!object) {
      throw this.#fail();
    }
    return object;
  }

  /** Like `acquire`, but a call that reports failure or returns no object yields null. */
  acquireOptional(invoke: (out: Pointer) => number): Pointer | null {
    const output = new BigUint64Array(1);
    if (invoke(ptr(output)) < 0 || !output[0]) {
      return null;
    }
    const object = Number(output[0]) as Pointer;
    const release = this.call(object, COM_SLOT.release, []);
    this.#releases.push(() => release());
    return object;
  }

  /** Query another interface of `object`; the result is released with the scope. */
  queryInterface(object: Pointer, iid: Buffer): Pointer {
    const queried = this.queryInterfaceOptional(object, iid);
    if (!queried) {
      throw this.#fail();
    }
    return queried;
  }

  /** Like `queryInterface`, but null when `object` does not implement the interface. */
  queryInterfaceOptional(object: Pointer, iid: Buffer): Pointer | null {
    return this.acquireOptional((out) =>
      this.call(object, COM_SLOT.queryInterface, [
        "ptr",
        "ptr",
      ])(ptr(iid), out),
    );
  }

  release(): void {
    for (const release of this.#releases.reverse()) {
      release();
    }
    for (const binding of this.#bindings) {
      binding.close();
    }
  }
}
