import * as ffi from "bun:ffi";
import { mock } from "bun:test";
import assert from "node:assert/strict";

// A controlled ABI boundary for the scheduled-toast path: a fake ToastNotifier schedule behind real
// vtable slot numbers, so slot or argument mistakes fail here instead of only on Windows.
const E_FAIL = -2147467259;
const E_INVALIDARG = -2147024809;
const WINDOWS_EPOCH_OFFSET_MS = 11_644_473_600_000n;
const MAX_SCHEDULED = 4096;
/** Delivery lead time used by the requests below. */
const LEAD_MS = 90_000;
/** Object ids stay below this bound; vtable addresses (`id * 1000`) are always above it. */
const MAX_OBJECT_ID = 100_000;

type ScheduledRecord = {
  tag: string;
  group: string;
  ticks: bigint;
  suppressPopup: boolean;
  xml: string;
};
type FakeObject = {
  kind: string;
  refs: number;
  /** The schedule entry a scheduledToast or scheduledProperties object reads and writes. */
  record?: ScheduledRecord | undefined;
};

let nextObject = 100;
let stringId = 1_000_000_000;
const objects = new Map<number, FakeObject>();
const strings = new Map<number, string>();
const rawBuffers: Buffer[] = [];
/** HRESULT returned by a `kind:slot` call, to drive failure paths. */
const failures = new Map<string, number>();
/** The fake OS schedule, in insertion order. */
let schedule: ScheduledRecord[] = [];
/** Order of AddToSchedule and RemoveFromSchedule calls. */
const scheduleLog: string[] = [];
let lastXml = "";

const makeObject = (kind: string, record?: ScheduledRecord) => {
  const address = nextObject++;
  objects.set(address, {
    kind,
    refs: 1,
    record,
  });
  return address;
};
const writeBytes = (out: number | bigint, write: (view: DataView) => void) =>
  write(new DataView(ffi.toArrayBuffer(Number(out) as ffi.Pointer, 0, 8)));
const writePointer = (out: number | bigint, value: number) =>
  writeBytes(out, (view) => view.setBigUint64(0, BigInt(value), true));
const outputObject = (out: number | bigint, address: number) => {
  writePointer(out, address);
  return 0;
};
const writeString = (out: number | bigint, text: string) => {
  // An empty HSTRING is a null handle.
  if (text === "") {
    writePointer(out, 0);
    return;
  }
  strings.set(++stringId, text);
  writePointer(out, stringId);
};

