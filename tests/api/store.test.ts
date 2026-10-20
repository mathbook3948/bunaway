import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import store from "@bunaway/plugin-store";
import { type JsonValue, NativeRegistry } from "@bunaway/protocol";
import {
  loadInputSchema,
  MAX_OPEN_STORES,
  MAX_STORE_KEYS,
  MAX_STORE_VALUE_BYTES,
} from "#plugins/store/src/contract";
import { storeOperations } from "#plugins/store/src/operations";
import {
  NodeStore,
  type StoreFileOperations,
} from "#plugins/store/src/platforms/node-store";
import { deadline, waitFor } from "../fixtures/deadlines";

setDefaultTimeout(deadline("build"));

const roots: string[] = [];
const instances: NodeStore[] = [];

afterEach(() => {
  for (const instance of instances.splice(0)) {
    try {
      instance.dispose();
    } catch {
      // A test that rehearses a failed shutdown save leaves the store dirty on purpose.
    }
  }
  for (const root of roots.splice(0)) {
    rmSync(root, {
      recursive: true,
      force: true,
    });
  }
});

function dataRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "bunaway-store-"));
  roots.push(root);
  return root;
}

function create(root: string, files?: StoreFileOperations): NodeStore {
  const instance =
    files === undefined ? new NodeStore(root) : new NodeStore(root, files);
  instances.push(instance);
  return instance;
}

const storeFile = (root: string, name: string) =>
  join(root, "data", "stores", `${name}.json`);
const readStored = (root: string, name: string) =>
  JSON.parse(readFileSync(storeFile(root, name), "utf8"));
const manual = {
  autosave: false,
} as const;

function errorCodeOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return (
      error as {
        code?: string;
      }
    ).code;
  }
  return undefined;
}

test("store operations have their own permissions and strict inputs", () => {
  const registry = new NativeRegistry([
    store._definition,
  ]);
  const grant = (
    permissions: string[],
    operation: string,
    payload: JsonValue,
  ) =>
    registry.allowed(
      {
        permissions,
      },
      {
        operation,
        payload,
      },
    );
  expect(
    grant(
      [
        "store.get",
      ],
      "store.get",
      {
        name: "a",
        key: "k",
      },
    ),
  ).toBe(true);
  expect(
    grant(
      [
        "store.get",
      ],
      "store.set",
      {
        name: "a",
        key: "k",
        value: 1,
      },
    ),
  ).toBe(false);
  expect(
    grant([], "store.get", {
      name: "a",
      key: "k",
    }),
  ).toBe(false);
  expect(Object.keys(storeOperations).sort()).toEqual([
    "clear",
    "close",
    "delete",
    "entries",
    "get",
    "has",
    "keys",
    "length",
    "load",
    "reload",
    "reset",
    "save",
    "set",
  ]);
  expect(
    storeOperations.get.input.safeParse({
      name: "a",
      key: "k",
      extra: 1,
    }).success,
  ).toBe(false);
});

test("a store name is limited to a safe file name on every platform", () => {
  const accepted = [
    "settings",
    "a",
    "user_prefs-2",
    "x".repeat(64),
  ];
  const refused = [
    "",
    "Settings",
    "..",
    "a/b",
    "a.b",
    "-lead",
    "con",
    "nul",
    "com1",
    "lpt1",
    "x".repeat(65),
  ];
  for (const name of accepted) {
    expect(
      loadInputSchema.safeParse({
        name,
      }).success,
    ).toBe(true);
  }
  for (const name of refused) {
    expect(
      loadInputSchema.safeParse({
        name,
      }).success,
    ).toBe(false);
  }
});

test("values survive a save and a new instance reads them from the fixed location", () => {
  const root = dataRoot();
  const first = create(root);
  expect(
    first.load({
      name: "settings",
      ...manual,
    }),
  ).toEqual({
    loaded: "new",
  });
  expect(first.set("settings", "theme", "dark")).toEqual({
    changed: true,
  });
  first.set("settings", "nested", {
    list: [
      1,
      null,
      true,
    ],
    text: "한글",
  });
  first.set("settings", "nothing", null);
  expect(existsSync(storeFile(root, "settings"))).toBe(false);
  first.save("settings");
  expect(readdirSync(join(root, "data", "stores"))).toEqual([
    "settings.json",
  ]);
  first.dispose();

  const second = create(root);
  expect(
    second.load({
      name: "settings",
      ...manual,
    }),
  ).toEqual({
    loaded: "file",
  });
  expect(second.keys("settings")).toEqual([
    "theme",
    "nested",
    "nothing",
  ]);
  expect(second.get("settings", "nothing")).toEqual({
    found: true,
    value: null,
  });
  expect(second.get("settings", "missing")).toEqual({
    found: false,
  });
  expect(second.has("settings", "theme")).toBe(true);
  expect(second.length("settings")).toBe(3);
  expect(second.entries("settings")[1]).toEqual([
    "nested",
    {
      list: [
        1,
        null,
        true,
      ],
      text: "한글",
    },
  ]);
});

