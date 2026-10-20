import { expect, test } from "bun:test";
import os from "@bunaway/plugin-os";
import { BunawayError, NativeRegistry } from "@bunaway/protocol";
import {
  gpuListSchema,
  MAX_GPU_NAME_CHARS,
  MAX_GPUS,
} from "#plugins/os/src/contract";
import { osOperations } from "#plugins/os/src/operations";
import {
  DESC_DEDICATED_VIDEO_MEMORY_OFFSET,
  DESC_DEVICE_ID_OFFSET,
  DESC_FLAGS_OFFSET,
  DESC_VENDOR_ID_OFFSET,
  DXGI_ADAPTER_DESC1_BYTES,
  type GpuBindings,
  listGpus,
} from "#plugins/os/src/platforms/windows-gpus";

const DXGI_ERROR_NOT_FOUND = 0x887a0002 | 0;
const E_FAIL = 0x80004005 | 0;
const FACTORY = 0x1000n;

interface FakeAdapter {
  name: string;
  vendorId: number;
  deviceId: number;
  memory: bigint;
  flags: number;
  /** Rewrites the description after it is built, to corrupt it. */
  corrupt?: (desc: Buffer) => void;
  describeResult?: number;
}

function adapter(overrides: Partial<FakeAdapter> = {}): FakeAdapter {
  return {
    name: "Test Adapter",
    vendorId: 0x10de,
    deviceId: 0x2684,
    memory: 8n * 1024n ** 3n,
    flags: 0,
    ...overrides,
  };
}

/** DXGI fake that records which COM objects were released. */
function fakeBindings(
  adapters: FakeAdapter[],
  options: {
    createResult?: number;
    enumFailure?: number;
  } = {},
) {
  const released: bigint[] = [];
  const bindings: GpuBindings = {
    createFactory: () => ({
      result: options.createResult ?? 0,
      factory: options.createResult === undefined ? FACTORY : 0n,
    }),
    enumAdapter(factory, index) {
      expect(factory).toBe(FACTORY);
      if (options.enumFailure !== undefined && index === adapters.length) {
        return {
          result: options.enumFailure,
          adapter: 0n,
        };
      }
      return index < adapters.length
        ? {
            result: 0,
            adapter: BigInt(index + 1),
          }
        : {
            result: DXGI_ERROR_NOT_FOUND,
            adapter: 0n,
          };
    },
    describe(handle, desc) {
      const entry = adapters[Number(handle) - 1];
      if (entry === undefined) {
        throw new Error("unknown adapter");
      }
      expect(desc.length).toBe(DXGI_ADAPTER_DESC1_BYTES);
      if (entry.describeResult !== undefined) {
        return entry.describeResult;
      }
      desc.write(`${entry.name}\0`, "utf16le");
      desc.writeUInt32LE(entry.vendorId, DESC_VENDOR_ID_OFFSET);
      desc.writeUInt32LE(entry.deviceId, DESC_DEVICE_ID_OFFSET);
      desc.writeBigUInt64LE(entry.memory, DESC_DEDICATED_VIDEO_MEMORY_OFFSET);
      desc.writeUInt32LE(entry.flags, DESC_FLAGS_OFFSET);
      entry.corrupt?.(desc);
      return 0;
    },
    release: (object) => {
      released.push(object);
    },
  };
  return {
    bindings,
    released,
  };
}

function sorted(values: bigint[]): bigint[] {
  return values.slice().sort((left, right) => Number(left - right));
}

function internal(run: () => unknown) {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(BunawayError);
    expect((error as BunawayError).code).toBe("INTERNAL");
    return;
  }
  throw new Error("expected an INTERNAL failure");
}

test("the DXGI_ADAPTER_DESC1 offsets match the 64-bit layout", () => {
  // WCHAR[128], then VendorId, DeviceId, SubSysId, Revision, three SIZE_Ts, a LUID and Flags.
  expect(DESC_VENDOR_ID_OFFSET).toBe(128 * 2);
  expect(DESC_DEVICE_ID_OFFSET).toBe(DESC_VENDOR_ID_OFFSET + 4);
  expect(DESC_DEDICATED_VIDEO_MEMORY_OFFSET).toBe(DESC_VENDOR_ID_OFFSET + 16);
  expect(DESC_FLAGS_OFFSET).toBe(
    DESC_DEDICATED_VIDEO_MEMORY_OFFSET + 3 * 8 + 8,
  );
  expect(DXGI_ADAPTER_DESC1_BYTES).toBe(DESC_FLAGS_OFFSET + 8);
});

test("listGpus takes null, returns a validated shape and has its own permission", () => {
  expect(osOperations.listGpus.input.parse(null)).toBeNull();
  expect(osOperations.listGpus.input.safeParse({}).success).toBe(false);
  const registry = new NativeRegistry([
    os._definition,
  ]);
  const call = {
    operation: "os.listGpus",
    payload: null,
  };
  const grant = (permissions: string[]) =>
    registry.allowed(
      {
        permissions,
      },
      call,
    );
  expect(
    grant([
      "os.listGpus",
    ]),
  ).toBe(true);
  expect(
    grant([
      "os.listPrinters",
      "os.info",
    ]),
  ).toBe(false);
  expect(grant([])).toBe(false);
});

