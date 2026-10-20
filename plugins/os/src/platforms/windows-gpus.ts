import { CFunction, dlopen, type Pointer, ptr, read } from "bun:ffi";
import { BunawayError } from "@bunaway/protocol";
import { MAX_GPU_NAME_CHARS, MAX_GPUS, type OSGpu } from "#os/contract";

/** HRESULT `DXGI_ERROR_NOT_FOUND` as the signed 32-bit value FFI returns; it ends adapter enumeration. */
const DXGI_ERROR_NOT_FOUND = 0x887a0002 | 0;
/** `DXGI_ADAPTER_FLAG_SOFTWARE`: the adapter is a software renderer such as the Basic Render Driver. */
const DXGI_ADAPTER_FLAG_SOFTWARE = 0x2;
/** Vtable slot of `IUnknown::Release`, shared by every COM interface. */
const RELEASE_SLOT = 2;
/** Vtable slot of `IDXGIFactory1::EnumAdapters1` (IUnknown has 3 methods, IDXGIObject 4 and IDXGIFactory 5). */
const ENUM_ADAPTERS1_SLOT = 12;
/** Vtable slot of `IDXGIAdapter1::GetDesc1` (IUnknown has 3 methods, IDXGIObject 4 and IDXGIAdapter 3). */
const GET_DESC1_SLOT = 10;
/** `DXGI_ADAPTER_DESC1` on 64-bit Windows: WCHAR[128], four UINTs, three SIZE_Ts, a LUID, Flags, padded to 8. */
export const DXGI_ADAPTER_DESC1_BYTES = 312;
export const DESC_VENDOR_ID_OFFSET = 256;
export const DESC_DEVICE_ID_OFFSET = 260;
export const DESC_DEDICATED_VIDEO_MEMORY_OFFSET = 272;
export const DESC_FLAGS_OFFSET = 304;
const DESC_NAME_CHARS = 128;

/** IID_IDXGIFactory1 {770aae78-f26f-4dba-a829-253c83d1b387} in memory (GUID) layout. */
const IID_IDXGIFACTORY1 = Buffer.from([
  0x78,
  0xae,
  0x0a,
  0x77,
  0x6f,
  0xf2,
  0xba,
  0x4d,
  0xa8,
  0x29,
  0x25,
  0x3c,
  0x83,
  0xd1,
  0xb3,
  0x87,
]);

/** Open dxgi.dll; the caller owns the returned library and closes it on dispose. */
export function openDxgi() {
  return dlopen("dxgi.dll", {
    CreateDXGIFactory1: {
      args: [
        "ptr",
        "ptr",
      ],
      returns: "i32",
    },
  });
}

/**
 * The DXGI calls the adapter list needs. A COM object is passed around as its address; the
 * caller releases every object it obtained exactly once.
 */
export interface GpuBindings {
  /** `CreateDXGIFactory1`; the returned factory is owned by the caller. */
  createFactory(): {
    result: number;
    factory: bigint;
  };
  /** `IDXGIFactory1::EnumAdapters1`; the returned adapter is owned by the caller when `result` is not negative. */
  enumAdapter(
    factory: bigint,
    index: number,
  ): {
    result: number;
    adapter: bigint;
  };
  /** `IDXGIAdapter1::GetDesc1` into `desc`, which is `DXGI_ADAPTER_DESC1_BYTES` long. */
  describe(adapter: bigint, desc: Buffer): number;
  /** `IUnknown::Release`. */
  release(object: bigint): void;
}

function failure(message: string): never {
  throw new BunawayError({
    code: "INTERNAL",
    message,
  });
}

/** Call one COM method by vtable slot; the temporary function binding is closed before returning. */
function callMethod(
  object: bigint,
  slot: number,
  args: ("ptr" | "u32")[],
  values: (number | bigint)[],
): number {
  const self = Number(object) as Pointer;
  const method = read.ptr(read.ptr(self), slot * 8);
  if (!method) {
    return failure("Windows graphics adapter interface is unavailable.");
  }
  const call = CFunction({
    ptr: method as Pointer,
    args: [
      "ptr",
      ...args,
    ],
    returns: "i32",
  });
  try {
    return call(self, ...values);
  } finally {
    call.close();
  }
}