/** Fake COM method table, keyed by `kind:slot`. Returns an HRESULT. */
function dispatch(
  object: number,
  state: FakeObject,
  slot: number,
  args: (number | bigint)[],
): number {
  const [first = 0, second = 0, third = 0] = args;
  const stage = `${state.kind}:${slot}`;
  const failure = failures.get(stage);
  if (failure !== undefined) {
    return failure;
  }
  if (slot === 2) {
    state.refs--;
    return state.refs;
  }
  switch (stage) {
    case "document:0":
      return outputObject(second, makeObject("xml"));
    case "xml:6":
      lastXml = strings.get(Number(first)) ?? "";
      return 0;
    case "manager2:6":
      return outputObject(first, makeObject("history"));
    case "manager:7":
      return outputObject(second, makeObject("notifier"));
    case "scheduledFactory:6": {
      // CreateScheduledToastNotification(document, DateTime ticks by value, out).
      assert.equal(objects.get(Number(first))?.kind, "document");
      return outputObject(
        third,
        makeObject("scheduledToast", {
          tag: "",
          group: "",
          ticks: BigInt(second),
          suppressPopup: false,
          xml: lastXml,
        }),
      );
    }
    case "scheduledToast:0":
      return outputObject(
        second,
        makeObject("scheduledProperties", state.record),
      );
    case "scheduledToast:7": {
      const { record } = state;
      assert(record);
      writeBytes(first, (view) => view.setBigInt64(0, record.ticks, true));
      return 0;
    }
    case "scheduledProperties:6":
      assert(state.record);
      state.record.tag = strings.get(Number(first)) ?? "";
      return 0;
    case "scheduledProperties:8":
      assert(state.record);
      state.record.group = strings.get(Number(first)) ?? "";
      return 0;
    case "scheduledProperties:10":
      assert(state.record);
      state.record.suppressPopup = first === 1;
      return 0;
    case "scheduledProperties:7":
      assert(state.record);
      writeString(first, state.record.tag);
      return 0;
    case "scheduledProperties:9":
      assert(state.record);
      writeString(first, state.record.group);
      return 0;
    case "notifier:9": {
      // AddToSchedule stores a copy, like the OS does.
      const added = objects.get(Number(first));
      assert(added?.kind === "scheduledToast" && added.record);
      schedule.push({
        ...added.record,
      });
      scheduleLog.push(`add:${added.record.group}/${added.record.tag}`);
      return 0;
    }
    case "notifier:10": {
      const removed = objects.get(Number(first));
      assert(removed?.kind === "scheduledToast" && removed.record);
      const index = schedule.findIndex(
        (entry) =>
          entry.group === removed.record?.group &&
          entry.tag === removed.record.tag &&
          entry.ticks === removed.record.ticks,
      );
      assert(index >= 0, "RemoveFromSchedule names a toast that is scheduled");
      schedule.splice(index, 1);
      scheduleLog.push(`remove:${removed.record.group}/${removed.record.tag}`);
      return 0;
    }
    case "notifier:11": {
      // A snapshot: later schedule changes do not alter a vector already handed out.
      const vector = makeObject("scheduledItems");
      snapshots.set(
        vector,
        schedule.map((entry) => ({
          ...entry,
        })),
      );
      return outputObject(first, vector);
    }
    case "scheduledItems:7":
      writeBytes(first, (view) =>
        view.setUint32(0, snapshots.get(object)?.length ?? 0, true),
      );
      return 0;
    case "scheduledItems:6": {
      const entry = snapshots.get(object)?.[Number(first)];
      assert(entry);
      return outputObject(second, makeObject("scheduledToast", entry));
    }
    default:
      assert.fail(`Unexpected ABI method ${stage}`);
  }
}
const snapshots = new Map<number, ScheduledRecord[]>();

mock.module("bun:ffi", () => ({
  ...ffi,
  read: {
    ...ffi.read,
    ptr: (object: number, offset = 0) =>
      object < MAX_OBJECT_ID ? object * 1000 : object + offset,
  },
  CFunction: ({ ptr: address }: { ptr: number }) => {
    const native = (object: number, ...args: (number | bigint)[]) => {
      const state = objects.get(object);
      assert(state && state.refs > 0, "COM object must remain owned");
      return dispatch(object, state, (address - object * 1000) / 8, args);
    };
    return Object.assign(native, {
      close() {},
    });
  },
  dlopen: () => ({
    close() {},
    symbols: {
      GetCurrentPackageFullName: () => 15700,
      RoInitialize: () => 0,
      RoUninitialize: () => {},
      WindowsCreateString: (
        address: ffi.Pointer,
        size: number,
        output: ffi.Pointer,
      ) => {
        strings.set(
          ++stringId,
          Buffer.from(ffi.toArrayBuffer(address, 0, size * 2)).toString(
            "utf16le",
          ),
        );
        writePointer(output, stringId);
        return 0;
      },
      WindowsDeleteString: (address: number) => {
        assert(strings.delete(address));
        return 0;
      },
      WindowsGetStringRawBuffer: (address: number, length: ffi.Pointer) => {
        const buffer = Buffer.from(strings.get(address) ?? "", "utf16le");
        rawBuffers.push(buffer);
        writeBytes(length, (view) =>
          view.setUint32(0, buffer.length / 2, true),
        );
        return ffi.ptr(buffer);
      },
      RoActivateInstance: (_name: number, output: ffi.Pointer) =>
        outputObject(output, makeObject("document")),
      RoGetActivationFactory: (
        name: number,
        iid: ffi.Pointer,
        output: ffi.Pointer,
      ) => {
        const className = strings.get(name) ?? "";
        const id = Buffer.from(ffi.toArrayBuffer(iid, 0, 16)).toString("hex");
        let kind = "toastFactory";
        if (className.endsWith("ScheduledToastNotification")) {
          // IScheduledToastNotificationFactory e7bed191-0bb9-4189-8394-31761b476fd7 in COM GUID byte order.
          assert.equal(id, "91d1bee7b90b8941839431761b476fd7");
          kind = "scheduledFactory";
        } else if (className.endsWith("Manager")) {
          kind = id.startsWith("3f10ac50") ? "manager" : "manager2";
        }
        return outputObject(output, makeObject(kind));
      },
    },
  }),
}));

