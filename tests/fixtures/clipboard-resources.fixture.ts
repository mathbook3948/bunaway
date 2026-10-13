import assert from "node:assert/strict";
import type { JsonValue } from "@bunaway/protocol";
import {
  encodeHTML,
  MAX_NATIVE_FORMAT_BYTES,
} from "#plugins/clipboard/src/codecs";
import { createOperations } from "#plugins/clipboard/src/platforms/windows";
import { createClipboard } from "#plugins/clipboard/src/win32";
import { state } from "./clipboard-ffi.ts";

const environment = {
  dataRoot: ".",
  capabilities: [],
};
const context = {
  requestId: "test",
  permissions: {
    permissions: [
      "clipboard.readText",
      "clipboard.writeText",
      "clipboard.clear",
      "clipboard.readImage",
      "clipboard.writeImage",
      "clipboard.getFormats",
      "clipboard.hasFormat",
      "clipboard.readFormats",
      "clipboard.writeFormats",
    ],
  },
};
const hasCode = (code: string) => (error: unknown) =>
  error instanceof Error && "code" in error && error.code === code;

for (const failure of [
  "kernel32.dll",
  "create",
]) {
  state.fail = failure;
  assert.throws(createClipboard);
  assert.equal(state.libraries, 0);
  assert.equal(state.windows, 0);
}
state.fail = "";
const unclosed = createClipboard();
assert.equal(unclosed.open(), true);
state.fail = "close";
assert.throws(() => unclosed.close(), hasCode("INTERNAL"));
assert.throws(() => unclosed.open(), hasCode("INTERNAL"));
state.fail = "";
unclosed.dispose();
assert.equal(state.opened, false);
assert.equal(state.windows, 0);
assert.equal(state.libraries, 0);
const adapter = createOperations(environment);
assert(adapter.executeUI);
const execute = (name: string, input: JsonValue = null, signal?: AbortSignal) =>
  adapter.executeUI?.(`clipboard.${name}`, input, "backend", {
    ...context,
    ...(signal
      ? {
          signal,
        }
      : {}),
  });
assert.throws(
  () => adapter.execute("clipboard.clear", null, "backend"),
  hasCode("UNSUPPORTED"),
);
await assert.rejects(
  async () =>
    adapter.executeUI?.("clipboard.clear", null, "backend", {
      ...context,
      permissions: {
        permissions: [
          "clipboard.writeText",
        ],
      },
    }),
  hasCode("PERMISSION_DENIED"),
);
await assert.rejects(async () => execute("missing"), hasCode("UNSUPPORTED"));
await assert.rejects(
  async () =>
    execute("writeText", {
      text: "bad\0text",
    }),
  hasCode("INVALID_ARGUMENT"),
);
assert.equal(state.clears, 0);

