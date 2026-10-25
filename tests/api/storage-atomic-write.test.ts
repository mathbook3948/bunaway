import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { BunawayError } from "@bunaway/protocol";
import { storageOperations } from "../../plugins/storage/src/operations.ts";
import { retrySwap } from "../../plugins/storage/src/platforms/node-atomic-write.ts";
import { NodeStorage } from "../../plugins/storage/src/platforms/node-storage.ts";
import { pluginParsers } from "../fixtures/plugin-parsers.ts";

const parsers = pluginParsers("storage", storageOperations);
const windows = process.platform === "win32";

/** The shared operations with a swap that a test can make fail. */
class TestStorage extends NodeStorage {
  swapError: Error | undefined;
  swaps = 0;

  constructor() {
    super({
      normalize: (path) => path,
      isBelow: (parent, child) => child.startsWith(`${parent}${sep}`),
    });
  }

  protected moveWithoutReplace(from: string, to: string): void {
    renameSync(from, to);
  }

  protected override swapIn(temporary: string, target: string): void {
    this.swaps += 1;
    if (this.swapError) {
      throw this.swapError;
    }
    super.swapIn(temporary, target);
  }

  protected release(): void {}
}

let root = "";
let files = new TestStorage();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bunaway-atomic-"));
  files = new TestStorage();
});

afterEach(() => {
  files.dispose();
  rmSync(root, {
    recursive: true,
    force: true,
  });
});

const at = (...parts: string[]) => join(root, ...parts);

function codeOf(action: () => unknown): string | undefined {
  try {
    action();
  } catch (error) {
    return error instanceof BunawayError ? error.code : undefined;
  }
  return undefined;
}

test("an atomic text write replaces the contents and leaves no temporary file", () => {
  const path = at("note.txt");
  writeFileSync(path, "old contents that are longer");
  files.writeText({
    path,
    text: "new",
    atomic: true,
  });
  expect(readFileSync(path, "utf8")).toBe("new");
  expect(files.swaps).toBe(1);
  expect(readdirSync(root)).toEqual([
    "note.txt",
  ]);
});

test("an atomic byte write creates a missing file and its folders", () => {
  const path = at("a", "b", "data.bin");
  files.writeBytes({
    path,
    bytes: Buffer.from([
      0,
      255,
      7,
    ]).toString("base64"),
    atomic: true,
  });
  expect([
    ...readFileSync(path),
  ]).toEqual([
    0,
    255,
    7,
  ]);
  expect(readdirSync(at("a", "b"))).toEqual([
    "data.bin",
  ]);
});

test("a write without atomic still goes through the same file", () => {
  const path = at("same.txt");
  writeFileSync(path, "before");
  const before = statSync(path).ino;
  files.writeText({
    path,
    text: "after",
  });
  files.writeText({
    path,
    text: "again",
    atomic: false,
  });
  expect(files.swaps).toBe(0);
  expect(readFileSync(path, "utf8")).toBe("again");
  if (!windows) {
    expect(statSync(path).ino).toBe(before);
  }
});

test("a failed swap keeps the old file and removes the temporary file", () => {
  const path = at("keep.txt");
  writeFileSync(path, "original");
  files.swapError = Object.assign(new Error("swap failed"), {
    code: "ENOSPC",
  });
  expect(() =>
    files.writeText({
      path,
      text: "replacement",
      atomic: true,
    }),
  ).toThrow("swap failed");
  expect(readFileSync(path, "utf8")).toBe("original");
  expect(readdirSync(root)).toEqual([
    "keep.txt",
  ]);
});

test("a failed swap of a new file leaves nothing behind", () => {
  files.swapError = new Error("swap failed");
  expect(() =>
    files.writeText({
      path: at("fresh", "new.txt"),
      text: "x",
      atomic: true,
    }),
  ).toThrow("swap failed");
  expect(readdirSync(at("fresh"))).toEqual([]);
});

test("an atomic write to a directory is refused like an in-place write", () => {
  const path = at("folder");
  mkdirSync(path);
  expect(
    codeOf(() =>
      files.writeText({
        path,
        text: "x",
        atomic: true,
      }),
    ),
  ).toBe("INVALID_ARGUMENT");
  expect(readdirSync(root)).toEqual([
    "folder",
  ]);
});

