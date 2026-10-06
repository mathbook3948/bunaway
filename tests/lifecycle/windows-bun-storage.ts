import assert from "node:assert/strict";
import { dlopen, ptr } from "bun:ffi";
import { link, mkdir, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  disposeStorageBindings,
  readStorageText,
  ScopedStorage,
} from "../../native/windows/bun/storage.ts";
import { BunawayError } from "../../packages/protocol/src/index.ts";

const root = resolve(import.meta.dir, `../../build/windows-bun-storage-${process.pid}`);
await mkdir(resolve(root, "data/notes"), { recursive: true });
await mkdir(resolve(root, "outside"), { recursive: true });
await writeFile(resolve(root, "outside/secret.txt"), "secret");
await symlink(resolve(root, "outside"), resolve(root, "data/notes/junction"), "junction");
await link(resolve(root, "outside/secret.txt"), resolve(root, "data/notes/hard.txt"));
const storage = new ScopedStorage(root);
try {
  assert.equal(storage.execute("appData", "notes/new/memo.txt", "한글 and emoji 🙂"), null);
  assert.equal(storage.execute("appData", "notes/new/memo.txt"), "한글 and emoji 🙂");
  storage.execute("appData", "notes/new/memo.txt", "x");
  assert.equal(storage.execute("appData", "notes/new/memo.txt"), "x");
  storage.execute("temp", "empty.txt", "");
  assert.equal(storage.execute("temp", "empty.txt"), "");
  const api = dlopen("kernel32.dll", {
    CreateFileW: { args: ["ptr", "u32", "u32", "ptr", "u32", "u32", "u64"], returns: "u64" },
    CloseHandle: { args: ["u64"], returns: "i32" },
  });
  const target = resolve(root, "temp/truncated.txt");
  await writeFile(target, "long original contents");
  const handle = api.symbols.CreateFileW(
    ptr(Buffer.from(`${target}\0`, "utf16le")),
    0x80000000,
    7,
    null,
    3,
    0,
    0n,
  );
  assert(handle && handle !== 0xffffffffffffffffn);
  try {
    await writeFile(target, "short");
    assert.throws(() => readStorageText(handle, 22), /changed during read/);
    assert.equal(readStorageText(handle, 0), "");
  } finally {
    assert(api.symbols.CloseHandle(handle));
    api.close();
  }
  for (const path of ["notes/junction/secret.txt", "notes/hard.txt"]) {
    for (const text of [undefined, "overwritten"])
      assert.throws(
        () => storage.execute("appData", path, text),
        (error) => error instanceof BunawayError && error.code === "PERMISSION_DENIED",
      );
  }
  for (const path of [
    "../outside/secret.txt",
    "notes//x",
    "notes/x:ads",
    "notes/trailing.",
    "notes/x\\x",
    "notes/\u0000bad",
  ])
    assert.throws(
      () => storage.execute("appData", path),
      (error) => error instanceof BunawayError && error.code === "INVALID_ARGUMENT",
    );
  console.log(
    "PASS Win32 checked-handle storage: read/write/truncate/UTF-8, junction/hardlink/path denial",
  );
} finally {
  disposeStorageBindings();
}
