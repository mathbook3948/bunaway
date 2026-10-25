import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { BunawayError } from "@bunaway/protocol";
import {
  MAX_DIRECTORY_ENTRIES,
  MAX_STORAGE_BYTES,
  MAX_STORAGE_TEXT_BYTES,
} from "../../plugins/storage/src/contract.ts";
import {
  NodeStorage,
  storageError,
} from "../../plugins/storage/src/platforms/node-storage.ts";

/** The shared operations with the simplest path rules and a link-and-unlink rename that never replaces. */
class TestStorage extends NodeStorage {
  constructor() {
    super({
      normalize: (path) => path,
      isBelow: (parent, child) => child.startsWith(`${parent}${sep}`),
    });
  }

  protected moveWithoutReplace(from: string, to: string): void {
    try {
      // The real platform renames call the OS without the replace flag; a check stands in here.
      if (existsSync(to)) {
        throw Object.assign(new Error("exists"), {
          code: "EEXIST",
        });
      }
      renameSync(from, to);
    } catch (error) {
      throw storageError(error);
    }
  }

  protected release(): void {}
}

let root = "";
let storage = new TestStorage();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bunaway-storage-"));
  storage = new TestStorage();
});

afterEach(() => {
  storage.dispose();
  rmSync(root, {
    recursive: true,
    force: true,
  });
});

const at = (...parts: string[]) => join(root, ...parts);

/** Create a link when the platform allows it; callers skip their link checks otherwise. */
function link(
  target: string,
  path: string,
  type?: "dir" | "junction",
): boolean {
  try {
    symlinkSync(target, path, type);
    return true;
  } catch {
    // Creating links can need a privilege this runner lacks, which is not a storage failure.
    return false;
  }
}

function codeOf(action: () => unknown): string | undefined {
  try {
    action();
  } catch (error) {
    return error instanceof BunawayError ? error.code : String(error);
  }
  return undefined;
}

async function asyncCodeOf(
  action: () => Promise<unknown>,
): Promise<string | undefined> {
  try {
    await action();
  } catch (error) {
    return error instanceof BunawayError ? error.code : String(error);
  }
  return undefined;
}

test("text and bytes round trip, replace shorter content and create parent folders", () => {
  const path = at("a", "b", "한글.txt");
  storage.writeText({
    path,
    text: "﻿hello world",
  });
  expect(
    storage.readText({
      path,
    }),
  ).toBe("﻿hello world");
  storage.writeText({
    path,
    text: "hi",
  });
  expect(readFileSync(path, "utf8")).toBe("hi");
  storage.appendText({
    path,
    text: "!",
  });
  expect(
    storage.readText({
      path,
    }),
  ).toBe("hi!");
  const bytes = Buffer.from([
    0,
    255,
    128,
  ]);
  storage.writeBytes({
    path,
    bytes: bytes.toString("base64"),
  });
  storage.appendBytes({
    path,
    bytes: bytes.toString("base64"),
  });
  expect(
    storage.readBytes({
      path,
    }),
  ).toBe(
    Buffer.concat([
      bytes,
      bytes,
    ]).toString("base64"),
  );
  expect(
    storage.stat({
      path,
    }),
  ).toMatchObject({
    kind: "file",
    sizeBytes: 6,
  });
});

test("reads refuse files above the bound and invalid UTF-8", () => {
  const path = at("big.bin");
  writeFileSync(path, Buffer.alloc(MAX_STORAGE_BYTES + 1));
  expect(() =>
    storage.readBytes({
      path,
    }),
  ).toThrow();
  writeFileSync(
    at("bad.txt"),
    Buffer.from([
      0xff,
    ]),
  );
  expect(() =>
    storage.readText({
      path: at("bad.txt"),
    }),
  ).toThrow();
});

test("a missing file or parent, and a directory used as a file, are INVALID_ARGUMENT", () => {
  mkdirSync(at("dir"));
  expect(
    codeOf(() =>
      storage.readText({
        path: at("missing.txt"),
      }),
    ),
  ).toBe("INVALID_ARGUMENT");
  expect(
    codeOf(() =>
      storage.readText({
        path: at("dir"),
      }),
    ),
  ).toBe("INVALID_ARGUMENT");
  expect(
    codeOf(() =>
      storage.writeText({
        path: at("dir"),
        text: "x",
      }),
    ),
  ).toBe("INVALID_ARGUMENT");
  writeFileSync(at("file"), "x");
  // A file in the way of a parent folder cannot be created over.
  expect(
    codeOf(() =>
      storage.writeText({
        path: at("file", "child.txt"),
        text: "x",
      }),
    ),
  ).toBe("INVALID_ARGUMENT");
});