for (const failure of [
  "alloc",
  "lock",
  "empty",
  "set",
]) {
  state.fail = failure;
  const clears: number = state.clears;
  const frees = state.frees;
  await assert.rejects(
    async () =>
      execute("writeText", {
        text: "new 😀",
      }),
    hasCode("INTERNAL"),
  );
  assert.equal(state.opened, false);
  assert.equal(state.locks, 0);
  assert.equal(state.allocations.size, 0);
  assert.equal(state.frees - frees, failure === "alloc" ? 0 : 1);
  assert.equal(state.clears - clears, failure === "set" ? 1 : 0);
}
state.fail = "";
const frees = state.frees;
await execute("writeText", {
  text: "한글 😀\n\r\n",
});
assert.equal(state.transferred, 1);
assert.equal(state.frees, frees);
assert.equal(await execute("readText"), "한글 😀\n\r\n");
assert.equal(state.locks, 0);
assert.equal(state.frees, frees, "Read handles belong to Windows");
await execute("writeText", {
  text: "",
});
assert.equal(await execute("readText"), "");
await execute("clear");
assert.equal(await execute("readText"), null);
state.format = true;
for (const bytes of [
  Buffer.from("unterminated", "utf16le"),
  Buffer.from([
    1,
  ]),
  Buffer.from("\ud800\0", "utf16le"),
  Buffer.alloc(70_000),
]) {
  state.data = bytes;
  await assert.rejects(async () => execute("readText"), hasCode("INTERNAL"));
  assert.equal(state.opened, false);
  assert.equal(state.locks, 0);
}
state.data = Buffer.from("old\0", "utf16le");
for (const failure of [
  "get",
  "lock",
]) {
  state.fail = failure;
  await assert.rejects(async () => execute("readText"), hasCode("INTERNAL"));
  assert.equal(state.opened, false);
}
state.fail = "";
state.fail = "register";
await assert.rejects(
  async () =>
    execute("hasFormat", {
      format: "text/html",
    }),
  hasCode("INTERNAL"),
);
state.fail = "";
const image = {
  width: 1,
  height: 1,
  rgba: "AQIDBA==",
};
const items = [
  {
    format: "text/plain",
    data: "fallback 한글",
  },
  {
    format: "text/html",
    data: "<b>한글 😀</b>",
  },
  {
    format: "text/rtf",
    data: "{\\rtf1 \\u54620?}",
  },
  {
    format: "application/x-bunaway-file-list",
    data: [
      "C:\\한글\\memo.txt",
    ],
  },
  {
    format: "image/bmp",
    data: image,
  },
];
await execute("writeFormats", {
  items,
});
assert.deepEqual(
  await execute("getFormats"),
  items.map((item) => item.format),
);
assert.deepEqual(
  await execute("readFormats", {
    formats: items.map((item) => item.format),
  }),
  items,
);
assert.deepEqual(await execute("readImage"), image);
assert.equal(
  await execute("hasFormat", {
    format: "text/html",
  }),
  true,
);
assert.equal(state.opened, false);
assert.equal(state.locks, 0);
assert.equal(state.allocations.size, 0);
await execute("writeImage", image);
assert.equal(await execute("readText"), null);
assert.equal(
  await execute("hasFormat", {
    format: "text/html",
  }),
  false,
);
assert.deepEqual(
  await execute("readFormats", {
    formats: [
      "text/html",
      "image/bmp",
    ],
  }),
  [
    {
      format: "text/html",
      data: null,
    },
    {
      format: "image/bmp",
      data: image,
    },
  ],
);
// Partial preparation must preserve existing image data and free the first allocation.
state.failAtAllocation = state.allocationCalls + 2;
const beforePrepare = state.clears;
await assert.rejects(
  async () =>
    execute("writeFormats", {
      items,
    }),
  hasCode("INTERNAL"),
);
assert.equal(state.clears, beforePrepare);
assert.equal(state.allocations.size, 0);
assert.deepEqual(await execute("readImage"), image);
state.failAtAllocation = 0;
// A failure after the first transfer preserves that Windows-owned format and frees the rest.
state.failAtSet = state.setCalls + 2;
const beforeTransfer = state.transferred;
const beforeFree = state.frees;
await assert.rejects(
  async () =>
    execute("writeFormats", {
      items,
    }),
  hasCode("INTERNAL"),
);
assert.equal(state.transferred, beforeTransfer + 1);
assert.equal(state.frees, beforeFree + 4);
assert.equal(state.allocations.size, 0);
assert.equal(await execute("readText"), items[0]?.data);
assert.equal(await execute("readImage"), null);
state.failAtSet = 0;
// Borrowed custom-format blocks must be copied, bounded and unlocked on decode failure.
const htmlId = state.registered.get("HTML Format");
assert(htmlId !== undefined);
for (const bytes of [
  Buffer.from("malformed"),
  Buffer.alloc(MAX_NATIVE_FORMAT_BYTES + 1),
]) {
  state.formats.set(htmlId, bytes);
  await assert.rejects(
    async () =>
      execute("readFormats", {
        formats: [
          "text/html",
        ],
      }),
    hasCode("INTERNAL"),
  );
  assert.equal(state.locks, 0);
  assert.equal(state.opened, false);
}
const external = encodeHTML("<b>external</b>");
state.formats.set(htmlId, external);
assert.deepEqual(
  await execute("readFormats", {
    formats: [
      "text/html",
    ],
  }),
  [
    {
      format: "text/html",
      data: "<b>external</b>",
    },
  ],
);
external.fill(0);
await execute("writeText", {
  text: "old",
});
state.occupied = true;
await assert.rejects(async () => execute("clear"), hasCode("BUSY"));
const clears = state.clears;
const controller = new AbortController();
const cancelled = execute("clear", null, controller.signal);
setTimeout(() => controller.abort(), 15);
await assert.rejects(async () => cancelled, hasCode("CANCELLED"));
const afterRelease = execute("writeText", {
  text: "retry",
});
setTimeout(() => {
  state.occupied = false;
}, 15);
await afterRelease;
assert.equal(state.clears, clears + 1);
state.occupied = true;
const stopped = execute("clear");
await adapter.dispose();
await assert.rejects(async () => stopped, hasCode("CANCELLED"));
await adapter.dispose();
await assert.rejects(async () => execute("clear"), hasCode("CANCELLED"));
assert.equal(state.windows, 0);
assert.equal(state.libraries, 0);
assert.equal(state.allocations.size, 0);
assert.equal(state.locks, 0);
assert.equal(state.opened, false);
console.log(
  "clipboard ownership, failure, retry, cancellation and disposal passed",
);