test("operations on a store that was not loaded are refused", () => {
  const instance = create(dataRoot());
  expect(errorCodeOf(() => instance.get("nope", "k"))).toBe("INVALID_ARGUMENT");
  expect(errorCodeOf(() => instance.save("nope"))).toBe("INVALID_ARGUMENT");
  expect(instance.close("nope")).toBeNull();
});

test("defaults fill missing keys, the file wins conflicts and nested objects are replaced whole", () => {
  const root = dataRoot();
  mkdirSync(join(root, "data", "stores"), {
    recursive: true,
  });
  writeFileSync(
    storeFile(root, "prefs"),
    JSON.stringify({
      a: "file",
      nested: {
        only: "file",
      },
    }),
  );
  const instance = create(root);
  const defaults = {
    a: "default",
    b: "default",
    nested: {
      only: "default",
      extra: 1,
    },
  };
  expect(
    instance.load({
      name: "prefs",
      defaults,
      ...manual,
    }),
  ).toEqual({
    loaded: "file",
  });
  expect(Object.fromEntries(instance.entries("prefs"))).toEqual({
    a: "file",
    b: "default",
    nested: {
      only: "file",
    },
  });
  // Loading does not write; the merged keys reach the file with the next save.
  expect(readStored(root, "prefs")).toEqual({
    a: "file",
    nested: {
      only: "file",
    },
  });
  instance.save("prefs");
  expect(readStored(root, "prefs").b).toBe("default");
});

test("a missing file starts from the defaults without writing", () => {
  const root = dataRoot();
  const instance = create(root);
  expect(
    instance.load({
      name: "fresh",
      defaults: {
        k: 1,
      },
      ...manual,
    }),
  ).toEqual({
    loaded: "new",
  });
  expect(instance.get("fresh", "k")).toEqual({
    found: true,
    value: 1,
  });
  expect(existsSync(storeFile(root, "fresh"))).toBe(false);
});

test("reload, reset and clear differ and report whether anything changed", () => {
  const root = dataRoot();
  const instance = create(root);
  const defaults = {
    a: 1,
    b: 2,
  };
  instance.load({
    name: "s",
    defaults,
    ...manual,
  });
  instance.set("s", "a", 10);
  instance.set("s", "c", 3);
  instance.save("s");

  instance.set("s", "a", 99);
  // reload drops the unsaved change and keeps the saved file over the defaults.
  expect(instance.reload("s", false)).toEqual({
    changed: true,
  });
  expect(Object.fromEntries(instance.entries("s"))).toEqual({
    a: 10,
    b: 2,
    c: 3,
  });
  expect(instance.reload("s", false)).toEqual({
    changed: false,
  });
  // ignoreDefaults keeps only what the file holds, and the earlier save already wrote b.
  expect(instance.reload("s", true)).toEqual({
    changed: false,
  });
  expect(Object.fromEntries(instance.entries("s"))).toEqual({
    a: 10,
    b: 2,
    c: 3,
  });

  expect(instance.reset("s")).toEqual({
    changed: true,
  });
  expect(Object.fromEntries(instance.entries("s"))).toEqual(defaults);
  expect(instance.reset("s")).toEqual({
    changed: false,
  });
  // The file still holds the earlier save until the reset itself is saved.
  expect(readStored(root, "s")).toEqual({
    a: 10,
    b: 2,
    c: 3,
  });
  instance.save("s");
  expect(readStored(root, "s")).toEqual(defaults);

  expect(instance.clear("s")).toEqual({
    changed: true,
  });
  expect(instance.length("s")).toBe(0);
  expect(instance.clear("s")).toEqual({
    changed: false,
  });
  instance.save("s");
  expect(readStored(root, "s")).toEqual({});

  instance.load({
    name: "plain",
    ...manual,
  });
  instance.set("plain", "k", 1);
  expect(instance.reset("plain")).toEqual({
    changed: true,
  });
  expect(instance.length("plain")).toBe(0);
});