test("a FIFO is refused instead of blocking", () => {
  if (process.platform === "win32") {
    return;
  }
  const path = at("pipe");
  expect(
    Bun.spawnSync([
      "mkfifo",
      path,
    ]).exitCode,
  ).toBe(0);
  expect(
    codeOf(() =>
      storage.readText({
        path,
      }),
    ),
  ).toBe("INVALID_ARGUMENT");
  expect(
    codeOf(() =>
      storage.writeText({
        path,
        text: "x",
      }),
    ),
  ).toBeDefined();
});

test("an unreadable file is PERMISSION_DENIED", () => {
  if (process.platform === "win32" || process.getuid?.() === 0) {
    return;
  }
  const path = at("locked.txt");
  writeFileSync(path, "secret");
  chmodSync(path, 0);
  expect(
    codeOf(() =>
      storage.readText({
        path,
      }),
    ),
  ).toBe("PERMISSION_DENIED");
});

test("links are followed like any other path", () => {
  mkdirSync(at("real"));
  writeFileSync(at("real", "data.txt"), "target");
  if (!link(at("real", "data.txt"), at("alias.txt"))) {
    return;
  }
  expect(
    storage.readText({
      path: at("alias.txt"),
    }),
  ).toBe("target");
  storage.writeText({
    path: at("alias.txt"),
    text: "updated",
  });
  expect(readFileSync(at("real", "data.txt"), "utf8")).toBe("updated");
  if (link(at("real"), at("dir-alias"), "junction")) {
    expect(
      storage.stat({
        path: at("dir-alias"),
      })?.kind,
    ).toBe("directory");
    expect(
      storage.readText({
        path: at("dir-alias", "data.txt"),
      }),
    ).toBe("updated");
  }
  link(at("nowhere"), at("dangling"));
  expect(
    storage.exists({
      path: at("dangling"),
    }),
  ).toBe(false);
  expect(
    storage.stat({
      path: at("dangling"),
    }),
  ).toBeNull();
});

test("hardlinked files are ordinary files", () => {
  writeFileSync(at("one.txt"), "shared");
  linkSync(at("one.txt"), at("two.txt"));
  expect(
    storage.readText({
      path: at("two.txt"),
    }),
  ).toBe("shared");
  storage.writeText({
    path: at("two.txt"),
    text: "both",
  });
  expect(readFileSync(at("one.txt"), "utf8")).toBe("both");
});

test("exists and stat report missing paths without failing", () => {
  expect(
    storage.exists({
      path: at("missing"),
    }),
  ).toBe(false);
  expect(
    storage.stat({
      path: at("missing"),
    }),
  ).toBeNull();
  writeFileSync(at("file"), "x");
  expect(
    storage.exists({
      path: at("file", "below"),
    }),
  ).toBe(false);
  expect(
    storage.stat({
      path: root,
    }),
  ).toMatchObject({
    kind: "directory",
    sizeBytes: null,
  });
});

test("readDirectory lists names and kinds sorted without following links", () => {
  mkdirSync(at("folder"));
  writeFileSync(at("b.txt"), "x");
  writeFileSync(at("a.txt"), "x");
  const linked = link(at("folder"), at("link"), "junction");
  const listed = storage.readDirectory({
    path: root,
  });
  expect(listed.map((entry) => entry.name)).toEqual(
    [
      "a.txt",
      "b.txt",
      "folder",
      ...(linked
        ? [
            "link",
          ]
        : []),
    ].sort(),
  );
  expect(listed.find((entry) => entry.name === "folder")?.kind).toBe(
    "directory",
  );
  expect(listed.find((entry) => entry.name === "a.txt")?.kind).toBe("file");
  if (linked) {
    expect(listed.find((entry) => entry.name === "link")?.kind).toBe("link");
  }
  expect(
    codeOf(() =>
      storage.readDirectory({
        path: at("a.txt"),
      }),
    ),
  ).toBe("INVALID_ARGUMENT");
});

