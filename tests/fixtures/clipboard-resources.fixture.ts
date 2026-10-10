import assert from "node:assert/strict";
import { createOperations } from "#plugins/clipboard/src/windows";
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
      "clipboard:read-text",
      "clipboard:write-text",
      "clipboard:clear",
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
const execute = (
  name: string,
  input: null | {
    text: string;
  } = null,
  signal?: AbortSignal,
) =>
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
          "clipboard:write-text",
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
