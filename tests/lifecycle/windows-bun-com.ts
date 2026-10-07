import { dlopen, JSCallback, type Pointer, ptr, toArrayBuffer } from "bun:ffi";
import assert from "node:assert/strict";
import { ViewBoundary } from "../../native/windows/bun/boundary.ts";
import type { Packet } from "../../native/windows/bun/channel.ts";
import {
  checkCallbacks,
  disposeCom,
  getString,
  handler,
  method,
} from "../../native/windows/bun/com.ts";
import {
  MAX_MESSAGE_BYTES,
  PROTOCOL_VERSION,
} from "../../packages/protocol/src/index.ts";

// Execute in a separate process so COM callback/binding disposal cannot affect other tests.
const api = dlopen("ole32.dll", {
  CoTaskMemAlloc: {
    args: [
      "u64",
    ],
    returns: "ptr",
  },
});
let raw = "x".repeat(MAX_MESSAGE_BYTES + 1);
const getter = new JSCallback(
  (_self, out) => {
    const bytes = Buffer.from(`${raw}\0`, "utf16le");
    const address = api.symbols.CoTaskMemAlloc(BigInt(bytes.length));
    assert(address);
    new Uint8Array(toArrayBuffer(address, 0, bytes.length)).set(bytes);
    new DataView(toArrayBuffer(out as Pointer, 0, 8)).setBigUint64(
      0,
      BigInt(address),
      true,
    );
    return 0;
  },
  {
    args: [
      "ptr",
      "ptr",
    ],
    returns: "i32",
  },
);
const vtable = new BigUint64Array(5);
assert(getter.ptr);
vtable[4] = BigInt(getter.ptr);
const object = new BigUint64Array([
  BigInt(ptr(vtable)),
]);
const packets: Packet[] = [];
const rejected: string[] = [];
const source = "https://app.bunaway.local/index.html";
const boundary = new ViewBoundary(
  {
    id: "main",
    origins: [
      "https://app.bunaway.local",
    ],
    commands: [],
    events: [],
    host: {
      permissions: [],
    },
  },
  {
    origin: (text) => new URL(text).origin,
    source: () => source,
    ready: () => true,
    forward: (packet) => {
      packets.push(packet);
    },
    capacity: () => true,
    deliver: () => {},
    log: (event) => {
      if (event === "web-message-rejected") {
        rejected.push(event);
      }
    },
  },
);
const callback = handler(
  "web-message",
  "57213f19-00e6-49fa-8e07-898ea01ecbd2",
  [
    "ptr",
    "ptr",
  ],
  (_sender, args) => {
    boundary.receive(source, getString(args as Pointer, 4));
  },
);
try {
  const invoke = method(callback.pointer, 3, [
    "ptr",
    "ptr",
  ]);
  assert.equal(invoke(null, ptr(object)), 0);
  checkCallbacks();
  assert.equal(rejected.length, 1);
  assert.equal(packets.length, 0);
  // A supported-size string is never truncated, including the exact character limit.
  raw = "x".repeat(MAX_MESSAGE_BYTES);
  assert.equal(getString(ptr(object), 4), raw);
  raw = JSON.stringify({
    kind: "hello",
    protocol: PROTOCOL_VERSION,
    features: [],
    buildId: "test",
  });
  assert.equal(invoke(null, ptr(object)), 0);
  checkCallbacks();
  assert.equal(packets[0]?.kind, "session-open");
  console.log(
    "PASS oversized native string rejected; COM and subsequent session stay usable",
  );
} finally {
  disposeCom();
  getter.close();
  api.close();
}