test("readDirectory refuses more than the entry limit", () => {
  for (let index = 0; index <= MAX_DIRECTORY_ENTRIES; index++) {
    writeFileSync(at(`f${index}`), "");
  }
  expect(
    codeOf(() =>
      storage.readDirectory({
        path: root,
      }),
    ),
  ).toBe("INVALID_ARGUMENT");
});

test("createDirectory is idempotent, honors recursive and refuses a file in the way", () => {
  storage.createDirectory({
    path: at("one"),
    recursive: false,
  });
  storage.createDirectory({
    path: at("one"),
    recursive: false,
  });
  storage.createDirectory({
    path: at("two", "three"),
    recursive: true,
  });
  expect(
    storage.stat({
      path: at("two", "three"),
    })?.kind,
  ).toBe("directory");
  expect(
    codeOf(() =>
      storage.createDirectory({
        path: at("missing", "child"),
        recursive: false,
      }),
    ),
  ).toBe("INVALID_ARGUMENT");
  if (link(at("one"), at("one-alias"), "junction")) {
    // A name that is a link to a directory counts as that directory.
    storage.createDirectory({
      path: at("one-alias"),
      recursive: false,
    });
  }
  writeFileSync(at("file"), "x");
  for (const recursive of [
    false,
    true,
  ]) {
    expect(
      codeOf(() =>
        storage.createDirectory({
          path: at("file"),
          recursive,
        }),
      ),
    ).toBe("INVALID_ARGUMENT");
  }
});

test("remove deletes a file or empty directory and refuses a directory with entries", () => {
  writeFileSync(at("file"), "x");
  storage.remove({
    path: at("file"),
  });
  mkdirSync(at("empty"));
  storage.remove({
    path: at("empty"),
  });
  mkdirSync(at("full"));
  writeFileSync(at("full", "child"), "x");
  expect(
    codeOf(() =>
      storage.remove({
        path: at("full"),
      }),
    ),
  ).toBe("INVALID_ARGUMENT");
  expect(
    codeOf(() =>
      storage.remove({
        path: at("missing"),
      }),
    ),
  ).toBe("INVALID_ARGUMENT");
});

test("remove deletes a link and keeps its target", () => {
  mkdirSync(at("target"));
  writeFileSync(at("target", "keep.txt"), "x");
  if (link(at("target"), at("alias"), "junction")) {
    storage.remove({
      path: at("alias"),
    });
    expect(
      storage.exists({
        path: at("alias"),
      }),
    ).toBe(false);
    expect(readFileSync(at("target", "keep.txt"), "utf8")).toBe("x");
  }
});

test("removeRecursive removes a tree and links inside it without touching their targets", async () => {
  mkdirSync(at("outside"));
  writeFileSync(at("outside", "keep.txt"), "x");
  mkdirSync(at("tree", "inner"), {
    recursive: true,
  });
  writeFileSync(at("tree", "inner", "file.txt"), "x");
  const linked = link(at("outside"), at("tree", "dir-link"), "junction");
  await storage.removeRecursive({
    path: at("tree"),
  });
  expect(
    storage.exists({
      path: at("tree"),
    }),
  ).toBe(false);
  expect(readFileSync(at("outside", "keep.txt"), "utf8")).toBe("x");
  if (linked) {
    link(at("outside"), at("root-link"), "junction");
    await storage.removeRecursive({
      path: at("root-link"),
    });
    expect(
      storage.exists({
        path: at("root-link"),
      }),
    ).toBe(false);
    expect(readFileSync(at("outside", "keep.txt"), "utf8")).toBe("x");
  }
  writeFileSync(at("single"), "x");
  await storage.removeRecursive({
    path: at("single"),
  });
  expect(
    storage.exists({
      path: at("single"),
    }),
  ).toBe(false);
});

test("removeRecursive reports a missing target and honors cancellation before it starts", async () => {
  expect(
    await asyncCodeOf(() =>
      storage.removeRecursive({
        path: at("missing"),
      }),
    ),
  ).toBe("INVALID_ARGUMENT");
  mkdirSync(at("tree"));
  const controller = new AbortController();
  controller.abort();
  expect(
    await asyncCodeOf(() =>
      storage.removeRecursive(
        {
          path: at("tree"),
        },
        controller.signal,
      ),
    ),
  ).toBe("CANCELLED");
  expect(
    storage.exists({
      path: at("tree"),
    }),
  ).toBe(true);
});

