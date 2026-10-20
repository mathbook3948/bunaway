import { ptr } from "bun:ffi";
import { expect, test } from "bun:test";
import os from "@bunaway/plugin-os";
import { NativeRegistry } from "@bunaway/protocol";
import {
  defaultPrinterSchema,
  MAX_PRINTER_NAME_CHARS,
  MAX_PRINTERS,
  printerListSchema,
} from "#plugins/os/src/contract";
import { osOperations } from "#plugins/os/src/operations";
import {
  defaultPrinterName,
  listPrinterNames,
  type PrinterBindings,
  samePrinter,
} from "#plugins/os/src/platforms/windows-printers";

const ERROR_FILE_NOT_FOUND = 2;
const ERROR_INSUFFICIENT_BUFFER = 122;
const ENTRY_BYTES = 24;

/** Image of an EnumPrintersW level 4 result whose name pointers are relative to `address`. */
function enumerationImage(names: string[], address: bigint): Buffer {
  const strings = names.map((name) => Buffer.from(`${name}\0`, "utf16le"));
  const image = Buffer.alloc(
    names.length * ENTRY_BYTES +
      strings.reduce((sum, value) => sum + value.length, 0),
  );
  let offset = names.length * ENTRY_BYTES;
  strings.forEach((value, index) => {
    image.writeBigUInt64LE(address + BigInt(offset), index * ENTRY_BYTES);
    value.copy(image, offset);
    offset += value.length;
  });
  return image;
}

interface FakeOptions {
  /** Names the spooler reports; a function lets the list change between calls. */
  names: string[] | (() => string[]);
  defaultName?: string | null;
  /** Rewrites the image after it is built, to corrupt it. */
  corrupt?: (image: Buffer, address: bigint) => void;
  enumError?: number;
  /** Bytes reported by the size query in place of the real size. */
  reportedSize?: number;
}

function fakeBindings(options: FakeOptions) {
  let error = 0;
  const calls: Array<Buffer | null> = [];
  const bindings: PrinterBindings = {
    enumPrinters(flags, buffer, needed, returned) {
      calls.push(buffer);
      expect(flags).toBe(0x2 | 0x4);
      const names =
        typeof options.names === "function" ? options.names() : options.names;
      if (options.enumError !== undefined) {
        error = options.enumError;
        return 0;
      }
      const size = names.length === 0 ? 0 : enumerationImage(names, 0n).length;
      if (names.length === 0) {
        return 1;
      }
      if (buffer === null || buffer.length < size) {
        needed[0] = options.reportedSize ?? size;
        error = ERROR_INSUFFICIENT_BUFFER;
        return 0;
      }
      const address = BigInt(ptr(buffer));
      const image = enumerationImage(names, address);
      options.corrupt?.(image, address);
      image.copy(buffer);
      needed[0] = size;
      returned[0] = names.length;
      return 1;
    },
    getDefaultPrinter(buffer, chars) {
      if (options.defaultName === null) {
        error = ERROR_FILE_NOT_FOUND;
        return 0;
      }
      const text = Buffer.from(`${options.defaultName}\0`, "utf16le");
      if (text.length / 2 > (chars[0] ?? 0)) {
        chars[0] = text.length / 2;
        error = ERROR_INSUFFICIENT_BUFFER;
        return 0;
      }
      text.copy(buffer);
      chars[0] = text.length / 2;
      return 1;
    },
    lastError: () => error,
  };
  return {
    bindings,
    calls,
  };
}

test("printer operations take null, return validated shapes and have their own permissions", () => {
  for (const operation of [
    "listPrinters",
    "getDefaultPrinter",
  ] as const) {
    expect(osOperations[operation].input.parse(null)).toBeNull();
    expect(osOperations[operation].input.safeParse({}).success).toBe(false);
  }
  const registry = new NativeRegistry([
    os._definition,
  ]);
  const call = {
    operation: "os.listPrinters",
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
      "os.listPrinters",
    ]),
  ).toBe(true);
  expect(
    grant([
      "os.getDefaultPrinter",
      "os.info",
    ]),
  ).toBe(false);
  expect(grant([])).toBe(false);
});

test("printer output schemas bound names and counts and reject extra fields", () => {
  const entry = {
    name: "Office",
    isDefault: true,
  };
  expect(
    printerListSchema.parse([
      entry,
    ]),
  ).toEqual([
    entry,
  ]);
  for (const value of [
    [
      {
        ...entry,
        server: "\\\\host",
      },
    ],
    [
      {
        ...entry,
        name: "",
      },
    ],
    [
      {
        ...entry,
        name: "x".repeat(MAX_PRINTER_NAME_CHARS + 1),
      },
    ],
    Array.from(
      {
        length: MAX_PRINTERS + 1,
      },
      () => entry,
    ),
  ]) {
    expect(printerListSchema.safeParse(value).success).toBe(false);
  }
  expect(defaultPrinterSchema.parse(null)).toBeNull();
  expect(defaultPrinterSchema.safeParse("").success).toBe(false);
});