test("an atomic write to a read-only file is refused and changes nothing", () => {
  const path = at("locked.txt");
  writeFileSync(path, "locked");
  chmodSync(path, 0o444);
  // A superuser may write read-only files, so only the unprivileged case proves the refusal.
  if (process.getuid?.() === 0) {
    return;
  }
  expect(
    codeOf(() =>
      files.writeText({
        path,
        text: "x",
        atomic: true,
      }),
    ),
  ).toBe("PERMISSION_DENIED");
  expect(readFileSync(path, "utf8")).toBe("locked");
  expect(readdirSync(root)).toEqual([
    "locked.txt",
  ]);
});

test("an atomic write through a link replaces the target and keeps the link", () => {
  const target = at("target.txt");
  const link = at("link.txt");
  writeFileSync(target, "target");
  try {
    symlinkSync(target, link);
  } catch {
    // Creating links can need a privilege this runner lacks, which is not a storage failure.
    return;
  }
  files.writeText({
    path: link,
    text: "through the link",
    atomic: true,
  });
  expect(readFileSync(target, "utf8")).toBe("through the link");
  expect(readFileSync(link, "utf8")).toBe("through the link");
  expect(readdirSync(root).sort()).toEqual([
    "link.txt",
    "target.txt",
  ]);
});

test("an atomic write through a link without a target is refused", () => {
  const link = at("dangling.txt");
  try {
    symlinkSync(at("missing.txt"), link);
  } catch {
    // Creating links can need a privilege this runner lacks, which is not a storage failure.
    return;
  }
  expect(
    codeOf(() =>
      files.writeText({
        path: link,
        text: "x",
        atomic: true,
      }),
    ),
  ).toBe("INVALID_ARGUMENT");
  expect(readdirSync(root)).toEqual([
    "dangling.txt",
  ]);
});

test("an atomic write keeps the permission bits of the replaced file", () => {
  if (windows) {
    return;
  }
  const path = at("mode.txt");
  writeFileSync(path, "x");
  chmodSync(path, 0o640);
  files.writeText({
    path,
    text: "y",
    atomic: true,
  });
  expect(statSync(path).mode & 0o777).toBe(0o640);
});

test("the swap is retried while a sharing conflict lasts and then reported", () => {
  const waits: number[] = [];
  let calls = 0;
  retrySwap(
    () => {
      calls += 1;
      if (calls < 3) {
        throw new Error("busy");
      }
    },
    () => true,
    (milliseconds) => waits.push(milliseconds),
  );
  expect(calls).toBe(3);
  expect(waits).toEqual([
    10,
    20,
  ]);

  calls = 0;
  expect(() =>
    retrySwap(
      () => {
        calls += 1;
        throw new Error("still busy");
      },
      () => true,
      () => {},
    ),
  ).toThrow("still busy");
  expect(calls).toBe(6);

  calls = 0;
  expect(() =>
    retrySwap(
      () => {
        calls += 1;
        throw new Error("permanent");
      },
      () => false,
      () => {},
    ),
  ).toThrow("permanent");
  expect(calls).toBe(1);
});

test("atomic is accepted only by the replacing writes", async () => {
  for (const [operation, payload] of [
    [
      "storage.writeText",
      {
        path: "C:/notes/a.txt",
        text: "x",
      },
    ],
    [
      "storage.writeBytes",
      {
        path: "C:/notes/a.bin",
        bytes: "AA==",
      },
    ],
  ] as const) {
    for (const atomic of [
      true,
      false,
    ]) {
      expect(
        (
          await parsers.validateCall({
            operation,
            payload: {
              ...payload,
              atomic,
            },
          })
        ).payload,
      ).toEqual({
        ...payload,
        atomic,
      });
    }
    await expect(
      parsers.validateCall({
        operation,
        payload: {
          ...payload,
          atomic: "yes",
        },
      }),
    ).rejects.toThrow();
  }
  for (const [operation, payload] of [
    [
      "storage.appendText",
      {
        path: "C:/notes/a.txt",
        text: "x",
        atomic: true,
      },
    ],
    [
      "storage.appendBytes",
      {
        path: "C:/notes/a.bin",
        bytes: "AA==",
        atomic: true,
      },
    ],
  ] as const) {
    await expect(
      parsers.validateCall({
        operation,
        payload,
      }),
    ).rejects.toThrow();
  }
});