const { createWindowsToastDriver } = await import(
  "../../plugins/notification/src/platforms/windows-toasts.ts"
);
const { notificationScheduleSchema } = await import(
  "../../plugins/notification/src/contract.ts"
);

const toEpochMs = (ticks: bigint) =>
  Number(ticks / 10_000n - WINDOWS_EPOCH_OFFSET_MS);
const request = (
  id: string,
  overrides: Record<string, unknown> = {},
  deliverAt = Date.now() + LEAD_MS,
) =>
  notificationScheduleSchema.parse({
    id,
    title: "<&🚀",
    deliverAt,
    ...overrides,
  });
const record = (
  tag: string,
  group = "bunaway",
  ticks = 1n,
): ScheduledRecord => ({
  tag,
  group,
  ticks,
  suppressPopup: false,
  xml: "",
});
/** Every COM object except the notifier and history the driver holds is released, and no HSTRING leaks. */
const assertBalanced = (stage: string) => {
  for (const [address, state] of objects) {
    if (state.kind === "notifier" || state.kind === "history") {
      continue;
    }
    assert.equal(state.refs, 0, `${stage}: ${state.kind} ${address} leaked`);
  }
  assert.equal(strings.size, 0, `${stage}: HSTRING leaked`);
};

const driver = createWindowsToastDriver("test.app");

// A new schedule reaches AddToSchedule with the content, identity, popup flag and tick-exact delivery time.
const deliverAt = Date.now() + LEAD_MS;
driver.schedule(
  request(
    "first",
    {
      suppressPopup: true,
    },
    deliverAt,
  ),
);
assert.equal(schedule.length, 1);
const stored = schedule[0];
assert(stored);
assert.equal(stored.tag, "first");
assert.equal(stored.group, "bunaway");
assert.equal(stored.suppressPopup, true);
assert.equal(toEpochMs(stored.ticks), deliverAt);
assert(stored.xml.includes("&lt;&amp;🚀"));
assertBalanced("schedule");
assert.deepEqual(driver.listScheduled(), [
  {
    id: "first",
    group: "bunaway",
    deliverAt,
  },
]);
assertBalanced("list");

// Another group keeps its own entry; the same identity is replaced after the new toast is accepted.
driver.schedule(request("first", {}, deliverAt + 1_000));
driver.schedule(
  request(
    "first",
    {
      group: "other",
    },
    deliverAt,
  ),
);
assert.deepEqual(
  driver.listScheduled().map((item) => `${item.group}/${item.id}`),
  [
    "bunaway/first",
    "other/first",
  ],
);
assert.equal(
  schedule.find((entry) => entry.group === "bunaway")?.ticks !== undefined &&
    toEpochMs(schedule.find((entry) => entry.group === "bunaway")?.ticks ?? 0n),
  deliverAt + 1_000,
);
assert.deepEqual(scheduleLog, [
  "add:bunaway/first",
  "add:bunaway/first",
  "remove:bunaway/first",
  "add:other/first",
]);
assertBalanced("replace");