test("directorySize totals files per name and skips links and nothing outside", async () => {
  mkdirSync(at("tree", "inner", "deep"), {
    recursive: true,
  });
  writeFileSync(at("tree", "a.bin"), Buffer.alloc(10));
  writeFileSync(at("tree", "inner", "b.bin"), Buffer.alloc(5));
  linkSync(at("tree", "a.bin"), at("tree", "inner", "deep", "a-again.bin"));
  mkdirSync(at("outside"));
  writeFileSync(at("outside", "big.bin"), Buffer.alloc(1000));
  link(at("outside"), at("tree", "dir-link"), "junction");
  link(at("outside", "big.bin"), at("tree", "file-link"));
  expect(
    await storage.directorySize({
      path: at("tree"),
    }),
  ).toEqual({
    bytes: 25,
    files: 3,
    directories: 2,
  });
  expect(
    await asyncCodeOf(() =>
      storage.directorySize({
        path: at("tree", "a.bin"),
      }),
    ),
  ).toBe("INVALID_ARGUMENT");
  expect(
    await asyncCodeOf(() =>
      storage.directorySize({
        path: at("missing"),
      }),
    ),
  ).toBe("INVALID_ARGUMENT");
});

test("directorySize enforces its entry and depth bounds", async () => {
  mkdirSync(at("tree", "one", "two"), {
    recursive: true,
  });
  writeFileSync(at("tree", "a"), "x");
  writeFileSync(at("tree", "b"), "x");
  const input = {
    path: at("tree"),
  };
  expect(
    await storage.directorySizeWithin(input, undefined, {
      entries: 4,
      depth: 2,
    }),
  ).toMatchObject({
    files: 2,
    directories: 2,
  });
  expect(
    await asyncCodeOf(() =>
      storage.directorySizeWithin(input, undefined, {
        entries: 3,
        depth: 2,
      }),
    ),
  ).toBe("INVALID_ARGUMENT");
  expect(
    await asyncCodeOf(() =>
      storage.directorySizeWithin(input, undefined, {
        entries: 4,
        depth: 1,
      }),
    ),
  ).toBe("INVALID_ARGUMENT");
});

test("directorySize stops when cancelled or when the adapter is disposed", async () => {
  mkdirSync(at("tree"));
  for (let index = 0; index < 100; index++) {
    writeFileSync(at("tree", `f${index}`), "x");
  }
  const controller = new AbortController();
  controller.abort();
  expect(
    await asyncCodeOf(() =>
      storage.directorySize(
        {
          path: at("tree"),
        },
        controller.signal,
      ),
    ),
  ).toBe("CANCELLED");
  const running = storage.directorySize({
    path: at("tree"),
  });
  storage.dispose();
  expect(await asyncCodeOf(() => running)).toBe("CANCELLED");
});

test("copyFile creates a new file and never replaces an existing name", () => {
  writeFileSync(
    at("source.bin"),
    Buffer.from([
      1,
      2,
      3,
      0,
    ]),
  );
  storage.copyFile({
    from: at("source.bin"),
    to: at("copy.bin"),
  });
  expect(readFileSync(at("copy.bin"))).toEqual(
    Buffer.from([
      1,
      2,
      3,
      0,
    ]),
  );
  writeFileSync(at("empty"), "");
  storage.copyFile({
    from: at("empty"),
    to: at("empty-copy"),
  });
  expect(readFileSync(at("empty-copy")).length).toBe(0);
  writeFileSync(at("existing"), "keep");
  expect(
    codeOf(() =>
      storage.copyFile({
        from: at("source.bin"),
        to: at("existing"),
      }),
    ),
  ).toBe("INVALID_ARGUMENT");
  expect(readFileSync(at("existing"), "utf8")).toBe("keep");
  mkdirSync(at("folder"));
  expect(
    codeOf(() =>
      storage.copyFile({
        from: at("source.bin"),
        to: at("folder"),
      }),
    ),
  ).toBe("INVALID_ARGUMENT");
  mkdirSync(at("target"));
  writeFileSync(at("target", "keep.txt"), "keep");
  if (link(at("target", "keep.txt"), at("alias"))) {
    // A link at the destination is an existing name, so the target behind it stays intact.
    expect(
      codeOf(() =>
        storage.copyFile({
          from: at("source.bin"),
          to: at("alias"),
        }),
      ),
    ).toBe("INVALID_ARGUMENT");
    expect(readFileSync(at("target", "keep.txt"), "utf8")).toBe("keep");
  }
  // Windows CREATE_NEW follows a dangling link and creates its target, so only POSIX refuses it.
  if (process.platform !== "win32" && link(at("nowhere"), at("dangling"))) {
    expect(
      codeOf(() =>
        storage.copyFile({
          from: at("source.bin"),
          to: at("dangling"),
        }),
      ),
    ).toBe("INVALID_ARGUMENT");
    expect(
      storage.exists({
        path: at("nowhere"),
      }),
    ).toBe(false);
  }
});

