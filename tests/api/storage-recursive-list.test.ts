import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import storage from "@bunaway/plugin-storage";
import { BunawayError, NativeRegistry } from "@bunaway/protocol";
import {
  MAX_DIRECTORY_ENTRIES,
  MAX_RECURSIVE_PAGE_PATH_CHARACTERS,
  MAX_RECURSIVE_PATH_COMPONENTS,
  type StorageRecursiveEntry,
  type StorageRecursivePage,
} from "../../plugins/storage/src/contract.ts";
import { storageOperations } from "../../plugins/storage/src/operations.ts";
import { NodeStorage } from "../../plugins/storage/src/platforms/node-storage.ts";
import { pluginParsers } from "../fixtures/plugin-parsers.ts";

/** The shared operations with the simplest path rules; the move rules are not under test. */
class TestStorage extends NodeStorage {
  constructor() {
    super({
      normalize: (path) => path,
      isBelow: (parent, child) => child.startsWith(`${parent}${sep}`),
    });
  }

  protected moveWithoutReplace(): void {
    throw new Error("not used");
  }

  protected release(): void {}
}

const parsers = pluginParsers("storage", storageOperations);
// Mode 0 only denies listing to a non-root user on a POSIX file system.
const cannotDeny = process.platform === "win32" || process.getuid?.() === 0;
const LIMITS = {
  entries: 1000,
  depth: 8,
};
let root = "";
let adapter = new TestStorage();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bunaway-storage-recursive-"));
  adapter = new TestStorage();
});

afterEach(() => {
  rmSync(root, {
    recursive: true,
    force: true,
  });
});

const at = (...parts: string[]) => join(root, ...parts);

function createTree(paths: string[]): void {
  for (const path of paths) {
    if (path.endsWith("/")) {
      mkdirSync(at(path), {
        recursive: true,
      });
    } else {
      mkdirSync(at(path, ".."), {
        recursive: true,
      });
      writeFileSync(at(path), "");
    }
  }
}

function list(
  after?: string,
  limit?: number,
  path = root,
  signal?: AbortSignal,
): Promise<StorageRecursivePage> {
  return adapter.readDirectoryRecursiveWithin(
    {
      path,
      after,
      limit,
    },
    signal,
    LIMITS,
  );
}

/** Follow `next` until the listing ends, returning every page. */
async function readAllPages(limit: number): Promise<StorageRecursivePage[]> {
  const pages: StorageRecursivePage[] = [];
  let after: string | undefined;
  do {
    const page = await list(after, limit);
    pages.push(page);
    after = page.next ?? undefined;
  } while (after !== undefined);
  return pages;
}

const paths = (entries: StorageRecursiveEntry[]) =>
  entries.map((entry) => entry.path);

async function codeOf(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
  } catch (error) {
    return error instanceof BunawayError ? error.code : String(error);
  }
  return "none";
}

test("descendants come depth first, a directory before its contents, in component order", async () => {
  // "a b" sorts before "a/x" as a plain string, but "a" and its contents come first by component.
  createTree([
    "b.txt",
    "a/x.txt",
    "a/deep/y.txt",
    "a b",
    "empty/",
  ]);
  const { entries, next } = await list();
  expect(next).toBeNull();
  expect(entries).toEqual([
    {
      path: "a",
      kind: "directory",
    },
    {
      path: "a/deep",
      kind: "directory",
    },
    {
      path: "a/deep/y.txt",
      kind: "file",
    },
    {
      path: "a/x.txt",
      kind: "file",
    },
    {
      path: "a b",
      kind: "file",
    },
    {
      path: "b.txt",
      kind: "file",
    },
    {
      path: "empty",
      kind: "directory",
    },
  ]);
});

test("pages of any size concatenate to the unpaged listing and the last page ends exactly", async () => {
  createTree([
    "a/1",
    "a/2",
    "a/sub/3",
    "b/",
    "c",
    "d/4",
    "d/5/6/7",
  ]);
  const whole = await list(undefined, MAX_DIRECTORY_ENTRIES);
  expect(whole.next).toBeNull();
  expect(whole.entries).toHaveLength(12);
  for (const limit of [
    1,
    2,
    3,
    5,
    12,
    13,
  ]) {
    const pages = await readAllPages(limit);
    expect(pages.flatMap((page) => page.entries)).toEqual(whole.entries);
    expect(pages.map((page) => page.next === null)).toEqual(
      pages.map((_, index) => index === pages.length - 1),
    );
    for (const page of pages) {
      expect(page.entries.length).toBeLessThanOrEqual(limit);
    }
  }
  // A page that ends on the last entry reports no next page.
  expect((await readAllPages(12)).length).toBe(1);
});

