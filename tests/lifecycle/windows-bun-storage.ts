import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import builtStorage from "@bunaway/plugin-storage/native/windows";
import { BunawayError, type JsonValue } from "@bunaway/protocol";
import { WindowsStorage } from "#plugins/storage/src/platforms/windows";
import { storageOperations } from "../../plugins/storage/src/operations.ts";

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
    execute(otherStorage, "storage.exists", {
      path: temporaryPath("absent.txt"),
    }),
  (error) => error instanceof BunawayError && error.code === "CANCELLED",
);
assert.equal(
  execute(storage, "storage.exists", {
    path: temporaryPath("absent.txt"),
  }),
  false,
);

/** Run a declared storage operation on the source adapter; SDK parsing is tested separately. */
function execute(
  instance: WindowsStorage,
  operation: string,
  input: JsonValue,
): JsonValue {
  const name = operation.slice("storage.".length);
  const method: unknown = Reflect.get(instance, name);
  if (
    !operation.startsWith("storage.") ||
    !Object.hasOwn(storageOperations, name) ||
    typeof method !== "function"
  ) {
    throw new BunawayError({
      code: "UNSUPPORTED",
      message: "Unknown storage operation.",
    });
  }
  // Only declared storage methods are selected; each returns its JSON-compatible native result.
  return method.call(instance, input) as JsonValue;
}