test("listPrinterNames sizes the buffer, then reads names in enumeration order", () => {
  const names = [
    "Office Laser",
    "\\\\print-server\\Floor 2",
    "日本語プリンター",
  ];
  const { bindings, calls } = fakeBindings({
    names,
  });
  expect(listPrinterNames(bindings)).toEqual(names);
  expect(calls[0]).toBeNull();
  expect(calls).toHaveLength(2);
});

test("listPrinterNames returns an empty list when no printer is installed", () => {
  const { bindings, calls } = fakeBindings({
    names: [],
  });
  expect(listPrinterNames(bindings)).toEqual([]);
  expect(calls).toHaveLength(1);
});

test("listPrinterNames retries when printers were added after the size query", () => {
  let queries = 0;
  const { bindings, calls } = fakeBindings({
    names: () => {
      queries += 1;
      return queries === 1
        ? [
            "A",
          ]
        : [
            "A",
            "B",
          ];
    },
  });
  expect(listPrinterNames(bindings)).toEqual([
    "A",
    "B",
  ]);
  expect(calls).toHaveLength(3);
});

test("listPrinterNames gives up when the list keeps growing", () => {
  let count = 0;
  const { bindings } = fakeBindings({
    names: () => {
      count += 1;
      return Array.from(
        {
          length: count * 2,
        },
        (_unused, index) => `P${index}`,
      );
    },
  });
  // Every read finds a larger list than the buffer sized by the previous query.
  expect(() => listPrinterNames(bindings)).toThrow(
    "Windows printer list changed during the query.",
  );
});

test("listPrinterNames rejects failures, oversized results and corrupt buffers", () => {
  const failures: Array<
    [
      string,
      FakeOptions,
    ]
  > = [
    [
      "query failed",
      {
        names: [
          "A",
        ],
        enumError: 1722,
      },
    ],
    [
      "size query reports an absurd size",
      {
        names: [
          "A",
        ],
        reportedSize: 0xffffffff,
      },
    ],
    [
      "name pointer outside the buffer",
      {
        names: [
          "A",
        ],
        corrupt: (image) => image.writeBigUInt64LE(8n, 0),
      },
    ],
    [
      "name pointer into the entry array",
      {
        names: [
          "A",
        ],
        corrupt: (image, address) => image.writeBigUInt64LE(address + 8n, 0),
      },
    ],
    [
      "unaligned name pointer",
      {
        names: [
          "A",
        ],
        corrupt: (image, address) =>
          image.writeBigUInt64LE(address + BigInt(ENTRY_BYTES + 1), 0),
      },
    ],
    [
      "unterminated name",
      {
        names: [
          "A",
        ],
        corrupt: (image) => image.writeUInt16LE(0x41, image.length - 2),
      },
    ],
    [
      "name longer than the contract allows",
      {
        names: [
          "x".repeat(MAX_PRINTER_NAME_CHARS + 1),
        ],
      },
    ],
    [
      "empty name",
      {
        names: [
          "",
        ],
      },
    ],
  ];
  for (const [, options] of failures) {
    const { bindings } = fakeBindings(options);
    expect(() => listPrinterNames(bindings)).toThrow(
      expect.objectContaining({
        code: "INTERNAL",
      }),
    );
  }
});

test("listPrinterNames accepts the longest allowed name", () => {
  const name = "n".repeat(MAX_PRINTER_NAME_CHARS);
  const { bindings } = fakeBindings({
    names: [
      name,
    ],
  });
  expect(listPrinterNames(bindings)).toEqual([
    name,
  ]);
});

test("defaultPrinterName returns the name, null without a default, and fails on other errors", () => {
  expect(
    defaultPrinterName(
      fakeBindings({
        names: [],
        defaultName: "Office Laser",
      }).bindings,
    ),
  ).toBe("Office Laser");
  expect(
    defaultPrinterName(
      fakeBindings({
        names: [],
        defaultName: null,
      }).bindings,
    ),
  ).toBeNull();
  expect(() =>
    defaultPrinterName(
      fakeBindings({
        names: [],
        defaultName: "x".repeat(MAX_PRINTER_NAME_CHARS + 1),
      }).bindings,
    ),
  ).toThrow(
    expect.objectContaining({
      code: "INTERNAL",
    }),
  );
});

test("printer names compare case-insensitively", () => {
  expect(samePrinter("Office Laser", "OFFICE laser")).toBe(true);
  expect(samePrinter("Office Laser", "Office Laser 2")).toBe(false);
});