test("a cursor need not name an existing path and continues after its position", async () => {
  createTree([
    "a/1",
    "a/3",
    "b",
    "c/1",
  ]);
  expect(paths((await list("a/2")).entries)).toEqual([
    "a/3",
    "b",
    "c",
    "c/1",
  ]);
  expect(paths((await list("zzz")).entries)).toEqual([]);
  // A directory cursor continues into the directory, and one that went away is skipped.
  expect(paths((await list("c")).entries)).toEqual([
    "c/1",
  ]);
  expect(paths((await list("a0/x")).entries)).toEqual([
    "b",
    "c",
    "c/1",
  ]);
  // A cursor through a name that became a file lists nothing for it.
  expect(paths((await list("b/x")).entries)).toEqual([
    "c",
    "c/1",
  ]);
});

test("a cursor with empty or oversized components or too many levels is rejected", async () => {
  createTree([
    "a",
  ]);
  const tooDeep = Array.from(
    {
      length: MAX_RECURSIVE_PATH_COMPONENTS + 1,
    },
    () => "d",
  ).join("/");
  for (const after of [
    "/a",
    "a/",
    "a//b",
    "x".repeat(256),
    tooDeep,
  ]) {
    expect(await codeOf(() => list(after))).toBe("INVALID_ARGUMENT");
  }
});

test("a NUL mark after a longest name is a valid cursor but one more character is not", async () => {
  const longest = "n".repeat(255);
  expect(await list(`${longest}\u0000`)).toEqual({
    entries: [],
    next: null,
  });
  expect(
    await list(
      `${"d/".repeat(MAX_RECURSIVE_PATH_COMPONENTS - 1)}${longest}\u0000`,
    ),
  ).toEqual({
    entries: [],
    next: null,
  });
  expect(await codeOf(() => list(`${longest}x`))).toBe("INVALID_ARGUMENT");
  expect(await codeOf(() => list(`${longest}\u0000\u0000`))).toBe(
    "INVALID_ARGUMENT",
  );
  expect(await codeOf(() => list(`${longest}\u0000/a`))).toBe(
    "INVALID_ARGUMENT",
  );
});

test.skipIf(cannotDeny)(
  "a NUL cursor steps over a directory with a longest name and keeps its siblings",
  async () => {
    const longest = "d".repeat(255);
    createTree([
      `${longest}/x`,
      `${"d".repeat(254)}e`,
      "e",
    ]);
    chmodSync(at(longest), 0);
    try {
      expect(await codeOf(() => list())).toBe("PERMISSION_DENIED");
      expect(paths((await list(`${longest}\u0000`)).entries)).toEqual([
        `${"d".repeat(254)}e`,
        "e",
      ]);
    } finally {
      chmodSync(at(longest), 0o700);
    }
  },
);

test("links are listed as links and never entered", async () => {
  createTree([
    "target/inner",
    "tree/own",
  ]);
  let linked = true;
  try {
    symlinkSync(at("target"), at("tree", "dir-link"), "junction");
    symlinkSync(at("target", "inner"), at("tree", "file-link"), "file");
  } catch {
    // Creating links can need a privilege this runner lacks, which is not a storage failure.
    linked = false;
  }
  const { entries } = await list(undefined, undefined, at("tree"));
  expect(entries).toEqual(
    linked
      ? [
          {
            path: "dir-link",
            kind: "link",
          },
          {
            path: "file-link",
            kind: "link",
          },
          {
            path: "own",
            kind: "file",
          },
        ]
      : [
          {
            path: "own",
            kind: "file",
          },
        ],
  );
});

test("a link given as the root is followed and a file or missing root is rejected", async () => {
  createTree([
    "target/inner",
    "plain",
  ]);
  try {
    symlinkSync(at("target"), at("root-link"), "junction");
    expect(
      paths((await list(undefined, undefined, at("root-link"))).entries),
    ).toEqual([
      "inner",
    ]);
  } catch (error) {
    // Creating links can need a privilege this runner lacks.
    if (!(error instanceof Error && Reflect.get(error, "code") === "EPERM")) {
      throw error;
    }
  }
  for (const path of [
    at("plain"),
    at("missing"),
  ]) {
    expect(await codeOf(() => list(undefined, undefined, path))).toBe(
      "INVALID_ARGUMENT",
    );
  }
});

