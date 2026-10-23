import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { defineApp } from "@bunaway/backend";
import store from "@bunaway/plugin-store";
import windows from "@bunaway/plugin-windows";

// The host sets HOME to the app data root and TMPDIR to its temp directory.
const dataRoot = process.env.HOME;
const temporary = process.env.TMPDIR;
assert(dataRoot && temporary);
/** Longest wait for a debounced autosave to reach the disk. */
const AUTOSAVE_WAIT_MS = 5_000;
const storeDirectory = resolve(dataRoot, "data/stores");
const settingsPath = resolve(storeDirectory, "settings.json");
const defaults = {
  theme: "light",
  count: 1,
};
const PARTIAL_DEFAULTS = {
  a: 1,
  b: 2,
};
const nested = {
  list: [
    1,
    null,
    "한글🙂",
  ],
};

/** Plugin results arrive as null-prototype objects; compare them by content, not prototype. */
function same(actual: unknown, expected: unknown): void {
  assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected);
}

function readJson(name: string): unknown {
  return JSON.parse(
    readFileSync(resolve(storeDirectory, `${name}.json`), "utf8"),
  );
}

async function rejected(work: Promise<unknown>, code: string): Promise<void> {
  try {
    await work;
  } catch (error) {
    assert(error instanceof Error && "code" in error, String(error));
    assert.equal(error.code, code, error.message);
    return;
  }
  throw new Error(`Expected ${code}.`);
}

/** First run: every operation against the real macOS file system, ending with unsaved stores. */
async function firstRun(): Promise<void> {
  same(
    await store.load({
      name: "settings",
      defaults,
      autosave: false,
    }),
    {
      loaded: "new",
    },
  );
  assert.equal(existsSync(settingsPath), false);
  same(
    await store.set({
      name: "settings",
      key: "theme",
      value: "dark",
    }),
    {
      changed: true,
    },
  );
  same(
    await store.set({
      name: "settings",
      key: "theme",
      value: "dark",
    }),
    {
      changed: false,
    },
  );
  await store.set({
    name: "settings",
    key: "nested",
    value: nested,
  });
  // With autosave off nothing reaches the disk before `save`.
  assert.equal(existsSync(settingsPath), false);
  await store.save({
    name: "settings",
  });
  same(readJson("settings"), {
    theme: "dark",
    count: 1,
    nested,
  });
  assert.equal(statSync(settingsPath).mode & 0o777, 0o600);
  assert.equal(statSync(storeDirectory).mode & 0o777, 0o700);
  same(readdirSync(storeDirectory), [
    "settings.json",
  ]);

  // Reload drops unsaved changes and keeps the defaults for keys the file lacks.
  await store.set({
    name: "settings",
    key: "count",
    value: 5,
  });
  await store.set({
    name: "settings",
    key: "extra",
    value: true,
  });
  same(
    await store.reload({
      name: "settings",
    }),
    {
      changed: true,
    },
  );
  same(
    await store.get({
      name: "settings",
      key: "count",
    }),
    {
      found: true,
      value: 1,
    },
  );
  assert.equal(
    await store.has({
      name: "settings",
      key: "extra",
    }),
    false,
  );
  same(
    await store.keys({
      name: "settings",
    }),
    [
      "theme",
      "count",
      "nested",
    ],
  );

  // Reset returns to the defaults in memory only, so reload brings the saved file back.
  same(
    await store.reset({
      name: "settings",
    }),
    {
      changed: true,
    },
  );
  same(
    await store.entries({
      name: "settings",
    }),
    Object.entries(defaults),
  );
  same(readJson("settings"), {
    theme: "dark",
    count: 1,
    nested,
  });
  same(
    await store.reload({
      name: "settings",
    }),
    {
      changed: true,
    },
  );
  same(
    await store.get({
      name: "settings",
      key: "theme",
    }),
    {
      found: true,
      value: "dark",
    },
  );

  // A save that cannot create its temporary file keeps the original and the unsaved change.
  await store.set({
    name: "settings",
    key: "theme",
    value: "unsaved",
  });
  const original = readFileSync(settingsPath, "utf8");
  chmodSync(storeDirectory, 0o500);
  try {
    await rejected(
      store.save({
        name: "settings",
      }),
      "PERMISSION_DENIED",
    );
  } finally {
    chmodSync(storeDirectory, 0o700);
  }
  assert.equal(readFileSync(settingsPath, "utf8"), original);
  same(readdirSync(storeDirectory), [
    "settings.json",
  ]);
  same(
    await store.get({
      name: "settings",
      key: "theme",
    }),
    {
      found: true,
      value: "unsaved",
    },
  );
  await store.set({
    name: "settings",
    key: "theme",
    value: "dark",
  });
  await store.save({
    name: "settings",
  });
  same(readJson("settings"), {
    theme: "dark",
    count: 1,
    nested,
  });

  // A file that lacks a default key: a plain reload fills it, `ignoreDefaults` keeps only the file.
  writeFileSync(resolve(storeDirectory, "partial.json"), '{"a":10}');
  await store.load({
    name: "partial",
    defaults: PARTIAL_DEFAULTS,
    autosave: false,
  });
  same(
    await store.entries({
      name: "partial",
    }),
    [
      [
        "a",
        10,
      ],
      [
        "b",
        2,
      ],
    ],
  );
  same(
    await store.reload({
      name: "partial",
      ignoreDefaults: true,
    }),
    {
      changed: true,
    },
  );
  same(
    await store.keys({
      name: "partial",
    }),
    [
      "a",
    ],
  );
  same(
    await store.reload({
      name: "partial",
    }),
    {
      changed: true,
    },
  );
  assert.equal(
    await store.has({
      name: "partial",
      key: "b",
    }),
    true,
  );
  await store.close({
    name: "partial",
  });
  same(readJson("partial"), {
    a: 10,
  });

  // A damaged file is reported unless the caller asks for a reset.
  writeFileSync(resolve(storeDirectory, "broken.json"), "{ not json");
  await rejected(
    store.load({
      name: "broken",
    }),
    "INVALID_ARGUMENT",
  );
  same(
    await store.load({
      name: "broken",
      defaults: {
        fresh: true,
      },
      onInvalidFile: "reset",
      autosave: false,
    }),
    {
      loaded: "reset",
    },
  );
  await store.close({
    name: "broken",
  });
  same(readJson("broken"), {
    fresh: true,
  });

  // Autosave writes after its debounce without a `save` call.
  await store.load({
    name: "auto",
    autosave: 20,
  });
  await store.set({
    name: "auto",
    key: "saved",
    value: 1,
  });
  const deadline = Date.now() + AUTOSAVE_WAIT_MS;
  while (!existsSync(resolve(storeDirectory, "auto.json"))) {
    assert(Date.now() < deadline, "Autosave did not write.");
    await Bun.sleep(10);
  }
  same(readJson("auto"), {
    saved: 1,
  });

  // This store is still unsaved and open at shutdown; the host's cleanup must flush it.
  await store.load({
    name: "pending",
    autosave: false,
  });
  await store.set({
    name: "pending",
    key: "flushed",
    value: "at shutdown",
  });
  assert.equal(existsSync(resolve(storeDirectory, "pending.json")), false);
}