test("reload with ignoreDefaults drops default keys the file lacks", () => {
  const root = dataRoot();
  const instance = create(root);
  instance.load({
    name: "s",
    defaults: {
      d: 1,
    },
    ...manual,
  });
  instance.set("s", "k", 1);
  instance.save("s");
  expect(readStored(root, "s")).toEqual({
    d: 1,
    k: 1,
  });
  rmSync(storeFile(root, "s"));
  writeFileSync(
    storeFile(root, "s"),
    JSON.stringify({
      k: 2,
    }),
  );
  expect(instance.reload("s", true)).toEqual({
    changed: true,
  });
  expect(Object.fromEntries(instance.entries("s"))).toEqual({
    k: 2,
  });
  expect(instance.reload("s", false)).toEqual({
    changed: true,
  });
  expect(Object.fromEntries(instance.entries("s"))).toEqual({
    d: 1,
    k: 2,
  });
});

test("setting an equal value, deleting a missing key and reloading unchanged data report no change", () => {
  const root = dataRoot();
  const instance = create(root);
  instance.load({
    name: "s",
    autosave: 10,
  });
  instance.set("s", "k", {
    a: [
      1,
      2,
    ],
  });
  instance.save("s");
  const written = readFileSync(storeFile(root, "s"), "utf8");
  expect(
    instance.set("s", "k", {
      a: [
        1,
        2,
      ],
    }),
  ).toEqual({
    changed: false,
  });
  expect(instance.delete("s", "missing")).toEqual({
    changed: false,
  });
  expect(instance.delete("s", "k")).toEqual({
    changed: true,
  });
  expect(readFileSync(storeFile(root, "s"), "utf8")).toBe(written);
});

test("limits refuse a change and leave the contents as they were", () => {
  const instance = create(dataRoot());
  instance.load({
    name: "s",
    ...manual,
  });
  expect(
    errorCodeOf(() =>
      instance.set("s", "big", "x".repeat(MAX_STORE_VALUE_BYTES)),
    ),
  ).toBe("INVALID_ARGUMENT");
  // Each value fits alone, but the file cannot hold three of them.
  const nearLimit = "y".repeat(200_000);
  instance.set("s", "one", nearLimit);
  instance.set("s", "two", nearLimit);
  expect(errorCodeOf(() => instance.set("s", "three", nearLimit))).toBe(
    "INVALID_ARGUMENT",
  );
  expect(instance.keys("s")).toEqual([
    "one",
    "two",
  ]);
  expect(instance.get("s", "one")).toEqual({
    found: true,
    value: nearLimit,
  });

  instance.load({
    name: "many",
    ...manual,
  });
  for (let index = 0; index < MAX_STORE_KEYS; index++) {
    instance.set("many", `k${index}`, index);
  }
  expect(errorCodeOf(() => instance.set("many", "extra", 1))).toBe(
    "INVALID_ARGUMENT",
  );
  expect(instance.set("many", "k0", 5)).toEqual({
    changed: true,
  });
  expect(instance.length("many")).toBe(MAX_STORE_KEYS);
  expect(
    errorCodeOf(() =>
      instance.load({
        name: "d",
        defaults: {
          k: "x".repeat(600_000),
        },
      }),
    ),
  ).toBe("INVALID_ARGUMENT");
});

test("at most the allowed number of stores are open and a repeated load must match", () => {
  const instance = create(dataRoot());
  for (let index = 0; index < MAX_OPEN_STORES; index++) {
    instance.load({
      name: `s${index}`,
      ...manual,
    });
  }
  expect(
    errorCodeOf(() =>
      instance.load({
        name: "overflow",
        ...manual,
      }),
    ),
  ).toBe("BUSY");
  instance.set("s0", "k", 1);
  expect(
    instance.load({
      name: "s0",
      ...manual,
    }),
  ).toEqual({
    loaded: "new",
  });
  expect(instance.get("s0", "k")).toEqual({
    found: true,
    value: 1,
  });
  expect(
    errorCodeOf(() =>
      instance.load({
        name: "s0",
        defaults: {
          a: 1,
        },
        ...manual,
      }),
    ),
  ).toBe("INVALID_ARGUMENT");
  instance.close("s0");
  instance.load({
    name: "overflow",
    ...manual,
  });
});

