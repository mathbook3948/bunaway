import * as ffi from "bun:ffi";
import { mock } from "bun:test";
import assert from "node:assert/strict";

// An isolated, controlled ABI boundary. Real JSCallback objects and vtables exercise delegate ownership.
const realCFunction = ffi.CFunction;
const realReadPointer = ffi.read.ptr;
let nextObject = 100;
const objects = new Map<
  number,
  {
    kind: string;
    refs: number;
    events: Map<number, ffi.Pointer>;
  }
>();
const strings = new Map<number, string>();
// 5541d8a7-497c-5aa4-86fc-7713adbf2a2c (IReference<DateTime>) in COM GUID byte order.
const REFERENCE_DATE_TIME_HEX = "a7d841557c49a45a86fc7713adbf2a2c";
let stringId = 10000,
  initialized = 0,
  uninitialized = 0,
  packageResult = 15700;
let deferRelease = false;
const delayedReleases: ffi.Pointer[] = [];
let waitHandles = 0;
let failStage = "",
  failRemove = false;
let boxedTicks = 0n,
  expirationSet = 0,
  shown = 0,
  hidden = 0,
  removed = 0,
  cleared = 0,
  groupCleared = 0;
const payloads: string[] = [];
// History items returned by IToastNotificationHistory2.GetHistoryWithId as [tag, group].
let historyItems: [
  string,
  string,
][] = [];
const listedIndex = new Map<number, number>();
const rawBuffers: Buffer[] = [];
const allocatedDelegates: ffi.Pointer[] = [];
/** What the fake Activated argument reports; `input` describes the ValueSet entry for the reply box. */
let activation: {
  arguments: string;
  input:
    | "absent"
    | "missing"
    | {
        type: number;
        text: string;
      };
} = {
  arguments: "",
  input: "absent",
};
/** Interface ids the fake activation objects answer to, filled once the GUID helper is imported. */
const interfaceKinds = new Map<string, string>();
/** Release the test's own reference to an object it created, like the final argument release below. */
const dropReference = (address: number) => {
  const object = objects.get(address);
  assert(object);
  object.refs--;
};
const writeString = (out: ffi.Pointer, text: string) => {
  // An empty HSTRING is a null handle.
  if (text === "") {
    writePointer(out, 0);
    return;
  }
  strings.set(++stringId, text);
  writePointer(out, stringId);
};
const writePointer = (out: ffi.Pointer, value: number) =>
  new DataView(ffi.toArrayBuffer(out, 0, 8)).setBigUint64(
    0,
    BigInt(value),
    true,
  );
const makeObject = (kind: string) => {
  const address = nextObject++;
  objects.set(address, {
    kind,
    refs: 1,
    events: new Map(),
  });
  return address;
};
function callback(
  address: ffi.Pointer,
  slot: number,
  args: ("ptr" | "u32")[],
  ...values: number[]
) {
  const native = realCFunction({
    ptr: realReadPointer(
      realReadPointer(address) as ffi.Pointer,
      slot * 8,
    ) as ffi.Pointer,
    args: [
      "ptr",
      ...args,
    ],
    returns: "i32",
  });
  try {
    return Number(native(address, ...values));
  } finally {
    native.close();
  }
}
/** One vtable call into a fake COM object: the receiver, its vtable slot and the raw arguments. */
type ComCall = {
  object: number;
  state: {
    kind: string;
    refs: number;
    events: Map<number, ffi.Pointer>;
  };
  slot: number;
  /** `kind:slot`, the key most fake methods are matched on. */
  stage: string;
  args: (number | bigint)[];
};
/** A fake method group; it returns the HRESULT or count for a call it owns, otherwise undefined. */
type ComHandler = (call: ComCall) => number | undefined;

/** Writes a new fake object of the given kind to the out-pointer in `args[index]`. */
const outputObject = ({ args }: ComCall, index: number, kind: string) => {
  writePointer(Number(args[index]) as ffi.Pointer, makeObject(kind));
  return 0;
};
const writeUint32 = (out: number | bigint, value: number) =>
  new DataView(ffi.toArrayBuffer(Number(out) as ffi.Pointer, 0, 4)).setUint32(
    0,
    value,
    true,
  );