test("the GPU output schema bounds names and counts and rejects extra fields", () => {
  const entry = {
    name: "Adapter",
    vendorId: 0x1002,
    deviceId: 1,
    dedicatedVideoMemoryBytes: 0,
    software: false,
  };
  expect(
    gpuListSchema.parse([
      entry,
    ]),
  ).toEqual([
    entry,
  ]);
  for (const value of [
    [
      {
        ...entry,
        driverVersion: "1",
      },
    ],
    [
      {
        ...entry,
        name: "x".repeat(MAX_GPU_NAME_CHARS + 1),
      },
    ],
    [
      {
        ...entry,
        vendorId: 0x100000000,
      },
    ],
    [
      {
        ...entry,
        dedicatedVideoMemoryBytes: -1,
      },
    ],
    Array.from(
      {
        length: MAX_GPUS + 1,
      },
      () => entry,
    ),
  ]) {
    expect(gpuListSchema.safeParse(value).success).toBe(false);
  }
});

test("listGpus reads every adapter in enumeration order and releases each object once", () => {
  const { bindings, released } = fakeBindings([
    adapter({
      name: "NVIDIA GeForce RTX 4090",
    }),
    adapter({
      name: "Microsoft Basic Render Driver",
      vendorId: 0x1414,
      deviceId: 0x8c,
      memory: 0n,
      flags: 2,
    }),
    adapter({
      name: "日本語アダプター",
      flags: 1,
    }),
  ]);
  const gpus = listGpus(bindings);
  expect(gpuListSchema.parse(gpus)).toEqual(gpus);
  expect(gpus).toEqual([
    {
      name: "NVIDIA GeForce RTX 4090",
      vendorId: 0x10de,
      deviceId: 0x2684,
      dedicatedVideoMemoryBytes: 8 * 1024 ** 3,
      software: false,
    },
    {
      name: "Microsoft Basic Render Driver",
      vendorId: 0x1414,
      deviceId: 0x8c,
      dedicatedVideoMemoryBytes: 0,
      software: true,
    },
    {
      name: "日本語アダプター",
      vendorId: 0x10de,
      deviceId: 0x2684,
      dedicatedVideoMemoryBytes: 8 * 1024 ** 3,
      // Only the software flag counts; the remote flag (1) does not make an adapter software.
      software: false,
    },
  ]);
  expect(sorted(released)).toEqual([
    1n,
    2n,
    3n,
    FACTORY,
  ]);
});

test("listGpus returns an empty list for a machine without adapters", () => {
  const { bindings, released } = fakeBindings([]);
  expect(listGpus(bindings)).toEqual([]);
  expect(released).toEqual([
    FACTORY,
  ]);
});

test("listGpus accepts exactly the limit and rejects one more adapter", () => {
  const full = fakeBindings(
    Array.from(
      {
        length: MAX_GPUS,
      },
      () => adapter(),
    ),
  );
  expect(listGpus(full.bindings)).toHaveLength(MAX_GPUS);
  const over = fakeBindings(
    Array.from(
      {
        length: MAX_GPUS + 1,
      },
      () => adapter(),
    ),
  );
  internal(() => listGpus(over.bindings));
  // The sixteen read adapters, the probed seventeenth and the factory are released.
  expect(over.released).toHaveLength(MAX_GPUS + 2);
  expect(over.released).toContain(BigInt(MAX_GPUS + 1));
});

test("listGpus fails with INTERNAL and releases what it holds when a query fails", () => {
  const noFactory = fakeBindings([], {
    createResult: E_FAIL,
  });
  internal(() => listGpus(noFactory.bindings));
  expect(noFactory.released).toEqual([]);

  const enumFails = fakeBindings(
    [
      adapter(),
    ],
    {
      enumFailure: E_FAIL,
    },
  );
  internal(() => listGpus(enumFails.bindings));
  expect(sorted(enumFails.released)).toEqual([
    1n,
    FACTORY,
  ]);

  const describeFails = fakeBindings([
    adapter({
      describeResult: E_FAIL,
    }),
  ]);
  internal(() => listGpus(describeFails.bindings));
  expect(sorted(describeFails.released)).toEqual([
    1n,
    FACTORY,
  ]);
});

test("listGpus rejects malformed descriptions", () => {
  for (const corrupt of [
    // No terminator inside the 128-character name.
    (desc: Buffer) => desc.fill(0x41, 0, 256),
    // A video memory size a JavaScript number cannot hold exactly.
    (desc: Buffer) =>
      desc.writeBigUInt64LE(2n ** 60n, DESC_DEDICATED_VIDEO_MEMORY_OFFSET),
  ]) {
    const { bindings, released } = fakeBindings([
      adapter({
        corrupt,
      }),
    ]);
    internal(() => listGpus(bindings));
    expect(sorted(released)).toEqual([
      1n,
      FACTORY,
    ]);
  }
});
