import { expect, test } from "bun:test";
import { validateOpenerInput } from "#plugins/opener/src/contract";
import {
  macosOperations,
  windowsOperations,
} from "#plugins/opener/src/operations";
import {
  buildSchemeCommand,
  createUrlSchemeRegistration,
  MAX_SCHEME_COMMAND_UNITS,
  OWNER_VALUE,
  WRITTEN_COMMAND_VALUE,
  type SchemeStore,
} from "#plugins/opener/src/platforms/windows-url-scheme";
import { normalizeUrlScheme } from "#plugins/opener/src/url-scheme";

const APP = {
  id: "com.example.app",
  launch: {
    mode: "packaged" as const,
    executablePath: "C:\\Program Files\\App\\app.exe",
    args: [] as string[],
  },
};

/** In-memory classes hive: key path to its values; `""` is the default value. */
function fakeStore() {
  const keys = new Map<string, Map<string, string>>();
  const calls: string[] = [];
  /** Names that exist in the merged classes view but not under HKCU, such as HKLM entries. */
  const machineClasses = new Set<string>();
  let failWriteAfter = Number.POSITIVE_INFINITY;
  let writes = 0;
  const store: SchemeStore = {
    withLock: (_scheme, work) => work(),
    classExists: (name) =>
      machineClasses.has(name) || keys.has(`Software\\Classes\\${name}`),
    keyExists: (path) =>
      [
        ...keys.keys(),
      ].some((key) => key === path || key.startsWith(`${path}\\`)),
    readString: (path, name) => keys.get(path)?.get(name) ?? null,
    writeString(path, name, value) {
      if (writes++ >= failWriteAfter) {
        throw new Error("write failed");
      }
      const values = keys.get(path) ?? new Map<string, string>();
      values.set(name, value);
      keys.set(path, values);
    },
    deleteTree(path) {
      for (const key of [
        ...keys.keys(),
      ]) {
        if (key === path || key.startsWith(`${path}\\`)) {
          keys.delete(key);
        }
      }
    },
    notifyAssociationsChanged: () => {
      calls.push("notify");
    },
  };
  return {
    store,
    keys,
    calls,
    machineClasses,
    failAfter(count: number) {
      writes = 0;
      failWriteAfter = count;
    },
  };
}

test("scheme input is lowercased and reserved or malformed schemes are rejected", () => {
  expect(normalizeUrlScheme("MyApp")).toBe("myapp");
  expect(normalizeUrlScheme("my-app+v2.x")).toBe("my-app+v2.x");
  for (const scheme of [
    "",
    "a",
    "1app",
    "my app",
    "my_app",
    "x".repeat(33),
    "http",
    "HTTPS",
    "file",
    "javascript",
    "mailto",
    "ms-settings",
    "Microsoft-Edge",
    "search-ms",
    "shell",
    5,
    null,
  ]) {
    expect(() => normalizeUrlScheme(scheme)).toThrow(
      expect.objectContaining({
        code: "INVALID_ARGUMENT",
      }),
    );
    expect(() =>
      validateOpenerInput("opener.registerUrlScheme", {
        scheme,
      }),
    ).toThrow(
      expect.objectContaining({
        code: "INVALID_ARGUMENT",
      }),
    );
  }
});

test("the three operations share one strict scheme input and typed results", () => {
  for (const operation of [
    "opener.registerUrlScheme",
    "opener.unregisterUrlScheme",
    "opener.isUrlSchemeRegistered",
  ]) {
    expect(
      validateOpenerInput(operation, {
        scheme: "myapp",
      }),
    ).toEqual({
      scheme: "myapp",
    });
    for (const input of [
      {},
      {
        scheme: "myapp",
        path: "C:\\other.exe",
      },
      {
        scheme: "myapp",
        args: [],
      },
    ]) {
      expect(() => validateOpenerInput(operation, input)).toThrow(
        expect.objectContaining({
          code: "INVALID_ARGUMENT",
        }),
      );
    }
  }
  expect(windowsOperations.registerUrlScheme.output.parse(null)).toBeNull();
  expect(windowsOperations.unregisterUrlScheme.output.parse(true)).toBe(true);
  expect(windowsOperations.isUrlSchemeRegistered.output.parse(false)).toBe(
    false,
  );
  expect(() =>
    windowsOperations.registerUrlScheme.output.parse(true),
  ).toThrow();
});

