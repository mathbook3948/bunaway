import { CFunction, type Pointer, read } from "bun:ffi";
import { expect, test } from "bun:test";
import { createTrashProgressSink } from "#plugins/opener/src/platforms/windows-trash";

/** Call the real FFI callback ABI without asking the OS to delete any file. */
function call(
  sink: ReturnType<typeof createTrashProgressSink>,
  slot: number,
  args: ("ptr" | "u32" | "i32")[],
  values: (number | null)[],
): number {
  const binding = CFunction({
    ptr: read.ptr(read.ptr(sink.pointer), slot * 8) as Pointer,
    args: [
      "ptr",
      ...args,
    ],
    returns: "i32",
  });
  try {
    return Number(binding(sink.pointer, ...values));
  } finally {
    binding.close();
  }
}
const preDelete = (
  sink: ReturnType<typeof createTrashProgressSink>,
  flags: number,
) =>
  call(
    sink,
    11,
    [
      "u32",
      "ptr",
    ],
    [
      flags,
      null,
    ],
  );
const postDelete = (
  sink: ReturnType<typeof createTrashProgressSink>,
  result: number,
  recycled: boolean,
) =>
  call(
    sink,
    12,
    [
      "u32",
      "ptr",
      "i32",
      "ptr",
    ],
    [
      0x80,
      null,
      result,
      recycled ? sink.pointer : null,
    ],
  );

test("trash sink aborts callbacks without recycle flags and rejects retries", () => {
  for (const flags of [
    0,
    0x80,
  ]) {
    const sink = createTrashProgressSink();
    try {
      if (flags === 0x80) {
        expect(preDelete(sink, flags)).toBe(0);
      }
      expect(preDelete(sink, 0)).toBeLessThan(0);
      expect(() => sink.complete(false)).toThrow(
        expect.objectContaining({
          code: "UNSUPPORTED",
        }),
      );
    } finally {
      sink.dispose();
      sink.dispose();
    }
  }
});

test("trash sink requires a successful per-item result and a Recycle Bin item", () => {
  // Shell HRESULTs reported per item: E_ACCESSDENIED and ERROR_FILE_NOT_FOUND.
  const postResults: Record<string, number> = {
    denied: -2147024891,
    missing: -2147024894,
  };
  const failureCodes: Record<string, string> = {
    denied: "PERMISSION_DENIED",
    missing: "INVALID_ARGUMENT",
  };
  for (const scenario of [
    "recycled",
    "permanent",
    "denied",
    "missing",
    "aborted",
    "no-post",
  ]) {
    const sink = createTrashProgressSink();
    try {
      expect(preDelete(sink, 0x80)).toBe(0);
      if (scenario !== "no-post") {
        const result = postResults[scenario] ?? 0;
        const callbackResult = postDelete(
          sink,
          result,
          scenario !== "permanent",
        );
        expect(callbackResult).toBe(
          scenario === "denied" ||
            scenario === "missing" ||
            scenario === "permanent"
            ? -2147467260
            : 0,
        );
      }
      if (scenario === "recycled") {
        expect(() => sink.complete(false)).not.toThrow();
      } else {
        expect(() => sink.complete(scenario === "aborted")).toThrow(
          expect.objectContaining({
            code: failureCodes[scenario] ?? "INTERNAL",
          }),
        );
      }
    } finally {
      sink.dispose();
    }
  }
});
