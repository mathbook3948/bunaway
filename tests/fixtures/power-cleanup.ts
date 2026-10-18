import assert from "node:assert/strict";
import type { NativeWindowServices } from "@bunaway/plugin-api/native";
import power from "../../plugins/power/src/index.ts";
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
  const platform = power._definition.nativePlatforms.windows;
  assert(platform);
  const adapter = platform.create({
    dataRoot: ".",
    capabilities: [],
  });
  const registered = await adapter.execute(
    "power.startBlocker",
    {
      type: "system",
      reason: "registered",
    },
    "backend",
  );
  await assert.rejects(
    async () =>
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
  assert.deepEqual(
    await adapter.execute("power.listBlockers", null, "backend"),
    [
      registered,
    ],
  );
  assert.deepEqual(
    [
      ...powerCleanup.open,
    ],
    [
      1n,
      2n,
    ],
  );
  await assert.rejects(
    async () => await adapter.dispose(),
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
          "powrprof.dll",
          "user32.dll",
          "kernel32.dll",
        ]
      : [],
  );
  await assert.rejects(
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
    "powrprof.dll",
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

/** Create the adapter with only the system event service that the power plugin reads. */
function createWithSystemEvents(
  systemEvents: NonNullable<NativeWindowServices["systemEvents"]>,
) {
  const platform = power._definition.nativePlatforms.windows;
  assert(platform);
  return platform.create({
    dataRoot: ".",
    capabilities: [],
    // Invariant: the power plugin reads only windows.systemEvents, so the other window services
    // are omitted and this cast never exposes a missing member to the adapter.
    windows: {
      systemEvents,
    } as unknown as NativeWindowServices,
  });
}
function resetCleanup() {
  powerCleanup.sequence = 0n;
  powerCleanup.open.clear();
  powerCleanup.closes.length = 0;
  powerCleanup.libraries.length = 0;
  powerCleanup.registeredCloseFailures = 0;
  powerCleanup.rollbackCloseFailed = false;
}

// A failing subscription release must not skip blocker and native cleanup, and can be retried.
// The adapter holds three independent subscriptions: status, suspend/resume and session lock.
resetCleanup();
let unsubscribes = 0;
let failUnsubscribe = true;
const withEvents = createWithSystemEvents({
  subscribe() {
    return () => {
      unsubscribes++;
      if (failUnsubscribe) {
        throw new Error("unsubscribe failed");
      }
    };
  },
  publish() {},
});
const owned = await withEvents.execute(
  "power.startBlocker",
  {
    type: "system",
    reason: "with events",
  },
  "backend",
);
assert.equal(powerCleanup.open.size, 1);
await assert.rejects(
  async () => await withEvents.dispose(),
  (error: unknown) => {
    assert(error instanceof AggregateError);
    // The status release error, then the lifecycle release aggregating its two subscriptions.
    assert.equal(error.errors.length, 2);
    assert.equal(error.errors[0].message, "unsubscribe failed");
    const lifecycle = error.errors[1];
    assert(lifecycle instanceof AggregateError);
    assert.equal(lifecycle.errors.length, 2);
    return true;
  },
);
assert.equal(unsubscribes, 3);
assert.deepEqual(
  [
    ...powerCleanup.open,
  ],
  [],
);
assert.deepEqual(powerCleanup.libraries, [
  "powrprof.dll",
  "user32.dll",
  "kernel32.dll",
]);
failUnsubscribe = false;
await withEvents.dispose();
await withEvents.dispose();
// The retry releases every subscription again and later disposals find nothing to release.
assert.equal(unsubscribes, 6);
assert.ok(owned);

// A failed subscription during initialization releases the DLLs acquired for the adapter.
resetCleanup();
assert.throws(
  () =>
    createWithSystemEvents({
      subscribe() {
        throw new Error("subscribe failed");
      },
      publish() {},
    }),
  /subscribe failed/,
);
assert.deepEqual(powerCleanup.libraries, [
  "powrprof.dll",
  "user32.dll",
  "kernel32.dll",
]);
console.log(
  "PASS combined power cleanup failures preserve handle and DLL ownership",
);