test("the entry and depth bounds fail the call with INVALID_ARGUMENT", async () => {
  createTree([
    "a/b/c/file",
    "x",
    "y",
  ]);
  const read = (limits: { entries: number; depth: number }) =>
    adapter.readDirectoryRecursiveWithin(
      {
        path: root,
      },
      undefined,
      limits,
    );
  // Six children are read in total: a, x, y, a/b, a/b/c and a/b/c/file.
  expect(
    (
      await read({
        entries: 6,
        depth: 3,
      })
    ).entries,
  ).toHaveLength(6);
  expect(
    await codeOf(() =>
      read({
        entries: 5,
        depth: 3,
      }),
    ),
  ).toBe("INVALID_ARGUMENT");
  expect(
    await codeOf(() =>
      read({
        entries: 6,
        depth: 2,
      }),
    ),
  ).toBe("INVALID_ARGUMENT");
});

test("a page after the cursor skips directories that sort before it", async () => {
  createTree([
    "a/1",
    "a/2",
    "a/3",
    "b/1",
  ]);
  // Reading "b/1" needs the root (2 children) and b (1 child), not the three children of a, so a bound of 4 holds.
  const page = await adapter.readDirectoryRecursiveWithin(
    {
      path: root,
      after: "b",
    },
    undefined,
    {
      entries: 4,
      depth: 8,
    },
  );
  expect(paths(page.entries)).toEqual([
    "b/1",
  ]);
});

test("a page stops before its paths exceed the character budget", async () => {
  const name = "n".repeat(255);
  const count = Math.ceil(MAX_RECURSIVE_PAGE_PATH_CHARACTERS / name.length) + 2;
  for (let index = 0; index < count; index++) {
    writeFileSync(at(`${String(index).padStart(3, "0")}${name.slice(3)}`), "");
  }
  const pages = await readAllPages(MAX_DIRECTORY_ENTRIES);
  expect(pages.length).toBeGreaterThan(1);
  for (const page of pages) {
    const characters = page.entries.reduce(
      (sum, entry) => sum + entry.path.length,
      0,
    );
    expect(characters).toBeLessThanOrEqual(MAX_RECURSIVE_PAGE_PATH_CHARACTERS);
  }
  expect(pages.flatMap((page) => page.entries)).toHaveLength(count);
});

test("the scan ends with CANCELLED when aborted and fails after the adapter is disposed", async () => {
  createTree([
    "a/1",
  ]);
  const controller = new AbortController();
  controller.abort();
  expect(
    await codeOf(() => list(undefined, undefined, root, controller.signal)),
  ).toBe("CANCELLED");
  adapter.dispose();
  expect(await codeOf(() => list())).not.toBe("none");
});

test("a cursor through a link lists nothing from the link target", async () => {
  createTree([
    "target/inner",
    "tree/own",
  ]);
  try {
    symlinkSync(at("target"), at("tree", "dir-link"), "junction");
  } catch {
    // Creating links can need a privilege this runner lacks, which is not a storage failure.
    return;
  }
  for (const after of [
    "dir-link/inner",
    "dir-link",
  ]) {
    expect(paths((await list(after, undefined, at("tree"))).entries)).toEqual([
      "own",
    ]);
  }
});

test.skipIf(cannotDeny)(
  "a directory that cannot be listed fails the call and the same cursor keeps failing",
  async () => {
    createTree([
      "a/denied/x",
      "a/denied-old",
      "a/denied.txt",
      "b",
    ]);
    chmodSync(at("a", "denied"), 0);
    try {
      expect(await codeOf(() => list())).toBe("PERMISSION_DENIED");
      expect(await codeOf(() => list("a"))).toBe("PERMISSION_DENIED");
      expect(await codeOf(() => list("a/denied"))).toBe("PERMISSION_DENIED");
      // A cursor right after the directory name steps over it and keeps the siblings that sort
      // between "denied" and "denied0".
      expect(paths((await list("a/denied\u0000")).entries)).toEqual([
        "a/denied-old",
        "a/denied.txt",
        "b",
      ]);
    } finally {
      chmodSync(at("a", "denied"), 0o700);
    }
  },
);

