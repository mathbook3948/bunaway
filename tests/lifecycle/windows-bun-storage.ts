import { dlopen, ptr } from "bun:ffi";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  link,
  mkdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { BunawayError } from "@bunaway/protocol";
import {
  disposeStorageBindings,
  readStorageText,
  ScopedStorage,
} from "#plugins/storage/src/windows";

const root = resolve(
  import.meta.dir,
  `../../build/windows-bun-storage-${crypto.randomUUID()}`,
);
const storage = new ScopedStorage(root);
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

function call(
  operation: string,
  scope: "appData" | "temp",
  path: string,
  text?: string,
) {
  return storage.execute(
    operation,
    text === undefined
      ? {
          scope,
          path,
        }
      : {
          scope,
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
    expectError(() => call(operation, "appData", path), "PERMISSION_DENIED");
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
    // Seed valid app-data paths and aliases that point outside the storage root.
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
        "appData",
        "notes/new/memo.txt",
        "한글 and emoji 🙂",
      ),
      null,
    );
    assert.equal(
      call("storage.readText", "appData", "notes/new/memo.txt"),
      "한글 and emoji 🙂",
    );
    call("storage.writeText", "appData", "notes/new/memo.txt", "x");
    assert.equal(
      call("storage.readText", "appData", "notes/new/memo.txt"),
      "x",
    );
    call("storage.writeText", "temp", "empty.txt", "");
    assert.equal(call("storage.readText", "temp", "empty.txt"), "");
    assert.equal(call("storage.exists", "temp", "empty.txt"), true);
    assertMetadata(call("storage.stat", "temp", "empty.txt"), "file", 0);
    for (const text of [
      "\uFEFFhello",
      "\uFEFF",
      "\uFEFF\uFEFF한글",
    ]) {
      call("storage.writeText", "temp", "bom.txt", text);
      assert.equal(call("storage.readText", "temp", "bom.txt"), text);
    }

    const unicodeDirectory = "notes/한글 folder";
    const unicodeFile = `${unicodeDirectory}/현재 draft.txt`;
    const unicodeFilePath = resolve(root, "data", unicodeFile);
    const unicodeText = "공백과 한글 경로";
    call("storage.writeText", "appData", unicodeFile, unicodeText);
    const fixedTime = new Date(1_700_000_000_000);
    await utimes(unicodeFilePath, fixedTime, fixedTime);
    assert.equal(call("storage.readText", "appData", unicodeFile), unicodeText);
    assert.equal(call("storage.exists", "appData", unicodeDirectory), true);
    assert.equal(call("storage.exists", "appData", unicodeFile), true);
    const unicodeMetadata = call("storage.stat", "appData", unicodeFile);
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
    const directoryMetadata = call("storage.stat", "appData", unicodeDirectory);
    assertMetadata(directoryMetadata, "directory", null);

    assert.equal(call("storage.exists", "appData", "notes/missing.txt"), false);
    assert.equal(call("storage.stat", "appData", "notes/missing.txt"), null);
    assert.equal(
      call("storage.exists", "appData", "missing-parent/file.txt"),
      false,
    );
    assert.equal(
      call("storage.stat", "appData", "missing-parent/file.txt"),
      null,
    );
    assert.equal(call("storage.exists", "temp", "missing.txt"), false);
    assert.equal(call("storage.stat", "temp", "missing.txt"), null);

    const protectedPath = "notes/private-directory/secret-long-name.txt";
    call("storage.writeText", "appData", protectedPath, "protected");
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
    // Case variants and available 8.3 names must keep the same denied scope.
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
              "appData",
              path,
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
          "appData",
          "notes/PRIVATE-DIRECTORY/new/file.txt",
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
      call("storage.readText", "appData", protectedPath),
      "protected",
    );
    for (const path of [
      "notes/new/UpperCase.txt",
      "notes/new/한글~이름.txt",
    ]) {
      call("storage.writeText", "appData", path, "ordinary file");
      assert.equal(call("storage.readText", "appData", path), "ordinary file");
    }

    // Junctions and hard links must not expose files outside the storage root.
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
        () => call("storage.readText", "appData", path),
        "PERMISSION_DENIED",
      );
      expectError(
        () => call("storage.writeText", "appData", path, "overwritten"),
        "PERMISSION_DENIED",
      );
    }

    // Reject unsafe Windows path forms before they reach filesystem operations.
    for (const path of [
      "../outside/secret.txt",
      "notes//x",
      "notes/x:ads",
      "notes/trailing.",
      "notes/x\\x",
      "notes/\u0000bad",
    ]) {
      for (const operation of [
        "storage.readText",
        "storage.exists",
        "storage.stat",
      ]) {
        expectError(() => call(operation, "appData", path), "INVALID_ARGUMENT");
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
        () => call("storage.readText", "appData", "notes/os-denied.txt"),
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
      assert.throws(() => readStorageText(handle, 22), /changed during read/);
      assert.equal(readStorageText(handle, 0), "");
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
          call("storage.exists", "appData", "notes/race.txt"),
        );
        assert(exists === undefined || typeof exists === "boolean");
        if (exists === true) {
          presentSnapshots++;
        }
        if (exists === false) {
          missingSnapshots++;
        }
        const metadata = duringDelete(() =>
          call("storage.stat", "appData", "notes/race.txt"),
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
    disposeStorageBindings();
    await rm(root, {
      recursive: true,
      force: true,
    });
  }
}

await main();