test("copyFile refuses a missing source and a missing parent without creating anything", () => {
  writeFileSync(at("present.bin"), "x");
  expect(
    codeOf(() =>
      storage.copyFile({
        from: at("missing"),
        to: at("never.bin"),
      }),
    ),
  ).toBe("INVALID_ARGUMENT");
  expect(
    codeOf(() =>
      storage.copyFile({
        from: at("present.bin"),
        to: at("no-parent", "copy.bin"),
      }),
    ),
  ).toBe("INVALID_ARGUMENT");
  expect(existsSync(at("never.bin"))).toBe(false);
  expect(existsSync(at("no-parent"))).toBe(false);
});

test("copyFile has no size bound and copies a source above the old 4 MiB limit", () => {
  const bytes = Buffer.alloc(5 * 1024 * 1024 + 1, 3);
  writeFileSync(at("big.bin"), bytes);
  storage.copyFile({
    from: at("big.bin"),
    to: at("copy.bin"),
  });
  expect(readFileSync(at("copy.bin")).equals(bytes)).toBe(true);
});

test("readBytes returns the requested range and nothing outside it", () => {
  const path = at("range.bin");
  const bytes = Buffer.from("0123456789");
  writeFileSync(path, bytes);
  const range = (input: { offset?: number; length?: number }) =>
    Buffer.from(
      storage.readBytes({
        path,
        ...input,
      }),
      "base64",
    ).toString();
  expect(
    range({
      offset: 2,
      length: 3,
    }),
  ).toBe("234");
  expect(
    range({
      offset: 8,
      length: 5,
    }),
  ).toBe("89");
  expect(
    range({
      offset: 10,
      length: 1,
    }),
  ).toBe("");
  expect(
    range({
      offset: 99,
      length: 1,
    }),
  ).toBe("");
  expect(
    range({
      offset: 4,
    }),
  ).toBe("456789");
  expect(
    range({
      length: 4,
    }),
  ).toBe("0123");
  expect(
    range({
      offset: 0,
      length: 10,
    }),
  ).toBe("0123456789");
});

test("readBytes reads a range of a file above the whole-file bound", () => {
  const path = at("huge-range.bin");
  const bytes = Buffer.alloc(MAX_STORAGE_BYTES * 3, 1);
  bytes.writeUInt8(9, MAX_STORAGE_BYTES * 2);
  writeFileSync(path, bytes);
  const part = Buffer.from(
    storage.readBytes({
      path,
      offset: MAX_STORAGE_BYTES * 2,
      length: 2,
    }),
    "base64",
  );
  expect([
    ...part,
  ]).toEqual([
    9,
    1,
  ]);
  expect(() =>
    storage.readBytes({
      path,
    }),
  ).toThrow(
    expect.objectContaining({
      code: "INVALID_ARGUMENT",
    }),
  );
});

test("readText refuses files and escaped text that cannot fit one reply", () => {
  writeFileSync(at("fits.txt"), "a".repeat(MAX_STORAGE_TEXT_BYTES));
  expect(
    storage.readText({
      path: at("fits.txt"),
    }),
  ).toHaveLength(MAX_STORAGE_TEXT_BYTES);
  writeFileSync(at("long.txt"), "a".repeat(MAX_STORAGE_TEXT_BYTES + 1));
  expect(
    codeOf(() =>
      storage.readText({
        path: at("long.txt"),
      }),
    ),
  ).toBe("INVALID_ARGUMENT");
  // NUL escapes to six bytes in JSON, so a file well under the byte limit can still be too large.
  writeFileSync(at("escaped.txt"), "\0".repeat(200 * 1024));
  expect(
    codeOf(() =>
      storage.readText({
        path: at("escaped.txt"),
      }),
    ),
  ).toBe("INVALID_ARGUMENT");
});