test.skipIf(cannotDeny)(
  "a page cut by the path length budget on a directory does not open it",
  async () => {
    const outer = "a".repeat(255);
    const last = "z".repeat(255);
    // 126 files, the outer directory and the last directory use 65,152 of the 65,536 characters,
    // so a child of the last directory (at least 513 more) cannot join this page.
    mkdirSync(at(outer, last, "x"), {
      recursive: true,
    });
    for (let index = 0; index < 126; index++) {
      writeFileSync(
        at(outer, `f${String(index).padStart(3, "0")}${"n".repeat(251)}`),
        "",
      );
    }
    chmodSync(at(outer, last), 0);
    try {
      const page = await list();
      expect(page.entries.at(-1)).toEqual({
        path: `${outer}/${last}`,
        kind: "directory",
      });
      expect(page.next).toBe(`${outer}/${last}`);
      expect(await codeOf(() => list(page.next ?? undefined))).toBe(
        "PERMISSION_DENIED",
      );
    } finally {
      chmodSync(at(outer, last), 0o700);
    }
  },
);

test.skipIf(cannotDeny)(
  "a page that ends on a directory does not open it",
  async () => {
    createTree([
      "ok.txt",
      "z/x",
    ]);
    chmodSync(at("z"), 0);
    try {
      const page = await list(undefined, 2);
      expect(page).toEqual({
        entries: [
          {
            path: "ok.txt",
            kind: "file",
          },
          {
            path: "z",
            kind: "directory",
          },
        ],
        next: "z",
      });
      expect(await codeOf(() => list(page.next ?? undefined, 2))).toBe(
        "PERMISSION_DENIED",
      );
    } finally {
      chmodSync(at("z"), 0o700);
    }
  },
);

test("a scan cancelled while it walks stops and closes its directory", async () => {
  createTree(
    Array.from(
      {
        length: 200,
      },
      (_, index) => `f${String(index).padStart(3, "0")}`,
    ),
  );
  let reads = 0;
  // Reports the abort on the 51st check, in the middle of reading the directory.
  const signal = Object.create(AbortSignal.prototype, {
    aborted: {
      get: () => ++reads > 50,
    },
  });
  expect(await codeOf(() => list(undefined, undefined, root, signal))).toBe(
    "CANCELLED",
  );
  expect(reads).toBeGreaterThan(50);
  // The handle was closed, so the tree can be listed again and removed afterwards.
  expect(await list()).toMatchObject({
    next: null,
  });
});

test("the operation validates its input and output and has its own permission", async () => {
  const location = {
    path: "C:/notes",
  };
  expect(
    await parsers.validateCall({
      operation: "storage.readDirectoryRecursive",
      payload: {
        ...location,
        after: "a/b",
        limit: MAX_DIRECTORY_ENTRIES,
      },
    }),
  ).toBeDefined();
  for (const extra of [
    {
      limit: 0,
    },
    {
      limit: MAX_DIRECTORY_ENTRIES + 1,
    },
    {
      after: "",
    },
    {
      after: "x".repeat(MAX_DIRECTORY_ENTRIES * 100),
    },
    {
      cursor: "b",
    },
  ]) {
    await expect(
      parsers.validateCall({
        operation: "storage.readDirectoryRecursive",
        payload: {
          ...location,
          ...extra,
        },
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  }
  const entry = {
    path: "a/b",
    kind: "directory",
  };
  const page = {
    entries: [
      entry,
    ],
    next: "a/b",
  };
  expect(
    await parsers.validateOutput("storage.readDirectoryRecursive", page),
  ).toEqual(page);
  for (const output of [
    {
      entries: [],
    },
    {
      entries: [
        {
          name: "a",
          kind: "file",
        },
      ],
      next: null,
    },
    {
      entries: [],
      next: "",
    },
  ]) {
    await expect(
      parsers.validateOutput("storage.readDirectoryRecursive", output),
    ).rejects.toThrow();
  }
  const registry = new NativeRegistry([
    storage._definition,
  ]);
  for (const target of registry.operations.keys()) {
    expect(
      registry.allowed(
        {
          permissions: [
            "storage.readDirectoryRecursive",
          ],
        },
        {
          operation: target,
          payload: location,
        },
      ),
    ).toBe(target === "storage.readDirectoryRecursive");
  }
});
