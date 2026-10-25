import { dlopen } from "bun:ffi";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { BunawayError } from "@bunaway/plugin";
import { KERNEL32, pick, withWide } from "@bunaway/plugin/win32";
import { WindowsStorage } from "#plugins/storage/src/platforms/windows";

assert.equal(process.platform, "win32");

const GENERIC_READ = 0x80000000;
const SHARE_READ_WRITE = 0x3;
const SHARE_ALL = 0x7;
const OPEN_EXISTING = 3;
const INVALID_HANDLE_VALUE = 0xffffffffffffffffn;

const root = resolve(
  import.meta.dir,
  `../../build/waw-${crypto.randomUUID().slice(0, 8)}`,
);
const storage = new WindowsStorage();
const at = (name: string) => `${root}\\${name}`;
const names = () => readdirSync(root).sort();

/** Hold `path` open for reading with the given share mode until the returned function is called. */
function hold(path: string, share: number): () => void {
  const api = dlopen(
    "kernel32.dll",
    pick(KERNEL32, "CreateFileW", "CloseHandle"),
  );
  const handle = withWide(path, (name) =>
    api.symbols.CreateFileW(
      name,
      GENERIC_READ,
      share,
      null,
      OPEN_EXISTING,
      0,
      0n,
    ),
  );
  assert.notEqual(
    handle,
    INVALID_HANDLE_VALUE,
    "The holder must open the file.",
  );
  return () => {
    api.symbols.CloseHandle(handle);
    api.close();
  };
}

function failureOf(action: () => unknown): BunawayError {
  try {
    action();
  } catch (error) {
    assert(error instanceof BunawayError, `Unexpected error: ${String(error)}`);
    return error;
  }
  throw new Error("The action must fail.");
}

try {
  await mkdir(root, {
    recursive: true,
  });

  // A new file and a replacement both end up complete, with no temporary file left.
  storage.writeText({
    path: at("note.txt"),
    text: "first",
    atomic: true,
  });
  assert.equal(readFileSync(at("note.txt"), "utf8"), "first");
  storage.writeText({
    path: at("note.txt"),
    text: "second 한글 🙂",
    atomic: true,
  });
  assert.equal(readFileSync(at("note.txt"), "utf8"), "second 한글 🙂");
  storage.writeBytes({
    path: at("note.txt"),
    bytes: Buffer.from([
      0,
      1,
      2,
      255,
    ]).toString("base64"),
    atomic: true,
  });
  assert.deepEqual(
    [
      ...readFileSync(at("note.txt")),
    ],
    [
      0,
      1,
      2,
      255,
    ],
  );
  assert.deepEqual(names(), [
    "note.txt",
  ]);

  // A file another process holds open with delete sharing is still replaced.
  const release = hold(at("note.txt"), SHARE_ALL);
  try {
    storage.writeText({
      path: at("note.txt"),
      text: "replaced while open",
      atomic: true,
    });
  } finally {
    release();
  }
  assert.equal(readFileSync(at("note.txt"), "utf8"), "replaced while open");
  assert.deepEqual(names(), [
    "note.txt",
  ]);

  // A holder that refuses delete sharing blocks the swap: the old file stays and no temporary remains.
  writeFileSync(at("held.txt"), "original");
  const releaseHeld = hold(at("held.txt"), SHARE_READ_WRITE);
  try {
    const error = failureOf(() =>
      storage.writeText({
        path: at("held.txt"),
        text: "replacement",
        atomic: true,
      }),
    );
    assert.equal(error.code, "PERMISSION_DENIED");
  } finally {
    releaseHeld();
  }
  assert.equal(readFileSync(at("held.txt"), "utf8"), "original");
  assert.deepEqual(names(), [
    "held.txt",
    "note.txt",
  ]);

  // A read-only file is refused as an in-place write is.
  writeFileSync(at("readonly.txt"), "locked");
  const attrib = Bun.spawnSync([
    "attrib",
    "+R",
    at("readonly.txt"),
  ]);
  assert.equal(attrib.exitCode, 0);
  try {
    const error = failureOf(() =>
      storage.writeText({
        path: at("readonly.txt"),
        text: "x",
        atomic: true,
      }),
    );
    assert.equal(error.code, "PERMISSION_DENIED");
    assert.equal(readFileSync(at("readonly.txt"), "utf8"), "locked");
  } finally {
    Bun.spawnSync([
      "attrib",
      "-R",
      at("readonly.txt"),
    ]);
  }

  // A directory is refused and stays.
  await mkdir(at("folder"));
  const refused = failureOf(() =>
    storage.writeText({
      path: at("folder"),
      text: "x",
      atomic: true,
    }),
  );
  assert.equal(refused.code, "INVALID_ARGUMENT");
  assert.deepEqual(names(), [
    "folder",
    "held.txt",
    "note.txt",
    "readonly.txt",
  ]);

  // Missing folders are created and a path beyond MAX_PATH works.
  const deep = [
    "a",
    "b",
    "c",
    "d",
    "e",
    "f",
  ]
    .map((letter) => letter.repeat(60))
    .join("\\");
  const long = `${at("long")}\\${deep}\\atomic.txt`;
  assert(long.length > 400, "The test path must exceed MAX_PATH.");
  storage.writeText({
    path: long,
    text: "long path",
    atomic: true,
  });
  assert.equal(
    storage.readText({
      path: long,
    }),
    "long path",
  );

  console.log("windows-storage-atomic-write ok");
} finally {
  storage.dispose();
  rmSync(`\\\\?\\${root}`, {
    recursive: true,
    force: true,
  });
}