/** Objects reached while reading an Activated argument; each answers QueryInterface by interface id. */
const activationKinds = new Set([
  "argument",
  "activatedArgs",
  "activatedArgs2",
  "userInput",
  "map",
  "boxed",
  "propertyValue",
]);
/** IToastActivatedEventArgs(2), ValueSet as IMap and the boxed IPropertyValue of a reply. */
const activationMethods: ComHandler = (call) => {
  const { state, stage, args } = call;
  const out = Number(args[0]) as ffi.Pointer;
  if (!activationKinds.has(state.kind)) {
    return undefined;
  }
  if (stage === "activatedArgs:6") {
    writeString(out, activation.arguments);
    return 0;
  }
  if (stage === "activatedArgs2:6") {
    return outputObject(call, 0, "userInput");
  }
  if (stage === "map:8") {
    new DataView(
      ffi.toArrayBuffer(Number(args[1]) as ffi.Pointer, 0, 1),
    ).setUint8(0, activation.input === "missing" ? 0 : 1);
    assert.equal(strings.get(Number(args[0])), "reply");
    return 0;
  }
  if (stage === "map:6") {
    assert.equal(strings.get(Number(args[0])), "reply");
    return outputObject(call, 1, "boxed");
  }
  const value = activation.input;
  if (typeof value === "object" && stage === "propertyValue:6") {
    new DataView(ffi.toArrayBuffer(out, 0, 4)).setInt32(0, value.type, true);
    return 0;
  }
  if (typeof value === "object" && stage === "propertyValue:19") {
    writeString(out, value.text);
    return 0;
  }
  return undefined;
};
/** IUnknown: slot 2 releases a reference and slot 0 queries the interface the fixture expects next. */
const unknownMethods: ComHandler = (call) => {
  const { object, state, slot, args } = call;
  if (slot === 2) {
    state.refs--;
    return state.refs;
  }
  if (slot !== 0) {
    return undefined;
  }
  if (state.kind === "history") {
    return outputObject(call, 1, "history2");
  }
  if (activationKinds.has(state.kind)) {
    const iid = Buffer.from(
      ffi.toArrayBuffer(Number(args[0]) as ffi.Pointer, 0, 16),
    ).toString("hex");
    const kind = interfaceKinds.get(iid);
    return kind ? outputObject(call, 1, kind) : -2147467262;
  }
  if (state.kind === "dateTimeBox") {
    // The setter needs IReference<DateTime>, so the boxed IInspectable must be queried for exactly that interface.
    const iid = Buffer.from(
      ffi.toArrayBuffer(Number(args[0]) as ffi.Pointer, 0, 16),
    ).toString("hex");
    assert.equal(iid, REFERENCE_DATE_TIME_HEX);
    return outputObject(call, 1, "referenceDateTime");
  }
  if (state.kind === "listed") {
    const address = makeObject("listedProperties");
    listedIndex.set(address, listedIndex.get(object) ?? -1);
    writePointer(Number(args[1]) as ffi.Pointer, address);
    return 0;
  }
  return outputObject(
    call,
    1,
    state.kind === "document" ? "xml" : "properties",
  );
};
/** Activation-side objects: the manager, its history, the toast factory and the XML document. */
const factoryMethods: ComHandler = (call) => {
  const { stage, args } = call;
  if (stage === "manager:7") {
    assert.equal(strings.get(Number(args[0])), "test.app");
    return outputObject(call, 1, "notifier");
  }
  if (stage === "manager2:6") {
    return outputObject(call, 0, "history");
  }
  if (stage === "factory:6") {
    return outputObject(call, 1, "toast");
  }
  // IPropertyValueStatics.CreateDateTime(21) boxes the expiration ticks passed by value.
  if (stage === "factory:21") {
    boxedTicks = BigInt(args[0] ?? 0);
    return outputObject(call, 1, "dateTimeBox");
  }
  if (stage === "xml:6") {
    payloads.push(strings.get(Number(args[0])) ?? "");
    return 0;
  }
  return undefined;
};
/** Toast history: item count, item lookup and the tag and group properties of a listed item. */
const historyListMethods: ComHandler = (call) => {
  const { object, slot, stage, args } = call;
  if (stage === "history2:7") {
    assert.equal(strings.get(Number(args[0])), "test.app");
    return outputObject(call, 1, "items");
  }
  if (stage === "items:7") {
    writeUint32(args[0] ?? 0, historyItems.length);
    return 0;
  }
  if (stage === "items:6") {
    const address = makeObject("listed");
    listedIndex.set(address, Number(args[0]));
    writePointer(Number(args[1]) as ffi.Pointer, address);
    return 0;
  }
  if (stage === "listedProperties:7" || stage === "listedProperties:9") {
    const owner = listedIndex.get(object);
    assert(owner !== undefined);
    const item = historyItems[owner];
    assert(item);
    const text = item[slot === 7 ? 0 : 1];
    // An empty HSTRING is a null handle.
    if (text === "") {
      writePointer(Number(args[0]) as ffi.Pointer, 0);
    } else {
      strings.set(++stringId, text);
      writePointer(Number(args[0]) as ffi.Pointer, stringId);
    }
    return 0;
  }
  return undefined;
};
/** Notifier and history actions the fixture counts, plus the property and argument objects. */
const actionMethods: ComHandler = ({ state, slot, stage, args }) => {
  if (state.kind === "properties") {
    assert(
      [
        6,
        8,
        10,
      ].includes(slot),
    );
    return 0;
  }
  // IToastNotification.put_ExpirationTime(7) receives the boxed DateTime.
  if (stage === "toast:7") {
    assert.equal(objects.get(Number(args[0]))?.kind, "referenceDateTime");
    expirationSet++;
    return 0;
  }
  if (stage === "notifier:6") {
    shown++;
    return 0;
  }
  if (stage === "notifier:7") {
    hidden++;
    return 0;
  }
  if (stage === "history:12") {
    assert.equal(strings.get(Number(args[0])), "test.app");
    cleared++;
    return 0;
  }
  if (stage === "history:7") {
    assert.equal(strings.get(Number(args[1])), "test.app");
    groupCleared++;
    return 0;
  }
  if (stage === "history:8") {
    assert.equal(strings.get(Number(args[2])), "test.app");
    removed++;
    return 0;
  }
  if (state.kind === "argument" && slot === 6) {
    new DataView(
      ffi.toArrayBuffer(Number(args[0]) as ffi.Pointer, 0, 4),
    ).setInt32(0, 2, true);
    return 0;
  }
  return undefined;
};
/** Toast event registration: add slots keep the delegate, remove slots revoke it. */
const toastEventMethods: ComHandler = ({ state, slot, args }) => {
  if (state.kind !== "toast") {
    return undefined;
  }
  if (
    [
      9,
      11,
      13,
    ].includes(slot)
  ) {
    const delegate = Number(args[0]) as ffi.Pointer;
    allocatedDelegates.push(delegate);
    callback(delegate, 1, []);
    state.events.set(slot + 1, delegate);
    writePointer(Number(args[1]) as ffi.Pointer, slot);
    return 0;
  }
  if (
    [
      10,
      12,
      14,
    ].includes(slot)
  ) {
    if (failRemove) {
      return -2147467259;
    }
    const delegate = state.events.get(slot);
    assert(delegate);
    if (deferRelease) {
      delayedReleases.push(delegate);
    } else {
      callback(delegate, 2, []);
    }
    state.events.delete(slot);
    return 0;
  }
  return undefined;
};
const comHandlers: ComHandler[] = [
  unknownMethods,
  factoryMethods,
  historyListMethods,
  activationMethods,
  actionMethods,
  toastEventMethods,
];
mock.module("bun:ffi", () => ({
  ...ffi,
  read: {
    ...ffi.read,
    ptr: (object: number, offset = 0) =>
      object < 10000 ? object * 1000 : object + offset,
  },
  CFunction: ({ ptr: address }: { ptr: number }) => {
    const native = (object: number, ...args: (number | bigint)[]) => {
      const state = objects.get(object);
      assert(state && state.refs > 0, "COM object must remain owned");
      const slot = (address - object * 1000) / 8;
      const stage = `${state.kind}:${slot}`;
      if (stage === failStage) {
        return -2147467259;
      }
      const call: ComCall = {
        object,
        state,
        slot,
        stage,
        args,
      };
      for (const handle of comHandlers) {
        const result = handle(call);
        if (result !== undefined) {
          return result;
        }
      }
      assert.fail(`Unexpected ABI method ${stage}`);
    };
    return Object.assign(native, {
      close() {},
    });
  },
  dlopen: (_name: string) => ({
    close() {},
    symbols: {
      // The shared KERNEL32 table returns the event HANDLE as u64.
      CreateEventW: () => {
        waitHandles++;
        return 123456n;
      },
      CloseHandle: () => {
        waitHandles--;
        return 1;
      },
      CoWaitForMultipleHandles: (
        flags: number,
        timeout: number,
        count: number,
      ) => {
        assert.equal(flags, 0);
        assert.equal(timeout, 5);
        assert.equal(count, 1);
        for (const delegate of delayedReleases.splice(0)) {
          callback(delegate, 2, []);
        }
        return -2147417835; // RPC_S_CALLPENDING
      },
      GetCurrentPackageFullName: () => packageResult,
      RoInitialize: (mode: number) => {
        assert.equal(mode, 0);
        initialized++;
        return 0;
      },
      RoUninitialize: () => {
        uninitialized++;
      },
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
        new DataView(ffi.toArrayBuffer(length, 0, 4)).setUint32(
          0,
          buffer.length / 2,
          true,
        );
        return ffi.ptr(buffer);
      },
      RoActivateInstance: (_name: number, output: ffi.Pointer) => {
        writePointer(output, makeObject("document"));
        return 0;
      },
      RoGetActivationFactory: (
        name: number,
        iid: ffi.Pointer,
        output: ffi.Pointer,
      ) => {
        const id = Buffer.from(ffi.toArrayBuffer(iid, 0, 16)).toString("hex");
        let kind = "factory";
        if (strings.get(name)?.endsWith("Manager")) {
          kind = id.startsWith("3f10ac50") ? "manager" : "manager2";
        }
        writePointer(output, makeObject(kind));
        return 0;
      },
    },
  }),
}));
const { createWindowsToastDriver } = await import(
  "../../plugins/notification/src/platforms/windows-toasts.ts"
);
const { notificationShowSchema } = await import(
  "../../plugins/notification/src/contract.ts"
);
const { guid } = await import(
  "../../plugins/notification/src/platforms/toast-winrt.ts"
);
const guidBytes = guid;
interfaceKinds.set(
  guidBytes("e3bf92f3-c197-436f-8265-0625824f8dac").toString("hex"),
  "activatedArgs",
);
interfaceKinds.set(
  guidBytes("ab7da512-cc61-568e-81be-304ac31038fa").toString("hex"),
  "activatedArgs2",
);
interfaceKinds.set(
  guidBytes("1b0d3570-0877-5ec2-8a2c-3b9539506aca").toString("hex"),
  "map",
);
interfaceKinds.set(
  guidBytes("4bd682dd-7554-40e9-9a9b-82654ede7e62").toString("hex"),
  "propertyValue",
);
const input = notificationShowSchema.parse({
  id: "fixture",
  title: "<&🚀",
  silent: true,
});
const events: unknown[] = [];
packageResult = 122;
assert.throws(() => createWindowsToastDriver("test.app"), {
  code: "UNSUPPORTED",
});
packageResult = 15700;
const driver = createWindowsToastDriver("test.app");
const handle = driver.show(input, (event) => events.push(event));
assert.equal(shown, 1);
assert(payloads[0]?.includes("&lt;&amp;🚀"));
const latest = [
  ...objects.values(),
]
  .reverse()
  .find((value) => value.kind === "toast");
