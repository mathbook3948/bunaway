import assert from "node:assert/strict";
import { createOperations } from "../../plugins/power/src/platforms/windows.ts";
import { powerCleanup } from "./power-cleanup-ffi.ts";

for (const failures of [
  1,
  2,
]) {
  powerCleanup.sequence = 0n;
  powerCleanup.open.clear();
  powerCleanup.closes.length = 0;
  powerCleanup.libraries.length = 0;
  powerCleanup.registeredCloseFailures = failures;
  powerCleanup.rollbackCloseFailed = false;
  const adapter = createOperations({
    dataRoot: ".",
    capabilities: [],
  });
  const registered = adapter.execute(
    "power.startBlocker",
    {
      type: "system",
      reason: "registered",
    },
    "backend",
  );
  assert.throws(
    () =>
      adapter.execute(
        "power.startBlocker",
        {
          type: "display",
          reason: "failed activation",
        },
        "backend",
      ),
    AggregateError,
  );
  assert.deepEqual(adapter.execute("power.listBlockers", null, "backend"), [
    registered,
  ]);
  assert.deepEqual(
    [
      ...powerCleanup.open,
    ],
    [
      1n,
      2n,
    ],
  );
  assert.throws(
    () => adapter.dispose(),
    (error: unknown) => {
      assert(error instanceof AggregateError);
      assert.equal(error.errors.length, failures === 1 ? 1 : 2);
      assert(error.errors.every((cause) => cause instanceof AggregateError));
      return true;
    },
  );
  // The unregistered rollback handle must be retried even while the public close fails.
  assert.deepEqual(powerCleanup.closes, [
    2n,
    1n,
    1n,
    2n,
  ]);
  assert.deepEqual(
    [
      ...powerCleanup.open,
    ],
    failures === 1
      ? []
      : [
          1n,
        ],
  );
  assert.deepEqual(
    powerCleanup.libraries,
    failures === 1
      ? [
          "user32.dll",
          "kernel32.dll",
        ]
      : [],
  );
  assert.throws(
    () => adapter.execute("power.listBlockers", null, "backend"),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "CANCELLED",
  );
  await adapter.dispose();
  await adapter.dispose();
  assert.deepEqual(
    [
      ...powerCleanup.open,
    ],
    [],
  );
  assert.deepEqual(powerCleanup.libraries, [
    "user32.dll",
    "kernel32.dll",
  ]);
  assert.deepEqual(
    powerCleanup.closes,
    failures === 1
      ? [
          2n,
          1n,
          1n,
          2n,
        ]
      : [
          2n,
          1n,
          1n,
          2n,
          1n,
        ],
  );
}
console.log(
  "PASS combined power cleanup failures preserve handle and DLL ownership",
);
