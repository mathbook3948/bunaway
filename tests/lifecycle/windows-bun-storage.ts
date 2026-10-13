import { dlopen, ptr } from "bun:ffi";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  link,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { BunawayError } from "@bunaway/protocol";
import { WindowsStorage } from "#plugins/storage/src/platforms/windows";

const root = resolve(
  import.meta.dir,
  `../../build/windows-bun-storage-${crypto.randomUUID()}`,
);
const dataPath = (path: string) => `${resolve(root, "data")}/${path}`;
const temporaryPath = (path: string) => `${resolve(root, "temp")}/${path}`;
const storage = new WindowsStorage();
const otherStorage = new WindowsStorage();
otherStorage.dispose();
otherStorage.dispose();
assert.throws(
  () =>
    otherStorage.execute("storage.exists", {
      path: temporaryPath("absent.txt"),
    }),
  (error) => error instanceof BunawayError && error.code === "CANCELLED",
);
assert.equal(
  storage.execute("storage.exists", {
    path: temporaryPath("absent.txt"),
  }),
  false,
);
const api = dlopen("kernel32.dll", {
  CreateFileW: {
    args: [
      "ptr",
      "u32",
      "u32",
      "ptr",
      "u32",
      "u32",
      "u64",
    ],
    returns: "u64",
  },
  CloseHandle: {
    args: [
      "u64",
    ],
    returns: "i32",
  },
  GetLastError: {
    args: [],
    returns: "u32",
  },
  GetShortPathNameW: {
    args: [
      "ptr",
      "ptr",
      "u32",
    ],
    returns: "u32",
  },
});

function wide(text: string): Buffer {
  return Buffer.from(`${text}\0`, "utf16le");
}

function call(operation: string, path: string, text?: string) {
  return storage.execute(
    operation,
    text === undefined
      ? {
          path,
        }
      : {
          path,
          text,
        },
  );
}

function expectError(action: () => unknown, code: string): void {
  assert.throws(
    action,
    (error) => error instanceof BunawayError && error.code === code,
  );
}

function expectDenied(path: string): void {
  for (const operation of [
    "storage.exists",
    "storage.stat",
  ]) {
    expectError(() => call(operation, dataPath(path)), "PERMISSION_DENIED");
  }
}

/** Checks the metadata shape and nullable Windows timestamps. */
function assertMetadata(
  value: unknown,
  kind: "file" | "directory",
  sizeBytes: number | null,
): asserts value is {
  kind: "file" | "directory";
  sizeBytes: number | null;
  createdAtMs: number | null;
  modifiedAtMs: number | null;
  accessedAtMs: number | null;
} {
  assert(value && typeof value === "object" && !Array.isArray(value));
  const metadata = value as Record<string, unknown>;
  assert.deepEqual(Object.keys(metadata).sort(), [
    "accessedAtMs",
    "createdAtMs",
    "kind",
    "modifiedAtMs",
    "sizeBytes",
  ]);
  assert.equal(metadata.kind, kind);
  assert.equal(metadata.sizeBytes, sizeBytes);
  for (const field of [
    "createdAtMs",
    "modifiedAtMs",
    "accessedAtMs",
  ]) {
    assert(
      metadata[field] === null ||
        (typeof metadata[field] === "number" &&
          Number.isFinite(metadata[field])),
    );
  }
}

let raceAccessDenials = 0;
let raceSharingViolations = 0;

/** Allows transient access or sharing errors during deletion. */
function duringDelete<T>(action: () => T): T | undefined {
  try {
    return action();
  } catch (error) {
    if (
      error instanceof BunawayError &&
      error.code === "PERMISSION_DENIED" &&
      error.message === "Storage access denied."
    ) {
      raceAccessDenials++;
    } else if (error instanceof Error && /\(32\)$/.test(error.message)) {
      raceSharingViolations++;
    } else {
      assert.fail(
        `Unexpected storage error during deletion race: ${String(error)}`,
      );
    }
  }
}