/** Second run: the same executable sees what the first run saved. */
async function secondRun(): Promise<void> {
  same(
    await store.load({
      name: "settings",
      defaults,
      autosave: false,
    }),
    {
      loaded: "file",
    },
  );
  same(
    await store.entries({
      name: "settings",
    }),
    [
      [
        "theme",
        "dark",
      ],
      [
        "count",
        1,
      ],
      [
        "nested",
        nested,
      ],
    ],
  );
  same(readJson("pending"), {
    flushed: "at shutdown",
  });
  same(readJson("auto"), {
    saved: 1,
  });
  same(readJson("broken"), {
    fresh: true,
  });
  // Defaults gained a key since the file was written: it is filled in and the file value wins.
  await store.load({
    name: "partial",
    defaults: {
      ...PARTIAL_DEFAULTS,
      c: 3,
    },
    autosave: false,
  });
  same(
    await store.entries({
      name: "partial",
    }),
    [
      [
        "a",
        10,
      ],
      [
        "b",
        2,
      ],
      [
        "c",
        3,
      ],
    ],
  );
  same(readdirSync(storeDirectory).sort(), [
    "auto.json",
    "broken.json",
    "partial.json",
    "pending.json",
    "settings.json",
  ]);
}

export default defineApp({
  modules: [],
  plugins: [
    store,
    windows,
    {
      name: "store-scenarios",
      version: "1",
      async setup() {
        const restarted = existsSync(settingsPath);
        await (restarted ? secondRun() : firstRun());
        writeFileSync(
          resolve(temporary, "backend-report.json"),
          JSON.stringify({
            restarted,
          }),
        );
        return () => writeFileSync(resolve(temporary, "core-cleaned"), "done");
      },
    },
  ],
  commands: {
    "test.report": {
      input: {
        enum: [
          "passed",
          "failed",
        ],
      },
      output: {
        const: null,
      },
      async run(payload: unknown) {
        assert(payload === "passed" || payload === "failed");
        writeFileSync(resolve(temporary, "web-report"), payload);
        return null;
      },
    },
  },
});