test("autosave coalesces changes into one write and autosave false waits for save", async () => {
  const root = dataRoot();
  const renames: string[] = [];
  const instance = create(root, {
    rename(from, to) {
      renames.push(to);
      renameSyncFor(from, to);
    },
    sleep() {},
  });
  instance.load({
    name: "auto",
    autosave: 30,
  });
  for (let value = 0; value < 5; value++) {
    instance.set("auto", "k", value);
  }
  expect(existsSync(storeFile(root, "auto"))).toBe(false);
  await waitFor(
    () => (existsSync(storeFile(root, "auto")) ? true : undefined),
    {
      deadline: "inProcess",
      what: "autosave write",
    },
  );
  expect(readStored(root, "auto")).toEqual({
    k: 4,
  });
  expect(renames).toHaveLength(1);

  instance.load({
    name: "manual",
    ...manual,
  });
  instance.set("manual", "k", 1);
  await Bun.sleep(150);
  expect(existsSync(storeFile(root, "manual"))).toBe(false);
});

/** Real rename for the injected operations that only observe or fail selectively. */
function renameSyncFor(from: string, to: string): void {
  renameSync(from, to);
}

test("close saves unsaved changes and dispose saves every dirty store, then refuses later calls", () => {
  const root = dataRoot();
  const instance = create(root);
  instance.load({
    name: "a",
    autosave: 10_000,
  });
  instance.load({
    name: "b",
    autosave: 10_000,
  });
  instance.load({
    name: "c",
    ...manual,
  });
  instance.set("a", "k", 1);
  instance.set("b", "k", 2);
  instance.set("c", "k", 3);
  expect(instance.close("a")).toBeNull();
  expect(readStored(root, "a")).toEqual({
    k: 1,
  });
  expect(errorCodeOf(() => instance.get("a", "k"))).toBe("INVALID_ARGUMENT");
  instance.dispose();
  instance.dispose();
  expect(readStored(root, "b")).toEqual({
    k: 2,
  });
  expect(readStored(root, "c")).toEqual({
    k: 3,
  });
  expect(errorCodeOf(() => instance.get("b", "k"))).toBe("CANCELLED");
  expect(
    errorCodeOf(() =>
      instance.load({
        name: "b",
      }),
    ),
  ).toBe("CANCELLED");
});

test("a damaged file is reported without being overwritten, and reset replaces it on save", () => {
  const root = dataRoot();
  mkdirSync(join(root, "data", "stores"), {
    recursive: true,
  });
  const bad: Array<
    [
      string,
      Uint8Array | string,
    ]
  > = [
    [
      "notjson",
      "{ nope",
    ],
    [
      "array",
      "[1,2]",
    ],
    [
      "scalar",
      "7",
    ],
    [
      "badutf8",
      Buffer.from([
        0x7b,
        0xff,
        0xfe,
        0x7d,
      ]),
    ],
    [
      "toolarge",
      JSON.stringify({
        k: "x".repeat(600_000),
      }),
    ],
  ];
  for (const [name, content] of bad) {
    writeFileSync(storeFile(root, name), content);
    const instance = create(root);
    expect(
      errorCodeOf(() =>
        instance.load({
          name,
          ...manual,
        }),
      ),
    ).toBe("INVALID_ARGUMENT");
    expect(new Uint8Array(readFileSync(storeFile(root, name)))).toEqual(
      typeof content === "string"
        ? new TextEncoder().encode(content)
        : new Uint8Array(content),
    );
    expect(errorCodeOf(() => instance.get(name, "k"))).toBe("INVALID_ARGUMENT");
  }
  const instance = create(root);
  expect(
    instance.load({
      name: "notjson",
      defaults: {
        d: 1,
      },
      onInvalidFile: "reset",
      ...manual,
    }),
  ).toEqual({
    loaded: "reset",
  });
  expect(readFileSync(storeFile(root, "notjson"), "utf8")).toBe("{ nope");
  instance.save("notjson");
  expect(readStored(root, "notjson")).toEqual({
    d: 1,
  });
});