assert(latest);
const argument = makeObject("argument");
for (const [removeSlot, delegate] of latest.events) {
  const iid = guid("94ea2b94-e9cc-49e0-c0ff-ee64ca8f5b90"); // IAgileObject must be rejected.
  const out = new BigUint64Array(1);
  assert.equal(
    callback(
      delegate,
      0,
      [
        "ptr",
        "ptr",
      ],
      ffi.ptr(iid),
      ffi.ptr(out),
    ),
    -2147467262,
  );
  assert.equal(out[0], 0n);
  assert.equal(
    callback(
      delegate,
      3,
      [
        "ptr",
        "ptr",
      ],
      0,
      argument,
    ),
    0,
    `Invoke ${removeSlot}`,
  );
}
await Promise.resolve();
assert.deepEqual(events, [
  {
    kind: "activated",
    arguments: "",
    reply: undefined,
  },
  {
    kind: "dismissed",
    reason: "timedOut",
  },
  {
    kind: "failed",
    hresult: 2,
  },
]);
failRemove = true;
assert.throws(() => handle.detach(), {
  code: "INTERNAL",
});
// Ownership remains live after failed revocation; delayed callback is ignored, not freed.
const firstDelegate = allocatedDelegates[0];
assert(firstDelegate);
assert.equal(
  callback(
    firstDelegate,
    3,
    [
      "ptr",
      "ptr",
    ],
    0,
    argument,
  ),
  0,
);
await Promise.resolve();
assert.equal(events.length, 3);
failRemove = false;
handle.detach();
handle.detach();
for (const stage of [
  "xml:6",
  "factory:6",
  "properties:6",
  "properties:8",
  "properties:10",
  "toast:11",
  "toast:9",
  "toast:13",
  "notifier:6",
]) {
  failStage = stage;
  assert.throws(
    () => driver.show(input, () => {}),
    {
      code: "INTERNAL",
    },
    stage,
  );
  assert.equal(strings.size, 0);
}
// expiresAfterSeconds boxes a DateTime and assigns it to the toast. Each failure releases both objects.
const expiring = notificationShowSchema.parse({
  id: "expiring",
  title: "Expires",
  expiresAfterSeconds: 90,
});
for (const stage of [
  "factory:21",
  "toast:7",
]) {
  failStage = stage;
  assert.throws(
    () => driver.show(expiring, () => {}),
    {
      code: "INTERNAL",
    },
    stage,
  );
  assert.equal(strings.size, 0);
}
failStage = "";
assert.equal(expirationSet, 0);
const ticksBefore = BigInt(Date.now());
const expiringHandle = driver.show(expiring, () => {});
const ticksAfter = BigInt(Date.now());
const windowsEpochOffsetMs = 11_644_473_600_000n;
assert.equal(expirationSet, 1);
assert(
  boxedTicks >= (ticksBefore + windowsEpochOffsetMs) * 10_000n + 900_000_000n &&
    boxedTicks <= (ticksAfter + windowsEpochOffsetMs) * 10_000n + 900_000_000n,
  "Expiration is now plus 90 seconds in 100 ns ticks since 1601",
);
expiringHandle.detach();
failStage = "notifier:6";
failRemove = true;
assert.throws(() => driver.show(input, () => {}), AggregateError);
const beforeBlockedShow = objects.size;
assert.throws(() => driver.show(input, () => {}), {
  code: "INTERNAL",
});
assert.equal(
  objects.size,
  beforeBlockedShow,
  "Failed callback ownership must block new allocations",
);
failRemove = false;
failStage = "";
const second = driver.show(input, () => {});
driver.clear({
  id: "fixture",
  group: "bunaway",
});
assert.equal(hidden, 1);
assert.equal(removed, 1);
// clearAll hides every owned toast, then ClearWithId (history slot 12) clears the app ID's records.
driver.clearAll();
assert.equal(hidden, 2);
assert.equal(cleared, 1);
failStage = "history:12";
assert.throws(() => driver.clearAll(), {
  code: "INTERNAL",
});
failStage = "";
// clearGroup hides only the owned toasts of that group, then RemoveGroupWithId (history slot 7) clears
// the group's records of the app ID.
const hiddenBeforeGroup = hidden;
driver.clearGroup("other");
assert.equal(hidden, hiddenBeforeGroup, "A different group keeps its toasts");
assert.equal(groupCleared, 1);
driver.clearGroup("bunaway");
assert.equal(
  hidden,
  hiddenBeforeGroup + 1,
  "The owned toast of the group is hidden",
);
assert.equal(groupCleared, 2);
failStage = "history:7";
assert.throws(() => driver.clearGroup("bunaway"), {
  code: "INTERNAL",
});
failStage = "";
// list reads Tag/Group of every history item of the app ID and omits items outside the identity contract.
assert.deepEqual(driver.list(), []);
historyItems = [
  [
    "first",
    "bunaway",
  ],
  [
    "",
    "bunaway",
  ],
  [
    "bad tag!",
    "bunaway",
  ],
  [
    "한글",
    "grp",
  ],
  [
    "second",
    "other",
  ],
];
assert.deepEqual(driver.list(), [
  {
    id: "first",
    group: "bunaway",
  },
  {
    id: "second",
    group: "other",
  },
]);
for (const stage of [
  "history2:7",
  "items:7",
  "items:6",
  "listedProperties:7",
  "listedProperties:9",
]) {
  failStage = stage;
  assert.throws(() => driver.list(), {
    code: "INTERNAL",
  });
}
failStage = "";
// Activation: the activator arguments and the typed reply are copied from the borrowed argument.
const replyInput = notificationShowSchema.parse({
  id: "reply",
  title: "reply",
  actions: [
    {
      id: "ok",
      label: "OK",
    },
  ],
  reply: {
    buttonLabel: "Send",
  },
});
const activations: unknown[] = [];
const replyHandle = driver.show(replyInput, (event) => activations.push(event));
const replyToast = [
  ...objects.values(),
]
  .reverse()
  .find((value) => value.kind === "toast");