async function main(): Promise<void> {
  try {
    // Constructing the adapter does not create storage directories or restrict the app's location.
    await assert.rejects(stat(root), {
      code: "ENOENT",
    });
    const selectedPath = resolve(root, "app-selected", "memo.txt");
    assert.equal(
      call("storage.writeText", selectedPath, "chosen by app"),
      null,
    );
    assert.equal(call("storage.readText", selectedPath), "chosen by app");
    await assert.rejects(stat(resolve(root, "data")), {
      code: "ENOENT",
    });
    await assert.rejects(stat(resolve(root, "temp")), {
      code: "ENOENT",
    });
    for (const path of [
      "relative.txt",
      "C:relative.txt",
      `${root}/../escape.txt`,
    ]) {
      expectError(() => call("storage.exists", path), "INVALID_ARGUMENT");
    }
    // Seed normal paths and aliases for native handle checks.
    await mkdir(resolve(root, "data/notes/private-directory"), {
      recursive: true,
    });
    await mkdir(resolve(root, "outside"), {
      recursive: true,
    });
    await writeFile(resolve(root, "outside/secret.txt"), "secret");
    await symlink(
      resolve(root, "outside"),
      resolve(root, "data/notes/junction"),
      "junction",
    );
    await symlink(
      resolve(root, "outside"),
      resolve(root, "data/notes/final-junction"),
      "junction",
    );
    let hasFileSymlink = true;
    try {
      await symlink(
        resolve(root, "outside/secret.txt"),
        resolve(root, "data/notes/file-symlink.txt"),
        "file",
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM") {
        hasFileSymlink = false;
        console.log(
          "SKIP final file symlink check: Windows did not grant symlink creation",
        );
      } else {
        throw error;
      }
    }
    await link(
      resolve(root, "outside/secret.txt"),
      resolve(root, "data/notes/hard.txt"),
    );

    assert.equal(
      call(
        "storage.writeText",
        dataPath("notes/new/memo.txt"),
        "한글 and emoji 🙂",
      ),
      null,
    );
    assert.equal(
      call("storage.readText", dataPath("notes/new/memo.txt")),
      "한글 and emoji 🙂",
    );
    call("storage.writeText", dataPath("notes/new/memo.txt"), "x");
    assert.equal(call("storage.readText", dataPath("notes/new/memo.txt")), "x");
    call("storage.writeText", temporaryPath("empty.txt"), "");
    assert.equal(call("storage.readText", temporaryPath("empty.txt")), "");
    assert.equal(call("storage.exists", temporaryPath("empty.txt")), true);
    assertMetadata(call("storage.stat", temporaryPath("empty.txt")), "file", 0);
    for (const text of [
      "\uFEFFhello",
      "\uFEFF",
      "\uFEFF\uFEFF한글",
    ]) {
      call("storage.writeText", temporaryPath("bom.txt"), text);
      assert.equal(call("storage.readText", temporaryPath("bom.txt")), text);
    }

    // Byte access preserves invalid UTF-8 and embedded zeroes, including replacement tails.
    const binaryPath = temporaryPath("한글/binary.bin");
    const rawBytes = Buffer.from(
      Array.from(
        {
          length: 256,
        },
        (_, index) => index,
      ),
    );
    const binary = (operation: string, bytes?: Buffer) =>
      storage.execute(
        operation,
        bytes === undefined
          ? {
              path: binaryPath,
            }
          : {
              path: binaryPath,
              bytes: bytes.toString("base64"),
            },
      );
    binary("storage.writeBytes", rawBytes);
    assert.equal(binary("storage.readBytes"), rawBytes.toString("base64"));
    assert.throws(() => call("storage.readText", binaryPath));
    binary(
      "storage.writeBytes",
      Buffer.from([
        255,
      ]),
    );
    assert.equal(binary("storage.readBytes"), "/w==");
    binary(
      "storage.appendBytes",
      Buffer.from([
        0,
        128,
      ]),
    );
    assert.equal(
      binary("storage.readBytes"),
      Buffer.from([
        255,
        0,
        128,
      ]).toString("base64"),
    );
    binary("storage.appendBytes", Buffer.alloc(0));
    assert.equal(
      binary("storage.readBytes"),
      Buffer.from([
        255,
        0,
        128,
      ]).toString("base64"),
    );
    binary("storage.writeBytes", Buffer.alloc(0));
    assert.equal(binary("storage.readBytes"), "");
    await rm(binaryPath);
    binary("storage.appendBytes", rawBytes);
    assert.equal(binary("storage.readBytes"), rawBytes.toString("base64"));
    call("storage.appendText", temporaryPath("append/new.txt"), "한글");
    call("storage.appendText", temporaryPath("append/new.txt"), "\u0000🙂");
    call("storage.appendText", temporaryPath("append/new.txt"), "");
    assert.equal(
      call("storage.readText", temporaryPath("append/new.txt")),
      "한글\u0000🙂",
    );
    binary("storage.writeBytes", Buffer.alloc(256 * 1024, 255));
    assert.equal(
      binary("storage.readBytes"),
      Buffer.alloc(256 * 1024, 255).toString("base64"),
    );
    binary(
      "storage.appendBytes",
      Buffer.from([
        1,
      ]),
    );
    assert.throws(() => binary("storage.readBytes"), /too large/);
    expectError(
      () => call("storage.readBytes", temporaryPath("missing.bin")),
      "INVALID_ARGUMENT",
    );

    const transfer = (operation: string, from: string, to: string) =>
      storage.execute(operation, {
        from,
        to,
      });
    const copySource = temporaryPath("copy source.bin");
    const copied = temporaryPath("copied 한글.bin");
    const bytes = Buffer.alloc(1024 * 1024 + 257);
    for (let index = 0; index < bytes.length; index++) {
      bytes[index] = index % 256;
    }
    await writeFile(copySource, bytes);
    assert.equal(transfer("storage.copyFile", copySource, copied), null);
    assert.deepEqual(Buffer.from(await Bun.file(copied).arrayBuffer()), bytes);
    assert.deepEqual(
      Buffer.from(await Bun.file(copySource).arrayBuffer()),
      bytes,
    );
    for (const operation of [
      "storage.copyFile",
      "storage.move",
    ]) {
      expectError(
        () => transfer(operation, copySource, copied),
        "INVALID_ARGUMENT",
      );
      assert.deepEqual(
        Buffer.from(await Bun.file(copied).arrayBuffer()),
        bytes,
      );
      assert.equal(call("storage.exists", copySource), true);
      expectError(
        () =>
          transfer(
            operation,
            dataPath("notes/hard.txt"),
            temporaryPath("link transfer.bin"),
          ),
        "PERMISSION_DENIED",
      );
      expectError(
        () =>
          transfer(
            operation,
            copySource,
            dataPath("notes/junction/escaped.bin"),
          ),
        "PERMISSION_DENIED",
      );
      expectError(
        () => transfer(operation, "relative.txt", copied),
        "INVALID_ARGUMENT",
      );
      expectError(
        () => transfer(operation, copySource, temporaryPath("bad:ads")),
        "INVALID_ARGUMENT",
      );
    }
    assert.equal(
      await Bun.file(resolve(root, "outside/escaped.bin")).exists(),
      false,
    );
    const occupied = api.symbols.CreateFileW(
      ptr(wide(copySource)),
      0x40000000,
      7,
      null,
      3,
      0,
      0n,
    );
    assert(occupied && occupied !== 0xffffffffffffffffn);
    try {
      // A real competing writer is a sharing failure, not an existing-destination error.
      assert.throws(
        () =>
          transfer(
            "storage.copyFile",
            copySource,
            temporaryPath("busy-copy.bin"),
          ),
        /\(32\)$/,
      );
      assert.equal(
        call("storage.exists", temporaryPath("busy-copy.bin")),
        false,
      );
    } finally {
      assert(api.symbols.CloseHandle(occupied));
    }
    const oversized = temporaryPath("oversized.bin");
    await writeFile(oversized, Buffer.alloc(4 * 1024 * 1024 + 1));
    expectError(
      () =>
        transfer(
          "storage.copyFile",
          oversized,
          temporaryPath("oversized-copy.bin"),
        ),
      "INVALID_ARGUMENT",
    );
    assert.equal(
      call("storage.exists", temporaryPath("oversized-copy.bin")),
      false,
    );
    const secondVolumeRoot = await realpath(
      await mkdtemp(resolve(tmpdir(), "bunaway-move-volume-")),
    );
    try {
      if ((await stat(copySource)).dev !== (await stat(secondVolumeRoot)).dev) {
        expectError(
          () =>
            transfer(
              "storage.move",
              copySource,
              resolve(secondVolumeRoot, "cross-volume.bin"),
            ),
          "UNSUPPORTED",
        );
        assert.equal(call("storage.exists", copySource), true);
        assert.equal(
          await Bun.file(
            resolve(secondVolumeRoot, "cross-volume.bin"),
          ).exists(),
          false,
        );
      } else {
        console.log(
          "SKIP cross-volume move check: a second filesystem volume was not identified",
        );
      }
    } finally {
      await rm(secondVolumeRoot, {
        recursive: true,
        force: true,
      });
    }
    const anotherParent = temporaryPath("another move parent");
    await mkdir(anotherParent);
    expectError(
      () => transfer("storage.move", copied, `${anotherParent}/child.bin`),
      "UNSUPPORTED",
    );
    assert.equal(call("storage.exists", copied), true);
    assert.equal(call("storage.exists", `${anotherParent}/child.bin`), false);
    const moved = temporaryPath("moved 한글.bin");
    assert.equal(transfer("storage.move", copied, moved), null);
    assert.equal(call("storage.exists", copied), false);
    assert.deepEqual(Buffer.from(await Bun.file(moved).arrayBuffer()), bytes);
    expectError(
      () => transfer("storage.move", moved, moved),
      "INVALID_ARGUMENT",
    );
    const sourceDirectory = temporaryPath("move directory");
    await mkdir(sourceDirectory);
    await writeFile(`${sourceDirectory}/한글.txt`, "directory child");
    expectError(
      () =>
        transfer("storage.move", sourceDirectory, `${sourceDirectory}/child`),
      "INVALID_ARGUMENT",
    );
    const movedDirectory = temporaryPath("renamed directory");
    assert.equal(
      transfer("storage.move", sourceDirectory, movedDirectory),
      null,
    );
    assert.equal(call("storage.exists", sourceDirectory), false);
    assert.equal(
      await Bun.file(`${movedDirectory}/한글.txt`).text(),
      "directory child",
    );
    call("storage.writeText", temporaryPath("empty-source.txt"), "");
    assert.equal(
      transfer(
        "storage.copyFile",
        temporaryPath("empty-source.txt"),
        temporaryPath("empty-copy.txt"),
      ),
      null,
    );
    assert.equal((await stat(temporaryPath("empty-copy.txt"))).size, 0);

    const unicodeDirectory = "notes/한글 folder";
    const unicodeFile = `${unicodeDirectory}/현재 draft.txt`;
    const unicodeFilePath = resolve(root, "data", unicodeFile);
    const unicodeText = "공백과 한글 경로";
    call("storage.writeText", dataPath(unicodeFile), unicodeText);
    const fixedTime = new Date(1_700_000_000_000);
    await utimes(unicodeFilePath, fixedTime, fixedTime);
    assert.equal(call("storage.readText", dataPath(unicodeFile)), unicodeText);
    assert.equal(call("storage.exists", dataPath(unicodeDirectory)), true);
    assert.equal(call("storage.exists", dataPath(unicodeFile)), true);
    const unicodeMetadata = call("storage.stat", dataPath(unicodeFile));
    assertMetadata(unicodeMetadata, "file", Buffer.byteLength(unicodeText));
    const nativeStat = await stat(unicodeFilePath);
    assert.equal(
      unicodeMetadata.createdAtMs === null ||
        Math.floor(unicodeMetadata.createdAtMs) ===
          Math.floor(nativeStat.birthtimeMs),
      true,
    );
    assert.equal(
      unicodeMetadata.modifiedAtMs === null ||
        Math.floor(unicodeMetadata.modifiedAtMs) ===
          Math.floor(nativeStat.mtimeMs),
      true,
    );
    const directoryMetadata = call("storage.stat", dataPath(unicodeDirectory));
    assertMetadata(directoryMetadata, "directory", null);

    assert.equal(call("storage.exists", dataPath("notes/missing.txt")), false);
    assert.equal(call("storage.stat", dataPath("notes/missing.txt")), null);
    assert.equal(
      call("storage.exists", dataPath("missing-parent/file.txt")),
      false,
    );
    assert.equal(
      call("storage.stat", dataPath("missing-parent/file.txt")),
      null,
    );
    assert.equal(call("storage.exists", temporaryPath("missing.txt")), false);
    assert.equal(call("storage.stat", temporaryPath("missing.txt")), null);

    const protectedPath = "notes/private-directory/secret-long-name.txt";
    call("storage.writeText", dataPath(protectedPath), "protected");
    const aliases = [
      "notes/PRIVATE-DIRECTORY/secret-long-name.txt",
      "notes/private-directory/SECRET-LONG-NAME.txt",
    ];
    const shortName = Buffer.alloc(65536);
    const shortLength = api.symbols.GetShortPathNameW(
      ptr(wide(resolve(root, "data", protectedPath))),
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
    if (shortPath !== protectedPath) {
      aliases.push(shortPath);
    } else {
      console.log("SKIP 8.3 alias check: volume did not create short names");
    }
    if (shortParts[1] !== "secret-long-name.txt") {
      aliases.push(`notes/private-directory/${shortParts[1]}`);
    }
    if (shortParts[0] !== "private-directory") {
      aliases.push(`notes/${shortParts[0]}/secret-long-name.txt`);
    }
    // Case variants and available 8.3 names must fail the native path check.
    for (const path of aliases) {
      expectDenied(path);
      for (const text of [
        undefined,
        "overwritten",
      ]) {
        expectError(
          () =>
            call(
              text === undefined ? "storage.readText" : "storage.writeText",
              dataPath(path),
              text,
            ),
          "PERMISSION_DENIED",
        );
      }
    }
    expectDenied("notes/PRIVATE-DIRECTORY");
    expectError(
      () =>
        call(
          "storage.writeText",
          dataPath("notes/PRIVATE-DIRECTORY/new/file.txt"),
          "new",
        ),
      "PERMISSION_DENIED",
    );
    assert.equal(
      await Bun.file(
        resolve(root, "data/notes/private-directory/new/file.txt"),
      ).exists(),
      false,
    );
    assert.equal(
      call("storage.readText", dataPath(protectedPath)),
      "protected",
    );
    for (const path of [
      "notes/new/UpperCase.txt",
      "notes/new/한글~이름.txt",
    ]) {
      call("storage.writeText", dataPath(path), "ordinary file");
      assert.equal(call("storage.readText", dataPath(path)), "ordinary file");
    }

    // Native storage rejects junctions and hard links independently of the app's chosen directory.
    for (const path of [
      "notes/junction/secret.txt",
      "notes/final-junction",
      "notes/hard.txt",
      ...(hasFileSymlink
        ? [
            "notes/file-symlink.txt",
          ]
        : []),
    ]) {
      expectDenied(path);
      expectError(
        () => call("storage.readText", dataPath(path)),
        "PERMISSION_DENIED",
      );
      expectError(
        () => call("storage.writeText", dataPath(path), "overwritten"),
        "PERMISSION_DENIED",
      );
      for (const operation of [
        "storage.readBytes",
        "storage.writeBytes",
        "storage.appendBytes",
      ]) {
        expectError(
          () =>
            storage.execute(operation, {
              path: dataPath(path),
              bytes: "AA==",
            }),
          "PERMISSION_DENIED",
        );
      }
      expectError(
        () => call("storage.appendText", dataPath(path), "appended"),
        "PERMISSION_DENIED",
      );
    }

    // Reject unsafe Windows path forms before they reach filesystem operations.
    for (const path of [
      "../outside/secret.txt",
      "notes//x",
      "notes/x:ads",
      "notes/trailing.",
      "notes/\u0000bad",
    ]) {
      for (const operation of [
        "storage.readText",
        "storage.readBytes",
        "storage.exists",
        "storage.stat",
      ]) {
        expectError(() => call(operation, dataPath(path)), "INVALID_ARGUMENT");
      }
    }

    const deniedPath = resolve(root, "data/notes/os-denied.txt");
    await writeFile(deniedPath, "denied");
    const sid = execFileSync(
      "whoami.exe",
      [
        "/user",
        "/fo",
        "csv",
        "/nh",
      ],
      {
        encoding: "utf8",
        windowsHide: true,
      },
    )
      .trim()
      .split(",")
      .at(-1)
      ?.replaceAll('"', "");
    assert(
      sid?.startsWith("S-1-"),
      "Could not determine the current Windows user SID",
    );
    const icaclsSid = `*${sid}`;
    let denyApplied = false;
    try {
      // Apply a real ACL denial so the adapter's OS-error mapping is exercised.
      execFileSync(
        "icacls.exe",
        [
          deniedPath,
          "/deny",
          `${icaclsSid}:(R)`,
        ],
        {
          windowsHide: true,
        },
      );
      denyApplied = true;
      const deniedHandle = api.symbols.CreateFileW(
        ptr(wide(deniedPath)),
        0x80,
        0x3,
        null,
        3,
        0x00200000,
        0n,
      );
      if (deniedHandle !== 0n && deniedHandle !== 0xffffffffffffffffn) {
        assert(api.symbols.CloseHandle(deniedHandle));
        throw new Error("ACL fixture unexpectedly opened the denied file");
      }
      const deniedError = api.symbols.GetLastError();
      assert.equal(
        deniedError,
        5,
        "ACL fixture did not produce ERROR_ACCESS_DENIED",
      );
      expectDenied("notes/os-denied.txt");
      expectError(
        () => call("storage.readText", dataPath("notes/os-denied.txt")),
        "PERMISSION_DENIED",
      );
    } finally {
      if (denyApplied) {
        execFileSync(
          "icacls.exe",
          [
            deniedPath,
            "/remove:d",
            icaclsSid,
          ],
          {
            windowsHide: true,
          },
        );
      }
      await rm(deniedPath, {
        force: true,
      });
    }

    await writeFile(
      resolve(root, "temp/truncated.txt"),
      "long original contents",
    );
    const target = resolve(root, "temp/truncated.txt");
    const handle = api.symbols.CreateFileW(
      ptr(wide(target)),
      0x80000000,
      7,
      null,
      3,
      0,
      0n,
    );
    assert(handle && handle !== 0xffffffffffffffffn);
    try {
      // Truncate the file after opening it to verify reads recheck the handle.
      await writeFile(target, "short");
      assert.throws(() => storage.readText(handle, 22), /changed during read/);
      assert.equal(storage.readText(handle, 0), "");
    } finally {
      assert(api.symbols.CloseHandle(handle));
    }

    const racePath = resolve(root, "data/notes/race.txt");
    const raceState = new Int32Array(
      new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2),
    );
    const worker = new Worker(
      new URL("./fixtures/windows-bun-storage-racer.ts", import.meta.url),
      {
        workerData: {
          path: racePath,
          state: raceState.buffer,
        },
      },
    );
    let workerFailure: unknown;
    worker.on("error", (error) => {
      workerFailure = error;
    });
    worker.on("message", (message: unknown) => {
      if (message !== "ready") {
        workerFailure = new Error(JSON.stringify(message));
      }
    });
    const ready = new Promise<void>((resolveReady, reject) => {
      worker.once("message", (message: unknown) =>
        message === "ready"
          ? resolveReady()
          : reject(new Error("Unexpected race worker message")),
      );
      worker.once("error", reject);
    });
    try {
      // Begin snapshots only after the worker has installed its handler and announced readiness.
      await ready;
      const writesBeforeQueries = Atomics.load(raceState, 0);
      const deletionsBeforeQueries = Atomics.load(raceState, 1);
      let presentSnapshots = 0;
      let missingSnapshots = 0;
      for (let index = 0; index < 300; index++) {
        const exists = duringDelete(() =>
          call("storage.exists", dataPath("notes/race.txt")),
        );
        assert(exists === undefined || typeof exists === "boolean");
        if (exists === true) {
          presentSnapshots++;
        }
        if (exists === false) {
          missingSnapshots++;
        }
        const metadata = duringDelete(() =>
          call("storage.stat", dataPath("notes/race.txt")),
        );
        if (metadata !== null) {
          if (metadata === undefined) {
            continue;
          }
          assert.equal(
            (
              metadata as {
                kind: string;
              }
            ).kind,
            "file",
          );
          assert.equal(
            Number.isSafeInteger(
              (
                metadata as {
                  sizeBytes: number;
                }
              ).sizeBytes,
            ),
            true,
          );
          assert(
            (
              metadata as {
                sizeBytes: number;
              }
            ).sizeBytes >= 0,
          );
        }
        if (index % 10 === 9) {
          await Bun.sleep(1);
        }
      }
      assert(Atomics.load(raceState, 0) > writesBeforeQueries);
      assert(
        Atomics.load(raceState, 1) > deletionsBeforeQueries,
        "Race worker did not finish a delete while queries were running.",
      );
      console.log(
        `Race snapshots: present=${presentSnapshots}, missing=${missingSnapshots}, access-denied=${raceAccessDenials}, sharing-violation=${raceSharingViolations}`,
      );
    } finally {
      await worker.terminate();
    }
    assert.equal(workerFailure, undefined);

    console.log(
      "PASS Win32 checked-handle storage: read/write, metadata, missing paths, ACL denial, aliases, reparse points, hardlinks and deletion race",
    );
  } finally {
    // Release the FFI bindings before deleting the fixture tree.
    api.close();
    storage.dispose();
    await rm(root, {
      recursive: true,
      force: true,
    });
  }
}

await main();