test("a failed rename is retried, then reported with the temporary file removed", () => {
  const root = dataRoot();
  const sleeps: number[] = [];
  let failures = 2;
  const flaky = create(root, {
    rename(from, to) {
      if (failures > 0) {
        failures--;
        throw Object.assign(new Error("busy"), {
          code: "EBUSY",
        });
      }
      renameSyncFor(from, to);
    },
    sleep: (milliseconds) => sleeps.push(milliseconds),
  });
  flaky.load({
    name: "s",
    ...manual,
  });
  flaky.set("s", "k", 1);
  flaky.save("s");
  expect(sleeps).toEqual([
    10,
    20,
  ]);
  expect(readStored(root, "s")).toEqual({
    k: 1,
  });

  sleeps.length = 0;
  const stuck = create(root, {
    rename() {
      throw Object.assign(new Error("denied"), {
        code: "EPERM",
      });
    },
    sleep: (milliseconds) => sleeps.push(milliseconds),
  });
  stuck.load({
    name: "t",
    ...manual,
  });
  stuck.set("t", "k", 1);
  expect(errorCodeOf(() => stuck.save("t"))).toBe("PERMISSION_DENIED");
  expect(sleeps).toEqual([
    10,
    20,
    40,
    80,
    160,
  ]);
  expect(
    readdirSync(join(root, "data", "stores")).filter((name) =>
      name.startsWith("t"),
    ),
  ).toEqual([]);

  const other = create(root, {
    rename() {
      throw Object.assign(new Error("gone"), {
        code: "ENOENT",
      });
    },
    sleep: (milliseconds) => sleeps.push(milliseconds),
  });
  other.load({
    name: "u",
    ...manual,
  });
  sleeps.length = 0;
  expect(errorCodeOf(() => other.save("u"))).toBe("ENOENT");
  expect(sleeps).toEqual([]);
});

test("a leftover temporary file does not stop the next save", () => {
  const root = dataRoot();
  mkdirSync(join(root, "data", "stores"), {
    recursive: true,
  });
  writeFileSync(`${storeFile(root, "s")}.tmp`, "stale");
  const instance = create(root);
  instance.load({
    name: "s",
    ...manual,
  });
  instance.set("s", "k", 1);
  instance.save("s");
  expect(readStored(root, "s")).toEqual({
    k: 1,
  });
  expect(readdirSync(join(root, "data", "stores"))).toEqual([
    "s.json",
  ]);
});

test("a failed shutdown save of one store does not skip the others", () => {
  const root = dataRoot();
  const instance = create(root, {
    rename(from, to) {
      if (to.endsWith("a.json")) {
        throw Object.assign(new Error("gone"), {
          code: "ENOENT",
        });
      }
      renameSyncFor(from, to);
    },
    sleep() {},
  });
  instance.load({
    name: "a",
    ...manual,
  });
  instance.load({
    name: "b",
    ...manual,
  });
  instance.set("a", "k", 1);
  instance.set("b", "k", 2);
  expect(() => instance.dispose()).toThrow(AggregateError);
  expect(existsSync(storeFile(root, "a"))).toBe(false);
  expect(readStored(root, "b")).toEqual({
    k: 2,
  });
});

/** Rename that fails with ENOENT while `state.failing` is set. */
function switchableRename(state: { failing: boolean }): StoreFileOperations {
  return {
    rename(from, to) {
      if (state.failing) {
        throw Object.assign(new Error("gone"), {
          code: "ENOENT",
        });
      }
      renameSyncFor(from, to);
    },
    sleep() {},
  };
}

test("a failed close keeps the store open and a later close saves it", () => {
  const root = dataRoot();
  const state = {
    failing: true,
  };
  const instance = create(root, switchableRename(state));
  instance.load({
    name: "s",
    ...manual,
  });
  instance.set("s", "k", 1);
  expect(errorCodeOf(() => instance.close("s"))).toBe("ENOENT");
  expect(instance.get("s", "k")).toEqual({
    found: true,
    value: 1,
  });
  state.failing = false;
  instance.close("s");
  expect(readStored(root, "s")).toEqual({
    k: 1,
  });
});

test("a failed autosave leaves the store dirty and the next change schedules another write", async () => {
  const root = dataRoot();
  const state = {
    failing: true,
  };
  const instance = create(root, switchableRename(state));
  instance.load({
    name: "s",
    autosave: 10,
  });
  instance.set("s", "k", 1);
  await Bun.sleep(80);
  expect(existsSync(storeFile(root, "s"))).toBe(false);
  state.failing = false;
  instance.set("s", "j", 2);
  await waitFor(() => (existsSync(storeFile(root, "s")) ? true : undefined), {
    deadline: "inProcess",
    what: "autosave retry",
  });
  expect(readStored(root, "s")).toEqual({
    k: 1,
    j: 2,
  });
});