test("move renames files and directories and refuses an existing destination or itself", () => {
  writeFileSync(at("one.txt"), "x");
  storage.move({
    from: at("one.txt"),
    to: at("two.txt"),
  });
  expect(
    storage.exists({
      path: at("one.txt"),
    }),
  ).toBe(false);
  mkdirSync(at("dir"));
  storage.move({
    from: at("dir"),
    to: at("moved"),
  });
  expect(
    storage.stat({
      path: at("moved"),
    })?.kind,
  ).toBe("directory");
  writeFileSync(at("other.txt"), "y");
  expect(
    codeOf(() =>
      storage.move({
        from: at("two.txt"),
        to: at("other.txt"),
      }),
    ),
  ).toBe("INVALID_ARGUMENT");
  expect(readFileSync(at("other.txt"), "utf8")).toBe("y");
  expect(
    codeOf(() =>
      storage.move({
        from: at("moved"),
        to: at("moved", "inside"),
      }),
    ),
  ).toBe("INVALID_ARGUMENT");
  expect(
    codeOf(() =>
      storage.move({
        from: at("missing"),
        to: at("anywhere"),
      }),
    ),
  ).toBe("INVALID_ARGUMENT");
});

test("copyDirectory copies a nested tree, empty directories and empty files, and reports what it copied", async () => {
  mkdirSync(at("src", "한글", "deep"), {
    recursive: true,
  });
  mkdirSync(at("src", "empty"));
  writeFileSync(at("src", "a.txt"), "alpha");
  writeFileSync(
    at("src", "한글", "b.bin"),
    Buffer.from([
      0,
      255,
      1,
    ]),
  );
  writeFileSync(at("src", "한글", "deep", "zero"), "");
  const result = await storage.copyDirectory({
    from: at("src"),
    to: at("dst"),
  });
  expect(result).toEqual({
    bytes: 8,
    files: 3,
    directories: 3,
  });
  expect(readFileSync(at("dst", "a.txt"), "utf8")).toBe("alpha");
  expect([
    ...readFileSync(at("dst", "한글", "b.bin")),
  ]).toEqual([
    0,
    255,
    1,
  ]);
  expect(readFileSync(at("dst", "한글", "deep", "zero"))).toHaveLength(0);
  expect(existsSync(at("dst", "empty"))).toBe(true);
  expect(readFileSync(at("src", "a.txt"), "utf8")).toBe("alpha");
});

test("copyDirectory never merges into or replaces an existing destination", async () => {
  mkdirSync(at("src"));
  writeFileSync(at("src", "a.txt"), "new");
  mkdirSync(at("dst"));
  writeFileSync(at("dst", "a.txt"), "old");
  writeFileSync(at("file"), "x");
  for (const to of [
    at("dst"),
    at("file"),
  ]) {
    expect(
      await asyncCodeOf(() =>
        storage.copyDirectory({
          from: at("src"),
          to,
        }),
      ),
    ).toBe("INVALID_ARGUMENT");
  }
  expect(readFileSync(at("dst", "a.txt"), "utf8")).toBe("old");
  expect(readFileSync(at("file"), "utf8")).toBe("x");
});

test("copyDirectory refuses a missing source, a file source and a missing destination parent", async () => {
  writeFileSync(at("file"), "x");
  mkdirSync(at("src"));
  for (const input of [
    {
      from: at("missing"),
      to: at("dst"),
    },
    {
      from: at("file"),
      to: at("dst"),
    },
    {
      from: at("src"),
      to: at("no-parent", "dst"),
    },
  ]) {
    expect(await asyncCodeOf(() => storage.copyDirectory(input))).toBe(
      "INVALID_ARGUMENT",
    );
  }
  expect(existsSync(at("dst"))).toBe(false);
});