assert(replyToast);
const activate = async (
  next: typeof activation,
  expected: unknown[],
  stage = "",
) => {
  activation = next;
  failStage = stage;
  const replyArgument = makeObject("argument");
  const delegate = replyToast.events.get(12);
  assert(delegate);
  assert.equal(
    callback(
      delegate,
      3,
      [
        "ptr",
        "ptr",
      ],
      0,
      replyArgument,
    ),
    0,
  );
  failStage = "";
  dropReference(replyArgument);
  await Promise.resolve();
  assert.deepEqual(activations.splice(0), expected, JSON.stringify(next));
};
await activate(
  {
    arguments: "action:ok",
    input: {
      type: 12,
      text: "hello 한글",
    },
  },
  [
    {
      kind: "activated",
      arguments: "action:ok",
      reply: "hello 한글",
    },
  ],
);
await activate(
  {
    arguments: "reply",
    input: {
      type: 12,
      text: "",
    },
  },
  [
    {
      kind: "activated",
      arguments: "reply",
      reply: "",
    },
  ],
);
// A missing key means nothing was typed; a value that is not a string drops the activation, never a guess.
await activate(
  {
    arguments: "reply",
    input: "missing",
  },
  [
    {
      kind: "activated",
      arguments: "reply",
      reply: "",
    },
  ],
);
await activate(
  {
    arguments: "reply",
    input: {
      type: 3,
      text: "",
    },
  },
  [],
);
// A body click never reads the reply, so a broken UserInput cannot lose it.
await activate(
  {
    arguments: "",
    input: "absent",
  },
  [
    {
      kind: "activated",
      arguments: "",
      reply: undefined,
    },
  ],
  "activatedArgs2:6",
);
// Any failing COM step drops the activation and still releases every object and string.
for (const stage of [
  "argument:0",
  "activatedArgs:6",
  "activatedArgs2:6",
  "userInput:0",
  "map:8",
  "map:6",
  "boxed:0",
  "propertyValue:6",
  "propertyValue:19",
]) {
  await activate(
    {
      arguments: "reply",
      input: {
        type: 12,
        text: "x",
      },
    },
    [],
    stage,
  );
}
deferRelease = true;
const { drainToastCleanup } = await import(
  "../../plugins/notification/src/platforms/toast-cleanup.ts"
);
await drainToastCleanup(() => {
  second.detach();
  replyHandle.detach();
});
assert.equal(waitHandles, 0);
assert.equal(delayedReleases.length, 0);
driver.dispose();
driver.dispose();
const argumentObject = objects.get(argument);
assert(argumentObject);
argumentObject.refs--;
assert(
  [
    ...objects.values(),
  ].every((object) => object.refs === 0),
  "Every COM object must be released",
);
assert.equal(initialized, uninitialized);
assert.equal(strings.size, 0);
assert.throws(() => driver.show(input, () => {}), {
  code: "CANCELLED",
});

