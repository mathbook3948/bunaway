import { dlopen, ptr } from "bun:ffi";
import assert from "node:assert/strict";
import { link, mkdir, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { BunawayError } from "../../packages/protocol/src/index.ts";
import {
  disposeStorageBindings,
  readStorageText,
  ScopedStorage,
} from "../../plugins/storage/src/windows.ts";

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
  for (const text of ["\uFEFFhello", "\uFEFF", "\uFEFF\uFEFF한글"]) {
    storage.execute("temp", "bom.txt", text);
    assert.equal(storage.execute("temp", "bom.txt"), text);
  }
  const api = dlopen("kernel32.dll", {
    CreateFileW: { args: ["ptr", "u32", "u32", "ptr", "u32", "u32", "u64"], returns: "u64" },
    CloseHandle: { args: ["u64"], returns: "i32" },
    GetShortPathNameW: { args: ["ptr", "ptr", "u32"], returns: "u32" },
  });
  const protectedPath = "notes/private-directory/secret-long-name.txt";
  storage.execute("appData", protectedPath, "protected");
  const aliases = [
    "notes/PRIVATE-DIRECTORY/secret-long-name.txt",
    "notes/private-directory/SECRET-LONG-NAME.txt",
  ];
  const shortName = Buffer.alloc(65536);
  const shortLength = api.symbols.GetShortPathNameW(
    ptr(Buffer.from(`${resolve(root, "data", protectedPath)}\0`, "utf16le")),
    ptr(shortName),
    32768,
  );
  assert(shortLength > 0 && shortLength < 32768);
  const shortParts = shortName
    .subarray(0, shortLength * 2)
    .toString("utf16le")
    .split("\\")
    .slice(-2);
  const shortPath = `notes/${shortParts.join("/")}`;
  if (shortPath !== protectedPath) aliases.push(shortPath);
  else console.log("SKIP 8.3 alias check: volume did not create short names");
  if (shortParts[1] !== "secret-long-name.txt")
    aliases.push(`notes/private-directory/${shortParts[1]}`);
  if (shortParts[0] !== "private-directory")
    aliases.push(`notes/${shortParts[0]}/secret-long-name.txt`);
  for (const path of aliases) {
    for (const text of [undefined, "overwritten"])
      assert.throws(
        () => storage.execute("appData", path, text),
        (error) => error instanceof BunawayError && error.code === "PERMISSION_DENIED",
      );
  }
  assert.throws(
    () => storage.execute("appData", "notes/PRIVATE-DIRECTORY/new/file.txt", "new"),
    (error) => error instanceof BunawayError && error.code === "PERMISSION_DENIED",
  );
  assert.equal(
    await Bun.file(resolve(root, "data/notes/private-directory/new/file.txt")).exists(),
    false,
  );
  assert.equal(storage.execute("appData", protectedPath), "protected");
  for (const path of ["notes/new/UpperCase.txt", "notes/new/한글~이름.txt"]) {
    storage.execute("appData", path, "ordinary file");
    assert.equal(storage.execute("appData", path), "ordinary file");
  }
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