// Entries outside the identity contract are not listed and never cancelled, but they count toward the limit.
schedule.push(record("bad tag!"), record(""));
assert.equal(driver.listScheduled().length, 2);
driver.cancelScheduled({
  id: "first",
  group: "other",
});
driver.cancelScheduled({
  id: "missing",
  group: "bunaway",
});
assert.deepEqual(
  schedule.map((entry) => `${entry.group}/${entry.tag}`),
  [
    "bunaway/first",
    "bunaway/bad tag!",
    "bunaway/",
  ],
);
assertBalanced("cancel");

// A full schedule rejects a new identity with BUSY and still replaces an existing one.
schedule = [];
for (let index = 0; index < MAX_SCHEDULED; index++) {
  schedule.push(record(`n${index}`, "bunaway", BigInt(index + 1)));
}
assert.throws(() => driver.schedule(request("extra")), {
  code: "BUSY",
});
driver.schedule(request("n7", {}, deliverAt));
assert.equal(schedule.length, MAX_SCHEDULED);
assertBalanced("limit");
schedule = [];

// Any failing COM step releases every object and string. Scheduling failures never change the schedule.
for (const stage of [
  "notifier:11",
  "scheduledItems:7",
  "scheduledItems:6",
  "scheduledToast:7",
  "scheduledProperties:7",
  "scheduledProperties:9",
  "xml:6",
  "scheduledFactory:6",
  "scheduledProperties:6",
  "scheduledProperties:8",
  "scheduledProperties:10",
  "notifier:9",
]) {
  // One unrelated entry so the steps that read the existing schedule run too.
  schedule = [
    record("old"),
  ];
  failures.set(stage, E_FAIL);
  assert.throws(
    () => driver.schedule(request("fails")),
    {
      code: "INTERNAL",
    },
    stage,
  );
  failures.delete(stage);
  assert.deepEqual(
    schedule,
    [
      record("old"),
    ],
    `${stage}: schedule unchanged`,
  );
  assertBalanced(stage);
}
for (const stage of [
  "notifier:11",
  "scheduledItems:7",
  "scheduledItems:6",
  "scheduledToast:7",
  "scheduledProperties:7",
  "scheduledProperties:9",
  "notifier:10",
]) {
  schedule = [
    record("fails"),
  ];
  failures.set(stage, E_FAIL);
  assert.throws(
    () =>
      stage.startsWith("scheduled") && stage !== "scheduledItems:6"
        ? driver.listScheduled()
        : driver.cancelScheduled({
            id: "fails",
            group: "bunaway",
          }),
    {
      code: "INTERNAL",
    },
    stage,
  );
  failures.delete(stage);
  assertBalanced(stage);
}

// E_INVALIDARG from the OS (a delivery time that passed on the way) is the caller's input error.
for (const stage of [
  "scheduledFactory:6",
  "notifier:9",
]) {
  failures.set(stage, E_INVALIDARG);
  assert.throws(
    () => driver.schedule(request("late")),
    {
      code: "INVALID_ARGUMENT",
    },
    stage,
  );
  failures.delete(stage);
  assertBalanced(stage);
}

// The replaced schedule survives a rejected request, and a removal failure after the add is reported.
schedule = [
  record("keep", "bunaway", 5n),
];
failures.set("notifier:9", E_FAIL);
assert.throws(() => driver.schedule(request("keep")), {
  code: "INTERNAL",
});
failures.delete("notifier:9");
assert.deepEqual(schedule, [
  record("keep", "bunaway", 5n),
]);
failures.set("notifier:10", E_FAIL);
assert.throws(() => driver.schedule(request("keep")), {
  code: "INTERNAL",
});
failures.delete("notifier:10");
assertBalanced("remove-after-add");

driver.dispose();
assert.throws(() => driver.listScheduled(), {
  code: "CANCELLED",
});
for (const state of objects.values()) {
  assert.equal(state.refs, 0, `${state.kind} released by dispose`);
}