test("reload follows the reset policy for a damaged file and reports it", () => {
  const root = dataRoot();
  const instance = create(root);
  const options = {
    name: "s",
    defaults: {
      d: 1,
    },
    onInvalidFile: "reset",
    ...manual,
  } as const;
  instance.load(options);
  instance.set("s", "k", 1);
  instance.save("s");
  writeFileSync(storeFile(root, "s"), "{ nope");
  expect(instance.reload("s", false)).toEqual({
    changed: true,
  });
  expect(Object.fromEntries(instance.entries("s"))).toEqual({
    d: 1,
  });
  expect(instance.load(options)).toEqual({
    loaded: "reset",
  });

  const strict = create(root);
  strict.load({
    name: "t",
    ...manual,
  });
  strict.save("t");
  writeFileSync(storeFile(root, "t"), "{ nope");
  expect(errorCodeOf(() => strict.reload("t", false))).toBe("INVALID_ARGUMENT");
});

test("defaults that push the file over a limit fail load, or start over with reset", () => {
  const root = dataRoot();
  const first = create(root);
  first.load({
    name: "s",
    ...manual,
  });
  for (let index = 0; index < MAX_STORE_KEYS - 1; index++) {
    first.set("s", `k${index}`, index);
  }
  first.save("s");
  first.close("s");
  const extra = Object.fromEntries(
    Array.from(
      {
        length: 30,
      },
      (_, index) => [
        `new${index}`,
        index,
      ],
    ),
  );
  const second = create(root);
  expect(
    errorCodeOf(() =>
      second.load({
        name: "s",
        defaults: extra,
        ...manual,
      }),
    ),
  ).toBe("INVALID_ARGUMENT");
  expect(
    second.load({
      name: "s",
      defaults: extra,
      onInvalidFile: "reset",
      ...manual,
    }),
  ).toEqual({
    loaded: "reset",
  });
  expect(second.length("s")).toBe(30);
});

test("a value beyond the value limit is refused from a file or from defaults like a set of it", () => {
  const root = dataRoot();
  mkdirSync(join(root, "data", "stores"), {
    recursive: true,
  });
  const oversized = "x".repeat(MAX_STORE_VALUE_BYTES + 1);
  writeFileSync(
    storeFile(root, "s"),
    JSON.stringify({
      k: oversized,
    }),
  );
  const instance = create(root);
  expect(
    errorCodeOf(() =>
      instance.load({
        name: "s",
        ...manual,
      }),
    ),
  ).toBe("INVALID_ARGUMENT");
  expect(
    errorCodeOf(() =>
      instance.load({
        name: "d",
        defaults: {
          k: oversized,
        },
        ...manual,
      }),
    ),
  ).toBe("INVALID_ARGUMENT");
});

test("a file the store may not read is reported as denied, not as damaged", () => {
  // An administrator bypasses file permissions, so there is nothing to refuse.
  if (process.getuid?.() === 0) {
    return;
  }
  const root = dataRoot();
  mkdirSync(join(root, "data", "stores"), {
    recursive: true,
  });
  writeFileSync(storeFile(root, "s"), "{}", {
    mode: 0o000,
  });
  const instance = create(root);
  expect(
    errorCodeOf(() =>
      instance.load({
        name: "s",
        onInvalidFile: "reset",
        ...manual,
      }),
    ),
  ).toBe("PERMISSION_DENIED");
});

test("close after dispose is cancelled and integer-like keys come back first", () => {
  const root = dataRoot();
  const instance = create(root);
  instance.load({
    name: "s",
    ...manual,
  });
  instance.set("s", "b", 1);
  instance.set("s", "1", 2);
  expect(instance.keys("s")).toEqual([
    "b",
    "1",
  ]);
  instance.save("s");
  instance.dispose();
  expect(errorCodeOf(() => instance.close("s"))).toBe("CANCELLED");
  const next = create(root);
  next.load({
    name: "s",
    ...manual,
  });
  expect(next.keys("s")).toEqual([
    "1",
    "b",
  ]);
});

test("a reset that was saved is what a new instance loads", () => {
  const root = dataRoot();
  const first = create(root);
  first.load({
    name: "s",
    defaults: {
      a: 1,
    },
    ...manual,
  });
  first.set("s", "a", 5);
  first.set("s", "extra", true);
  first.reset("s");
  first.save("s");
  first.dispose();
  const second = create(root);
  second.load({
    name: "s",
    ...manual,
  });
  expect(Object.fromEntries(second.entries("s"))).toEqual({
    a: 1,
  });
});