test("the operations are Windows only", () => {
  expect(Object.keys(windowsOperations)).toEqual(
    expect.arrayContaining([
      "registerUrlScheme",
      "unregisterUrlScheme",
      "isUrlSchemeRegistered",
    ]),
  );
  expect(Object.keys(macosOperations)).not.toContain("registerUrlScheme");
  expect(Object.keys(macosOperations)).not.toContain("unregisterUrlScheme");
  expect(Object.keys(macosOperations)).not.toContain("isUrlSchemeRegistered");
});

test("the command quotes the app launch parts and ends with the URL placeholder", () => {
  expect(buildSchemeCommand(APP.launch)).toBe(
    '"C:\\Program Files\\App\\app.exe" "%1"',
  );
  expect(
    buildSchemeCommand({
      mode: "development",
      executablePath: "C:\\bun\\bun.exe",
      args: [
        "run",
        "C:\\my app\\main.ts",
      ],
    }),
  ).toBe('"C:\\bun\\bun.exe" "run" "C:\\my app\\main.ts" "%1"');
});

test("a launch command with placeholders, control characters or excess length is refused", () => {
  for (const launch of [
    {
      ...APP.launch,
      executablePath: "C:\\100%\\app.exe",
    },
    {
      ...APP.launch,
      args: [
        "--x=%1",
      ],
    },
    {
      ...APP.launch,
      args: [
        "a\nb",
      ],
    },
    {
      ...APP.launch,
      args: [
        "x".repeat(MAX_SCHEME_COMMAND_UNITS),
      ],
    },
  ]) {
    expect(() => buildSchemeCommand(launch)).toThrow(
      expect.objectContaining({
        code: "UNSUPPORTED",
      }),
    );
  }
});

test("without a host app identity all three operations report UNSUPPORTED", () => {
  const { store } = fakeStore();
  const registration = createUrlSchemeRegistration(undefined, store);
  for (const call of [
    () => registration.register("myapp"),
    () => registration.unregister("myapp"),
    () => registration.isRegistered("myapp"),
  ]) {
    expect(call).toThrow(
      expect.objectContaining({
        code: "UNSUPPORTED",
      }),
    );
  }
});

test("register writes the owner, the command and the protocol marker, then reads back", () => {
  const { store, keys, calls } = fakeStore();
  const registration = createUrlSchemeRegistration(APP, store);
  expect(registration.isRegistered("myapp")).toBe(false);
  expect(registration.register("myapp")).toBeNull();
  expect(registration.isRegistered("myapp")).toBe(true);
  expect(keys.get("Software\\Classes\\myapp")).toEqual(
    new Map([
      [
        OWNER_VALUE,
        "packaged.com.example.app",
      ],
      [
        "",
        "URL:myapp",
      ],
      [
        WRITTEN_COMMAND_VALUE,
        '"C:\\Program Files\\App\\app.exe" "%1"',
      ],
      [
        "URL Protocol",
        "",
      ],
    ]),
  );
  expect(
    keys.get("Software\\Classes\\myapp\\shell\\open\\command")?.get(""),
  ).toBe('"C:\\Program Files\\App\\app.exe" "%1"');
  expect(calls).toEqual([
    "notify",
  ]);
  // A repeat with the same command changes nothing, not even the Shell notification.
  registration.register("myapp");
  expect(calls).toEqual([
    "notify",
  ]);
});