/** Adapt the loaded dxgi.dll symbol and vtable calls to the narrow interface above. */
export function gpuBindings(dxgi: ReturnType<typeof openDxgi>): GpuBindings {
  return {
    createFactory() {
      const out = new BigUint64Array(1);
      const result = dxgi.symbols.CreateDXGIFactory1(
        ptr(IID_IDXGIFACTORY1),
        ptr(out),
      );
      return {
        result,
        factory: out[0] ?? 0n,
      };
    },
    enumAdapter(factory, index) {
      const out = new BigUint64Array(1);
      const result = callMethod(
        factory,
        ENUM_ADAPTERS1_SLOT,
        [
          "u32",
          "ptr",
        ],
        [
          index,
          ptr(out),
        ],
      );
      return {
        result,
        adapter: out[0] ?? 0n,
      };
    },
    describe(adapter, desc) {
      return callMethod(
        adapter,
        GET_DESC1_SLOT,
        [
          "ptr",
        ],
        [
          ptr(desc),
        ],
      );
    },
    release(object) {
      callMethod(object, RELEASE_SLOT, [], []);
    },
  };
}

/** Decode one `DXGI_ADAPTER_DESC1`; a name without a terminator or a memory size beyond 2^53 is malformed. */
export function parseAdapterDesc(desc: Buffer): OSGpu {
  let nameChars = 0;
  while (
    nameChars < DESC_NAME_CHARS &&
    desc.readUInt16LE(nameChars * 2) !== 0
  ) {
    nameChars += 1;
  }
  const memory = desc.readBigUInt64LE(DESC_DEDICATED_VIDEO_MEMORY_OFFSET);
  if (
    nameChars > MAX_GPU_NAME_CHARS ||
    memory > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    failure("Windows graphics adapter description is malformed.");
  }
  return {
    name: desc.toString("utf16le", 0, nameChars * 2),
    vendorId: desc.readUInt32LE(DESC_VENDOR_ID_OFFSET),
    deviceId: desc.readUInt32LE(DESC_DEVICE_ID_OFFSET),
    dedicatedVideoMemoryBytes: Number(memory),
    software:
      (desc.readUInt32LE(DESC_FLAGS_OFFSET) & DXGI_ADAPTER_FLAG_SOFTWARE) !== 0,
  };
}

/** Read the description of one adapter and release it whatever the outcome. */
function describeAdapter(bindings: GpuBindings, adapter: bigint): OSGpu {
  try {
    const desc = Buffer.alloc(DXGI_ADAPTER_DESC1_BYTES);
    if (bindings.describe(adapter, desc) < 0) {
      failure("Windows graphics adapter query failed.");
    }
    return parseAdapterDesc(desc);
  } finally {
    bindings.release(adapter);
  }
}

/**
 * Graphics adapters in DXGI enumeration order. A DXGI factory is created for the call and
 * released before returning, so every call reads the current adapters. An environment without
 * adapters is an empty list; a failed query, or more than `MAX_GPUS` adapters, is an error
 * instead of a silently shortened list.
 */
export function listGpus(bindings: GpuBindings): OSGpu[] {
  const { result, factory } = bindings.createFactory();
  if (result < 0 || factory === 0n) {
    failure("Windows graphics adapter query failed.");
  }
  try {
    const gpus: OSGpu[] = [];
    // Probing one index past the limit tells a full list from an oversized one.
    for (let index = 0; index <= MAX_GPUS; index += 1) {
      const next = bindings.enumAdapter(factory, index);
      if (next.result === DXGI_ERROR_NOT_FOUND) {
        return gpus;
      }
      if (next.result < 0 || next.adapter === 0n) {
        failure("Windows graphics adapter query failed.");
      }
      if (index === MAX_GPUS) {
        bindings.release(next.adapter);
        failure("Windows graphics adapter list is too long.");
      }
      gpus.push(describeAdapter(bindings, next.adapter));
    }
    return failure("Windows graphics adapter list is too long.");
  } finally {
    bindings.release(factory);
  }
}