function call(operation: string, path: string, text?: string) {
  return execute(
    storage,
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

/** Move or copy between two paths. */
const transfer = (operation: string, from: string, to: string) =>
  execute(storage, operation, {
    from,
    to,
  });

function expectError(action: () => unknown, code: string): void {
  assert.throws(
    action,
    (error) => error instanceof BunawayError && error.code === code,
  );
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

/**
 * Repeat write, copy, append and move sequences with missing targets and collisions. Each
 * operation must report its own result, which a stale last-error value would corrupt.
 */
async function checkOpenErrorCapture(
  label: string,
  executeOperation: (
    operation: string,
    input: JsonValue,
  ) => JsonValue | Promise<JsonValue>,
): Promise<void> {
  const directory = temporaryPath(`open-error-${label}`);
  await executeOperation("storage.createDirectory", {
    path: directory,
    recursive: false,
  });
  for (let iteration = 0; iteration < 32; iteration++) {
    const source = `${directory}/source-${iteration}.bin`;
    const copied = `${directory}/copy-${iteration}.bin`;
    const moved = `${directory}/moved-${iteration}.bin`;
    let phase = "missing target";
    try {
      assert.equal(
        await executeOperation("storage.exists", {
          path: moved,
        }),
        false,
      );
      assert.equal(
        await executeOperation("storage.stat", {
          path: moved,
        }),
        null,
      );
      await assert.rejects(
        async () =>
          executeOperation("storage.readBytes", {
            path: moved,
          }),
        (error) =>
          error instanceof BunawayError && error.code === "INVALID_ARGUMENT",
      );
      phase = "write/copy/append";
      assert.equal(
        await executeOperation("storage.writeBytes", {
          path: source,
          bytes: "AP+A",
        }),
        null,
      );
      assert.equal(
        await executeOperation("storage.copyFile", {
          from: source,
          to: copied,
        }),
        null,
      );
      assert.equal(
        await executeOperation("storage.appendBytes", {
          path: copied,
          bytes: "AA==",
        }),
        null,
      );
      // Reclaim cells before the move to exercise FFI result boxing.
      Bun.gc(true);
      phase = "move into missing destination";
      assert.equal(
        await executeOperation("storage.move", {
          from: copied,
          to: moved,
        }),
        null,
      );
      assert.equal(
        await executeOperation("storage.exists", {
          path: copied,
        }),
        false,
      );
      assert.equal(
        await executeOperation("storage.readBytes", {
          path: moved,
        }),
        "AP+AAA==",
      );
      phase = "existing destination";
      for (const operation of [
        "storage.copyFile",
        "storage.move",
      ]) {
        await assert.rejects(
          async () =>
            executeOperation(operation, {
              from: source,
              to: moved,
            }),
          (error) =>
            error instanceof BunawayError && error.code === "INVALID_ARGUMENT",
        );
      }
      assert.equal(
        await executeOperation("storage.readBytes", {
          path: source,
        }),
        "AP+A",
      );
      assert.equal(
        await executeOperation("storage.readBytes", {
          path: moved,
        }),
        "AP+AAA==",
      );
      phase = "cleanup";
      for (const path of [
        source,
        moved,
      ]) {
        assert.equal(
          await executeOperation("storage.remove", {
            path,
          }),
          null,
        );
      }
    } catch (error) {
      console.error(
        `Storage open capture regression: export=${label}, iteration=${iteration}, phase=${phase}, Bun=${Bun.version}, revision=${Bun.revision}`,
      );
      throw error;
    }
  }
  assert.equal(
    await executeOperation("storage.remove", {
      path: directory,
    }),
    null,
  );
  console.log(
    `PASS storage open error capture: ${label}, 32 write/copy/append/move sequences, missing targets and collision preservation`,
  );
}

/** Seed a tree with a junction, a hard link and, when permitted, a file symlink. */
async function seedFixtureTree(): Promise<boolean> {
  // Constructing the adapter does not create storage directories or restrict the app's location.
  await assert.rejects(stat(root), {
    code: "ENOENT",
  });
  await mkdir(resolve(root, "data/notes"), {
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
  let hasFileSymlink = true;
  try {
    await symlink(
      resolve(root, "outside/secret.txt"),
      resolve(root, "data/notes/file-symlink.txt"),
      "file",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") {
      throw error;
    }
    hasFileSymlink = false;
    console.log(
      "SKIP file symlink checks: Windows did not grant symlink creation",
    );
  }
  await link(
    resolve(root, "outside/secret.txt"),
    resolve(root, "data/notes/hard.txt"),
  );
  return hasFileSymlink;
}

/** Text, BOM, bytes and appends round trip through app-selected paths. */
async function checkRoundTrips(): Promise<void> {
  const selectedPath = resolve(root, "app-selected", "memo.txt");
  assert.equal(call("storage.writeText", selectedPath, "chosen by app"), null);
  assert.equal(call("storage.readText", selectedPath), "chosen by app");
  for (const path of [
    "relative.txt",
    "C:relative.txt",
    `${root}/../escape.txt`,
  ]) {
    expectError(() => call("storage.exists", path), "INVALID_ARGUMENT");
  }
  const memo = dataPath("notes/new/memo.txt");
  call("storage.writeText", memo, "한글 and emoji 🙂");
  assert.equal(call("storage.readText", memo), "한글 and emoji 🙂");
  call("storage.writeText", memo, "x");
  assert.equal(call("storage.readText", memo), "x");
  call("storage.writeText", temporaryPath("empty.txt"), "");
  assert.equal(call("storage.readText", temporaryPath("empty.txt")), "");
  assertMetadata(call("storage.stat", temporaryPath("empty.txt")), "file", 0);
  for (const text of [
    "\uFEFFhello",
    "\uFEFF",
    "\uFEFF\uFEFF한글",
  ]) {
    call("storage.writeText", temporaryPath("bom.txt"), text);
    assert.equal(call("storage.readText", temporaryPath("bom.txt")), text);
  }
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
    execute(
      storage,
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
  binary("storage.writeBytes", Buffer.alloc(0));
  assert.equal(binary("storage.readBytes"), "");
  call("storage.appendText", temporaryPath("append/new.txt"), "한글");
  call("storage.appendText", temporaryPath("append/new.txt"), "\u0000🙂");
  assert.equal(
    call("storage.readText", temporaryPath("append/new.txt")),
    "한글\u0000🙂",
  );
  binary("storage.writeBytes", Buffer.alloc(256 * 1024, 255));
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
}

/** Junctions, hard links and file symlinks are followed like ordinary paths. */
async function checkLinksAreFollowed(hasFileSymlink: boolean): Promise<void> {
  assert.equal(
    call("storage.readText", dataPath("notes/junction/secret.txt")),
    "secret",
  );
  call("storage.writeText", dataPath("notes/junction/secret.txt"), "changed");
  assert.equal(
    await readFile(resolve(root, "outside/secret.txt"), "utf8"),
    "changed",
  );
  assertMetadata(
    call("storage.stat", dataPath("notes/junction")),
    "directory",
    null,
  );
  assert.equal(call("storage.readText", dataPath("notes/hard.txt")), "changed");
  call("storage.appendText", dataPath("notes/hard.txt"), "!");
  assert.equal(
    await readFile(resolve(root, "outside/secret.txt"), "utf8"),
    "changed!",
  );
  if (hasFileSymlink) {
    assert.equal(
      call("storage.readText", dataPath("notes/file-symlink.txt")),
      "changed!",
    );
  }
  // A junction whose target is gone has nothing to open, so it reads as absent.
  await mkdir(resolve(root, "gone"));
  await symlink(
    resolve(root, "gone"),
    resolve(root, "data/notes/dangling"),
    "junction",
  );
  await rm(resolve(root, "gone"), {
    recursive: true,
  });
  assert.equal(call("storage.exists", dataPath("notes/dangling")), false);
  await rm(resolve(root, "data/notes/dangling"), {
    recursive: true,
  });
  call("storage.writeText", dataPath("notes/junction/secret.txt"), "secret");
}

/** Copies and moves, including a move to another folder and the destination collision cases. */
async function checkTransfers(): Promise<void> {
  const copySource = temporaryPath("copy source.bin");
  const copied = temporaryPath("copied 한글.bin");
  const bytes = Buffer.alloc(1024 * 1024 + 257);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = index % 256;
  }
  await writeFile(copySource, bytes);
  assert.equal(transfer("storage.copyFile", copySource, copied), null);
  assert.deepEqual(Buffer.from(await Bun.file(copied).arrayBuffer()), bytes);
  for (const operation of [
    "storage.copyFile",
    "storage.move",
  ]) {
    expectError(
      () => transfer(operation, copySource, copied),
      "INVALID_ARGUMENT",
    );
    assert.deepEqual(Buffer.from(await Bun.file(copied).arrayBuffer()), bytes);
    assert.equal(call("storage.exists", copySource), true);
    expectError(
      () => transfer(operation, "relative.txt", copied),
      "INVALID_ARGUMENT",
    );
    expectError(
      () => transfer(operation, copySource, temporaryPath("bad:ads")),
      "INVALID_ARGUMENT",
    );
    expectError(
      () =>
        transfer(
          operation,
          temporaryPath("absent.bin"),
          temporaryPath("x.bin"),
        ),
      "INVALID_ARGUMENT",
    );
  }
  // An existing destination reached through a link is still an existing name.
  expectError(
    () => transfer("storage.copyFile", copySource, dataPath("notes/hard.txt")),
    "INVALID_ARGUMENT",
  );
  expectError(
    () => transfer("storage.copyFile", copySource, dataPath("notes/junction")),
    "INVALID_ARGUMENT",
  );
  assert.equal(
    await readFile(resolve(root, "outside/secret.txt"), "utf8"),
    "secret",
  );
  // The destination follows a junction in its folder, like any other path.
  assert.equal(
    transfer(
      "storage.copyFile",
      copySource,
      dataPath("notes/junction/copied.bin"),
    ),
    null,
  );
  assert.equal(
    (await stat(resolve(root, "outside/copied.bin"))).size,
    bytes.length,
  );
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
  assert.equal(
    transfer("storage.move", copied, `${anotherParent}/child.bin`),
    null,
  );
  assert.equal(call("storage.exists", copied), false);
  assert.deepEqual(
    Buffer.from(await Bun.file(`${anotherParent}/child.bin`).arrayBuffer()),
    bytes,
  );
  expectError(
    () =>
      transfer("storage.move", copied, temporaryPath("no folder/child.bin")),
    "INVALID_ARGUMENT",
  );
  const sourceDirectory = temporaryPath("move directory");
  await mkdir(sourceDirectory);
  await writeFile(`${sourceDirectory}/한글.txt`, "directory child");
  expectError(
    () => transfer("storage.move", sourceDirectory, `${sourceDirectory}/child`),
    "INVALID_ARGUMENT",
  );
  expectError(
    () =>
      transfer(
        "storage.move",
        sourceDirectory,
        `${sourceDirectory.toUpperCase()}/CHILD`,
      ),
    "INVALID_ARGUMENT",
  );
  const movedDirectory = `${anotherParent}/renamed directory`;
  assert.equal(transfer("storage.move", sourceDirectory, movedDirectory), null);
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
  await checkOpenErrorCapture("source", (operation, input) =>
    execute(storage, operation, input),
  );
}

/** The generated native export runs the same operations with Zod defaults. */
async function checkBuiltAdapter(): Promise<void> {
  const create = builtStorage._definition.nativePlatforms.windows?.create;
  assert(create, "Built Windows storage adapter is missing.");
  const built = create({
    dataRoot: root,
    capabilities: [],
  });
  const builtDirectory = temporaryPath("built adapter/한글");
  const run = (operation: string, input: JsonValue) =>
    built.execute(operation, input, "backend");
  try {
    await checkOpenErrorCapture("built", run);
    await run("storage.createDirectory", {
      path: builtDirectory,
      recursive: true,
    });
    await run("storage.createDirectory", {
      path: builtDirectory,
    });
    assert.deepEqual(
      await run("storage.readDirectory", {
        path: builtDirectory,
      }),
      [],
    );
    const source = `${builtDirectory}/source.bin`;
    const moved = `${builtDirectory}/moved.bin`;
    await run("storage.writeBytes", {
      path: source,
      bytes: "AP+A",
    });
    await run("storage.copyFile", {
      from: source,
      to: `${builtDirectory}/copy.bin`,
    });
    await run("storage.move", {
      from: `${builtDirectory}/copy.bin`,
      to: moved,
    });
    assert.deepEqual(
      // The SDK returns JSON objects with null prototypes; compare their complete wire values.
      JSON.parse(
        JSON.stringify(
          await run("storage.readDirectory", {
            path: builtDirectory,
          }),
        ),
      ),
      [
        {
          name: "moved.bin",
          kind: "file",
        },
        {
          name: "source.bin",
          kind: "file",
        },
      ],
    );
    assert.deepEqual(
      JSON.parse(
        JSON.stringify(
          await run("storage.directorySize", {
            path: builtDirectory,
          }),
        ),
      ),
      {
        bytes: 6,
        files: 2,
        directories: 0,
      },
    );
    await run("storage.removeRecursive", {
      path: builtDirectory,
    });
    assert.equal(
      await run("storage.exists", {
        path: builtDirectory,
      }),
      false,
    );
  } finally {
    await built.dispose();
  }
}

/** Directory creation, listing and removal, with links listed as links and followed as paths. */
async function checkDirectoryOperations(): Promise<void> {
  const directoryPath = temporaryPath("directory API/한글");
  const createDirectory = (path: string, recursive = false) =>
    execute(storage, "storage.createDirectory", {
      path,
      recursive,
    });
  expectError(() => createDirectory(directoryPath), "INVALID_ARGUMENT");
  assert.equal(await Bun.file(directoryPath).exists(), false);
  assert.equal(createDirectory(directoryPath, true), null);
  assert.equal(createDirectory(directoryPath), null);
  assert.deepEqual(call("storage.readDirectory", directoryPath), []);
  const nestedDirectory = `${directoryPath}/nested`;
  createDirectory(nestedDirectory);
  call("storage.writeText", `${directoryPath}/한글🙂.txt`, "child");
  await symlink(
    resolve(root, "outside"),
    `${directoryPath}/junction`,
    "junction",
  );
  await link(resolve(root, "outside/secret.txt"), `${directoryPath}/hard.txt`);
  assert.deepEqual(call("storage.readDirectory", directoryPath), [
    {
      name: "hard.txt",
      kind: "file",
    },
    {
      name: "junction",
      kind: "link",
    },
    {
      name: "nested",
      kind: "directory",
    },
    {
      name: "한글🙂.txt",
      kind: "file",
    },
  ]);
  // A junction used as a directory path is followed.
  assert.deepEqual(
    (
      call("storage.readDirectory", `${directoryPath}/junction`) as {
        name: string;
      }[]
    ).map((entry) => entry.name),
    [
      "copied.bin",
      "secret.txt",
    ],
  );
  expectError(() => call("storage.remove", directoryPath), "INVALID_ARGUMENT");
  expectError(
    () => call("storage.readDirectory", `${directoryPath}/한글🙂.txt`),
    "INVALID_ARGUMENT",
  );
  expectError(
    () => createDirectory(`${directoryPath}/한글🙂.txt`),
    "INVALID_ARGUMENT",
  );
  // Removing a junction removes the link and keeps what it pointed to.
  assert.equal(call("storage.remove", `${directoryPath}/junction`), null);
  assert.equal(call("storage.exists", `${directoryPath}/junction`), false);
  assert.equal(
    await Bun.file(resolve(root, "outside/secret.txt")).exists(),
    true,
  );
  assert.equal(call("storage.remove", `${directoryPath}/hard.txt`), null);
  assert.equal(
    await Bun.file(resolve(root, "outside/secret.txt")).exists(),
    true,
  );
  assert.equal(call("storage.remove", `${directoryPath}/한글🙂.txt`), null);
  assert.equal(call("storage.remove", nestedDirectory), null);
  const batched = temporaryPath("batched");
  createDirectory(batched);
  const expectedNames: string[] = [];
  for (let index = 0; index < 180; index++) {
    const name = `${String(index).padStart(3, "0")}-${"x".repeat(200)}.txt`;
    expectedNames.push(name);
    await writeFile(`${batched}/${name}`, "");
  }
  assert.deepEqual(
    call("storage.readDirectory", batched),
    expectedNames.map((name) => ({
      name,
      kind: "file",
    })),
  );
  const crowded = temporaryPath("crowded");
  createDirectory(crowded);
  for (let index = 0; index < 257; index++) {
    await writeFile(`${crowded}/${index}.txt`, "");
  }
  expectError(() => call("storage.readDirectory", crowded), "INVALID_ARGUMENT");
  // A failed listing keeps nothing open: the directory can be renamed.
  await rename(crowded, `${crowded}-renamed`);
}

/** Unicode paths report native timestamps and sizes, and missing paths report absence. */
async function checkUnicodeMetadata(): Promise<void> {
  const unicodeDirectory = "notes/한글 folder";
  const unicodeFile = `${unicodeDirectory}/현재 draft.txt`;
  const unicodeFilePath = resolve(root, "data", unicodeFile);
  const unicodeText = "공백과 한글 경로";
  call("storage.writeText", dataPath(unicodeFile), unicodeText);
  const fixedTime = new Date(1_700_000_000_000);
  await utimes(unicodeFilePath, fixedTime, fixedTime);
  assert.equal(call("storage.readText", dataPath(unicodeFile)), unicodeText);
  assert.equal(call("storage.exists", dataPath(unicodeDirectory)), true);
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
  assertMetadata(
    call("storage.stat", dataPath(unicodeDirectory)),
    "directory",
    null,
  );
  for (const path of [
    dataPath("notes/missing.txt"),
    dataPath("missing-parent/file.txt"),
    temporaryPath("missing.txt"),
  ]) {
    assert.equal(call("storage.exists", path), false);
    assert.equal(call("storage.stat", path), null);
  }
}

/** Unsafe Windows path forms are rejected before they reach filesystem operations. */
async function checkUnsafePathForms(): Promise<void> {
  for (const path of [
    "../outside/secret.txt",
    "notes//x",
    "notes/x:ads",
    "notes/trailing.",
    "notes/CON",
    "notes/\u0000bad",
  ]) {
    for (const operation of [
      "storage.readText",
      "storage.readBytes",
      "storage.readDirectory",
      "storage.createDirectory",
      "storage.remove",
      "storage.exists",
      "storage.stat",
    ]) {
      expectError(() => call(operation, dataPath(path)), "INVALID_ARGUMENT");
    }
  }
  for (const path of [
    "\\\\?\\C:\\Windows\\win.ini",
    "\\\\.\\PhysicalDrive0",
    "\\??\\C:\\Windows\\win.ini",
  ]) {
    expectError(() => call("storage.readText", path), "INVALID_ARGUMENT");
  }
}

/** A file the OS denies to the current user reports PERMISSION_DENIED and recovers after the ACL is restored. */
async function checkOsDeniedAccess(): Promise<void> {
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
    // A real ACL denial exercises the adapter's mapping of the OS error.
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
    for (const operation of [
      "storage.readText",
      "storage.readBytes",
    ]) {
      expectError(
        () => call(operation, dataPath("notes/os-denied.txt")),
        "PERMISSION_DENIED",
      );
    }
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
}

async function main(): Promise<void> {
  try {
    const hasFileSymlink = await seedFixtureTree();
    await checkRoundTrips();
    await checkLinksAreFollowed(hasFileSymlink);
    await checkTransfers();
    await checkBuiltAdapter();
    await checkDirectoryOperations();
    await checkUnicodeMetadata();
    await checkUnsafePathForms();
    await checkOsDeniedAccess();
    console.log(
      "PASS Windows storage: read/write, metadata, missing paths, ACL denial, followed links, transfers and directory operations",
    );
  } finally {
    storage.dispose();
    await rm(root, {
      recursive: true,
      force: true,
    });
  }
}

await main();