deferRelease = false;

// Exercise the generated adapter boundary: denied, malformed and cancelled requests never reach Show.
const { default: definition } = await import(
  "../../plugins/notification/src/index.ts"
);
const { nativeFactory } = await import("./native-platform.ts");
const factory = nativeFactory(definition, "windows");
const published: string[] = [];
const adapter = factory({
  dataRoot: ".",
  capabilities: [],
  app: {
    id: "test.app",
    launch: {
      mode: "packaged",
      executablePath: process.execPath,
      args: [],
    },
  },
  windows: {
    specs: [],
    read: () => undefined,
    create() {},
    close: () => true,
    window() {
      throw new Error("No fixture windows");
    },
    stopping: () => false,
    cancelled: () => false,
    now: Date.now,
    tick: () => Promise.resolve(),
    systemEvents: {
      subscribe: () => () => {},
      publish(event, _payload, permission) {
        assert.equal(permission, "notification.show");
        published.push(event);
      },
    },
  },
});
const executeUI = adapter.executeUI;
assert(executeUI);
const invokeUI = async (...args: Parameters<typeof executeUI>) =>
  executeUI(...args);
const beforeDenied = shown;
const request = {
  requestId: "fixture",
  permissions: {
    permissions: [
      "notification.show",
      "notification.clear",
    ],
  },
};
await assert.rejects(
  invokeUI(
    "notification.show",
    {
      id: "api",
      title: "fixture",
    },
    "backend",
    {
      ...request,
      permissions: {
        permissions: [],
      },
    },
  ),
  {
    code: "PERMISSION_DENIED",
  },
);
await assert.rejects(
  invokeUI(
    "notification.show",
    {
      id: "api",
      title: "bad\0",
    },
    "backend",
    request,
  ),
  {
    code: "INVALID_ARGUMENT",
  },
);
const abort = new AbortController();
abort.abort();
await assert.rejects(
  invokeUI(
    "notification.show",
    {
      id: "api",
      title: "fixture",
    },
    "backend",
    {
      ...request,
      signal: abort.signal,
    },
  ),
);
assert.equal(shown, beforeDenied);
await invokeUI(
  "notification.show",
  {
    id: "api",
    title: "fixture",
    data: "opaque",
  },
  "backend",
  request,
);
const apiToast = [
  ...objects.values(),
]
  .reverse()
  .find((value) => value.kind === "toast");
assert(apiToast);
const activated = apiToast.events.get(12);
assert(activated);
// A body click carries no activator arguments.
activation = {
  arguments: "",
  input: "absent",
};
// A toast without buttons or reply box never reads the argument, so even a null one is a body click.
callback(
  activated,
  3,
  [
    "ptr",
    "ptr",
  ],
  0,
  0,
);
await Promise.resolve();
assert.deepEqual(published, [
  "notification.clicked",
]);
// Event revocation may enqueue Release to this STA before the ordinary UI pump gets a turn.
deferRelease = true;
await invokeUI(
  "notification.clear",
  {
    id: "api",
  },
  "backend",
  request,
);
assert.equal(delayedReleases.length, 0);
assert.equal(waitHandles, 0);
await adapter.dispose();
await adapter.dispose();
assert.equal(initialized, uninitialized);
assert(
  [
    ...objects.values(),
  ].every((object) => object.refs === 0),
);