test("copyDirectory refuses a destination inside the source before creating anything", async () => {
  mkdirSync(at("src", "sub"), {
    recursive: true,
  });
  writeFileSync(at("src", "a.txt"), "x");
  for (const to of [
    at("src", "copy"),
    at("src", "sub", "copy"),
  ]) {
    expect(
      await asyncCodeOf(() =>
        storage.copyDirectory({
          from: at("src"),
          to,
        }),
      ),
    ).toBe("INVALID_ARGUMENT");
    expect(existsSync(to)).toBe(false);
  }
});

test("copyDirectory refuses a destination that a link places inside the source before creating anything", async () => {
  mkdirSync(at("src"));
  writeFileSync(at("src", "a.txt"), "x");
  if (!link(at("src"), at("alias"), "junction")) {
    return;
  }
  expect(
    await asyncCodeOf(() =>
      storage.copyDirectory({
        from: at("src"),
        to: at("alias", "copy"),
      }),
    ),
  ).toBe("INVALID_ARGUMENT");
  // The destination is resolved before anything is created, so the source is left untouched.
  expect(existsSync(at("src", "copy"))).toBe(false);
});

test("copyDirectory fails on a link entry without copying or touching its target", async () => {
  mkdirSync(at("src"));
  mkdirSync(at("outside"));
  writeFileSync(at("outside", "secret.txt"), "secret");
  if (!link(at("outside"), at("src", "ln"), "junction")) {
    return;
  }
  expect(
    await asyncCodeOf(() =>
      storage.copyDirectory({
        from: at("src"),
        to: at("dst"),
      }),
    ),
  ).toBe("INVALID_ARGUMENT");
  expect(existsSync(at("dst", "ln"))).toBe(false);
  expect(existsSync(at("outside", "secret.txt"))).toBe(true);
});

test("copyDirectory follows a link given as the root but copies the files below it", async () => {
  mkdirSync(at("real"));
  writeFileSync(at("real", "a.txt"), "x");
  if (!link(at("real"), at("alias"), "junction")) {
    return;
  }
  expect(
    await storage.copyDirectory({
      from: at("alias"),
      to: at("dst"),
    }),
  ).toMatchObject({
    files: 1,
  });
  expect(readFileSync(at("dst", "a.txt"), "utf8")).toBe("x");
});

test("copyDirectory enforces the entry and depth bounds", async () => {
  mkdirSync(at("src", "one", "two"), {
    recursive: true,
  });
  writeFileSync(at("src", "a"), "x");
  writeFileSync(at("src", "b"), "x");
  const input = (name: string) => ({
    from: at("src"),
    to: at(name),
  });
  expect(
    await storage.copyDirectoryWithin(input("ok"), undefined, {
      entries: 4,
      depth: 2,
    }),
  ).toMatchObject({
    files: 2,
    directories: 2,
  });
  expect(
    await asyncCodeOf(() =>
      storage.copyDirectoryWithin(input("entries"), undefined, {
        entries: 3,
        depth: 2,
      }),
    ),
  ).toBe("INVALID_ARGUMENT");
  expect(
    await asyncCodeOf(() =>
      storage.copyDirectoryWithin(input("depth"), undefined, {
        entries: 4,
        depth: 1,
      }),
    ),
  ).toBe("INVALID_ARGUMENT");
});

test("copyDirectory stops when cancelled or when the adapter is disposed", async () => {
  mkdirSync(at("src"));
  for (let index = 0; index < 100; index++) {
    writeFileSync(at("src", `f${index}`), "x");
  }
  const controller = new AbortController();
  controller.abort();
  expect(
    await asyncCodeOf(() =>
      storage.copyDirectory(
        {
          from: at("src"),
          to: at("dst"),
        },
        controller.signal,
      ),
    ),
  ).toBe("CANCELLED");
  expect(existsSync(at("dst"))).toBe(false);
  storage.dispose();
  expect(
    await asyncCodeOf(() =>
      storage.copyDirectory({
        from: at("src"),
        to: at("dst2"),
      }),
    ),
  ).toBe("CANCELLED");
});

test("a disposed adapter refuses work", () => {
  storage.dispose();
  storage.dispose();
  expect(
    codeOf(() =>
      storage.exists({
        path: root,
      }),
    ),
  ).toBe("CANCELLED");
});