test("register refreshes the command after the app moved and unregister then removes it", () => {
  const { store, keys } = fakeStore();
  createUrlSchemeRegistration(APP, store).register("myapp");
  const moved = createUrlSchemeRegistration(
    {
      ...APP,
      launch: {
        ...APP.launch,
        executablePath: "D:\\Apps\\app.exe",
      },
    },
    store,
  );
  // The old command no longer matches, so the app does not count as registered yet.
  expect(moved.isRegistered("myapp")).toBe(false);
  moved.register("myapp");
  expect(moved.isRegistered("myapp")).toBe(true);
  expect(moved.unregister("myapp")).toBe(true);
  expect(keys.size).toBe(0);
  expect(moved.unregister("myapp")).toBe(false);
});

test("a key owned by anyone else is neither replaced nor removed", () => {
  const { store, keys } = fakeStore();
  const installed = new Map([
    [
      "",
      "URL:myapp",
    ],
    [
      "URL Protocol",
      "",
    ],
  ]);
  keys.set("Software\\Classes\\myapp", installed);
  keys.set(
    "Software\\Classes\\myapp\\shell\\open\\command",
    new Map([
      [
        "",
        '"C:\\Other\\other.exe" "%1"',
      ],
    ]),
  );
  const registration = createUrlSchemeRegistration(APP, store);
  expect(() => registration.register("myapp")).toThrow(
    expect.objectContaining({
      code: "INVALID_ARGUMENT",
    }),
  );
  expect(registration.isRegistered("myapp")).toBe(false);
  expect(registration.unregister("myapp")).toBe(false);
  // The packaged and development runs of one app id are different owners.
  const development = createUrlSchemeRegistration(
    {
      ...APP,
      launch: {
        ...APP.launch,
        mode: "development",
      },
    },
    store,
  );
  expect(() => development.register("myapp")).toThrow(
    expect.objectContaining({
      code: "INVALID_ARGUMENT",
    }),
  );
  expect(keys.get("Software\\Classes\\myapp")).toBe(installed);
  expect(
    keys.get("Software\\Classes\\myapp\\shell\\open\\command")?.get(""),
  ).toBe('"C:\\Other\\other.exe" "%1"');
});

test("a stale command stays removable by its owner, a command rewritten by another program does not", () => {
  const { store, keys } = fakeStore();
  const registration = createUrlSchemeRegistration(APP, store);
  registration.register("myapp");
  const moved = createUrlSchemeRegistration(
    {
      ...APP,
      launch: {
        ...APP.launch,
        executablePath: "D:\\Apps\\app.exe",
      },
    },
    store,
  );
  // The app moved: the stored command is stale but still the one this plugin wrote.
  expect(moved.isRegistered("myapp")).toBe(false);
  expect(moved.unregister("myapp")).toBe(true);
  expect(keys.has("Software\\Classes\\myapp")).toBe(false);

  registration.register("myapp");
  keys
    .get("Software\\Classes\\myapp\\shell\\open\\command")
    ?.set("", '"C:\\Other\\other.exe" "%1"');
  // Another program took the key over and left the owner value behind.
  expect(registration.isRegistered("myapp")).toBe(false);
  expect(() => registration.register("myapp")).toThrow(
    expect.objectContaining({
      code: "INVALID_ARGUMENT",
    }),
  );
  expect(registration.unregister("myapp")).toBe(false);
  expect(
    keys.get("Software\\Classes\\myapp\\shell\\open\\command")?.get(""),
  ).toBe('"C:\\Other\\other.exe" "%1"');
});

test("a failed first registration removes the key it created and a retry succeeds", () => {
  const harness = fakeStore();
  const registration = createUrlSchemeRegistration(APP, harness.store);
  for (const failAt of [
    0,
    1,
    2,
    3,
    4,
  ]) {
    harness.failAfter(failAt);
    expect(() => registration.register("myapp")).toThrow("write failed");
    expect(harness.keys.size).toBe(0);
    expect(registration.isRegistered("myapp")).toBe(false);
  }
  harness.failAfter(Number.POSITIVE_INFINITY);
  registration.register("myapp");
  expect(registration.isRegistered("myapp")).toBe(true);
});

test("a failed refresh keeps the key the app already owned", () => {
  const harness = fakeStore();
  createUrlSchemeRegistration(APP, harness.store).register("myapp");
  const moved = createUrlSchemeRegistration(
    {
      ...APP,
      launch: {
        ...APP.launch,
        executablePath: "D:\\Apps\\app.exe",
      },
    },
    harness.store,
  );
  harness.failAfter(3);
  expect(() => moved.register("myapp")).toThrow("write failed");
  expect(harness.keys.has("Software\\Classes\\myapp")).toBe(true);
  harness.failAfter(Number.POSITIVE_INFINITY);
  moved.register("myapp");
  expect(moved.isRegistered("myapp")).toBe(true);
});

test("a name that exists only in the machine or system classes is not taken over", () => {
  const harness = fakeStore();
  harness.machineClasses.add("exefile");
  const registration = createUrlSchemeRegistration(APP, harness.store);
  expect(() => registration.register("exefile")).toThrow(
    expect.objectContaining({
      code: "INVALID_ARGUMENT",
    }),
  );
  expect(harness.keys.size).toBe(0);
  expect(registration.isRegistered("exefile")).toBe(false);
});

test("Microsoft dotted names are reserved like the hyphenated families", () => {
  expect(() => normalizeUrlScheme("Microsoft.PowerShellScript.1")).toThrow(
    expect.objectContaining({
      code: "INVALID_ARGUMENT",
    }),
  );
});

test("a failed rollback reports both the write failure and the cleanup failure", () => {
  const harness = fakeStore();
  const store: SchemeStore = {
    ...harness.store,
    deleteTree() {
      throw new Error("delete failed");
    },
  };
  harness.failAfter(1);
  let caught: unknown;
  try {
    createUrlSchemeRegistration(APP, store).register("myapp");
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AggregateError);
  expect((caught as AggregateError).errors.map(String)).toEqual([
    "Error: write failed",
    "Error: delete failed",
  ]);
});

test("an interrupted refresh is finished by the retry and the key stays removable after another move", () => {
  const harness = fakeStore();
  createUrlSchemeRegistration(APP, harness.store).register("myapp");
  const moveTo = (executablePath: string) =>
    createUrlSchemeRegistration(
      {
        ...APP,
        launch: {
          ...APP.launch,
          executablePath,
        },
      },
      harness.store,
    );
  const second = moveTo("D:\\Apps\\app.exe");
  // Owner, default and command are written; recording the command fails.
  harness.failAfter(3);
  expect(() => second.register("myapp")).toThrow("write failed");
  // The command is already current, but the registration is not complete.
  expect(second.isRegistered("myapp")).toBe(false);
  harness.failAfter(Number.POSITIVE_INFINITY);
  second.register("myapp");
  expect(second.isRegistered("myapp")).toBe(true);
  expect(
    harness.keys.get("Software\\Classes\\myapp")?.get(WRITTEN_COMMAND_VALUE),
  ).toBe('"D:\\Apps\\app.exe" "%1"');
  expect(moveTo("E:\\Apps\\app.exe").unregister("myapp")).toBe(true);
});

test("a key with only this app's owner value is finished or removed by the app", () => {
  const harness = fakeStore();
  harness.keys.set(
    "Software\\Classes\\myapp",
    new Map([
      [
        OWNER_VALUE,
        "packaged.com.example.app",
      ],
    ]),
  );
  const registration = createUrlSchemeRegistration(APP, harness.store);
  expect(registration.unregister("myapp")).toBe(true);
  harness.keys.set(
    "Software\\Classes\\myapp",
    new Map([
      [
        OWNER_VALUE,
        "packaged.com.example.app",
      ],
    ]),
  );
  registration.register("myapp");
  expect(registration.isRegistered("myapp")).toBe(true);
});
