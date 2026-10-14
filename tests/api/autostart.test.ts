import { expect, test } from "bun:test";
import type { CommandContext } from "@bunaway/plugin-api";
import { bindCommandHost } from "@bunaway/plugin-api/host";
import autostart from "@bunaway/plugin-autostart";
import {
  AUTOSTART_ARGUMENT,
  AUTOSTART_HIDDEN_ARGUMENT,
  type HostContext,
  NativeRegistry,
} from "@bunaway/protocol";
import { bindHostAPI } from "#core/host-api";
import { operations } from "#native/host-api/bun/plugins";
import type { AppLaunch } from "#plugins/autostart/src/contract";
import { autostartOperations } from "#plugins/autostart/src/operations";
import {
  commandLine,
  registrationName,
} from "#plugins/autostart/src/platforms/windows-launch";
import {
  registryCommand,
  startupState,
} from "#plugins/autostart/src/platforms/windows-registry";
import { pluginParsers } from "../fixtures/plugin-parsers.ts";

const parsers = pluginParsers("autostart", autostartOperations);
const registry = new NativeRegistry([
  autostart._definition,
]);
const app: AppLaunch = {
  id: "com.example.app",
  launch: {
    mode: "packaged",
    executablePath: "C:\\App Folder\\한글.exe",
    args: [],
  },
};
test("autostart exposes strict app-scoped read and configure contracts", async () => {
  expect([
    ...registry.operations.keys(),
  ]).toEqual([
    "autostart.enable",
    "autostart.disable",
    "autostart.getStatus",
  ]);
  for (const payload of [
    {
      args: [],
      executablePath: "C:\\other.exe",
    },
    {
      args: [
        42,
      ],
    },
    {
      args: Array(65).fill(""),
    },
    {
      args: [],
      hidden: "yes",
    },
    {
      args: [
        "x".repeat(261),
      ],
    },
  ]) {
    await expect(
      parsers.validateCall({
        operation: "autostart.enable",
        payload,
      }),
    ).rejects.toThrow();
  }
  await expect(
    parsers.validateCall({
      operation: "autostart.getStatus",
      payload: {},
    }),
  ).rejects.toThrow();
  for (const permission of [
    "autostart.enable",
    "autostart.disable",
    "autostart.getStatus",
  ]) {
    const policy = {
      permissions: [
        permission,
      ],
    };
    expect(
      registry.allowed(policy, {
        operation: "autostart.getStatus",
        payload: null,
      }),
    ).toBe(permission === "autostart.getStatus");
    expect(
      registry.allowed(policy, {
        operation: "autostart.disable",
        payload: null,
      }),
    ).toBe(permission === "autostart.disable");
  }
});
test("development and packaged registration identities cannot collide", () => {
  expect(registrationName(app)).toBe("bunaway.packaged.com.example.app");
  expect(
    registrationName({
      ...app,
      launch: {
        ...app.launch,
        mode: "development",
      },
    }),
  ).toBe("bunaway.development.com.example.app");
  expect(
    registrationName({
      ...app,
      id: "com.example.app.development",
    }),
  ).not.toBe(
    registrationName({
      ...app,
      launch: {
        ...app.launch,
        mode: "development",
      },
    }),
  );
  for (const id of [
    "",
    "UPPER",
    "../app",
    "a".repeat(65),
  ]) {
    expect(() =>
      registrationName({
        ...app,
        id,
      }),
    ).toThrow();
  }
});
test("Run commands preserve argument boundaries and enforce the complete UTF-16 limit", () => {
  expect(
    commandLine(app, [
      "",
      "공백 값",
      'a"b',
      "끝\\",
      "& %PATH%",
    ]),
  ).toBe(
    '"C:\\App Folder\\한글.exe" "--bunaway-autostart" "" "공백 값" "a\\"b" "끝\\\\" "& %PATH%"',
  );
  const prefix = commandLine(app, []).length;
  expect(
    commandLine(app, [
      "x".repeat(260 - prefix - 3),
    ]),
  ).toHaveLength(260);
  for (const args of [
    [
      "x".repeat(261 - prefix - 3),
    ],
    [
      "\0",
    ],
    [
      "\ud800",
    ],
    [
      "😀".repeat(130),
    ],
  ]) {
    expect(() => commandLine(app, args)).toThrow();
  }
  expect(() =>
    commandLine(
      {
        ...app,
        launch: {
          ...app.launch,
          executablePath: "relative.exe",
        },
      },
      [],
    ),
  ).toThrow();
  const dev = {
    ...app,
    launch: {
      ...app.launch,
      mode: "development" as const,
      args: [
        "--no-env-file",
        "C:\\app\\assets\\boot.js",
      ],
    },
  };
  expect(
    commandLine(dev, [
      "--login",
    ]),
  ).toContain(
    '"--no-env-file" "C:\\app\\assets\\boot.js" "--bunaway-autostart" "--login"',
  );
  expect(() =>
    commandLine(dev, [
      "--dev-url",
      "https://example.com",
    ]),
  ).toThrow();
});
test("hidden registration requires a trusted tray and counts the marker in the Run limit", () => {
  expect(() => commandLine(app, [], true)).toThrow("desktop.tray");
  const hiddenApp = {
    ...app,
    supportsHiddenStart: true,
  };
  expect(commandLine(hiddenApp, [], true)).toContain(
    `"${AUTOSTART_HIDDEN_ARGUMENT}"`,
  );
  expect(
    commandLine(hiddenApp, [
      AUTOSTART_HIDDEN_ARGUMENT,
    ]),
  ).toContain(`"${AUTOSTART_ARGUMENT}" "${AUTOSTART_HIDDEN_ARGUMENT}"`);
  const prefix = commandLine(hiddenApp, [], true).length;
  expect(
    commandLine(
      hiddenApp,
      [
        "x".repeat(260 - prefix - 3),
      ],
      true,
    ),
  ).toHaveLength(260);
  expect(() =>
    commandLine(
      hiddenApp,
      [
        "x".repeat(261 - prefix - 3),
      ],
      true,
    ),
  ).toThrow("260");
});

test("public helper accepts registration settings and preserves native failures", async () => {
  const { createAutostart } = await import("#plugins/autostart/src/calls");
  const captured: unknown[] = [];
  const options = undefined;
  const calls = createAutostart({
    async enable(input, transport) {
      captured.push([
        input,
        transport,
      ]);
      throw new Error("native failure");
    },
    async disable() {
      return null;
    },
    async getStatus() {
      throw new Error("unused");
    },
  });
  for (const settings of [
    [],
    {
      hidden: true,
    },
    {
      args: [
        "hello",
      ],
      hidden: false,
    },
  ] satisfies (
    | string[]
    | import("@bunaway/plugin-autostart").AutostartOptions
  )[]) {
    await expect(calls.enableAutostart(settings, options)).rejects.toThrow(
      "native failure",
    );
  }
  expect(captured).toEqual([
    [
      {
        args: [],
      },
      options,
    ],
    [
      {
        args: [],
        hidden: true,
      },
      options,
    ],
    [
      {
        args: [
          "hello",
        ],
        hidden: false,
      },
      options,
    ],
  ]);
});

test("absent, malformed and unknown approval states never claim to be enabled", () => {
  expect(startupState(null)).toBe("unknown");
  for (const [state, expected] of [
    [
      0,
      "enabled",
    ],
    [
      1,
      "disabled",
    ],
    [
      2,
      "enabled",
    ],
    [
      3,
      "disabled",
    ],
    [
      6,
      "unknown",
    ],
    [
      7,
      "unknown",
    ],
    [
      99,
      "unknown",
    ],
  ] as const) {
    const data = Buffer.alloc(12);
    data.writeUInt32LE(state);
    expect(
      startupState({
        type: 3,
        data,
      }),
    ).toBe(expected);
    expect(
      startupState({
        type: 1,
        data,
      }),
    ).toBe("unknown");
    expect(
      startupState({
        type: 3,
        data: data.subarray(0, 4),
      }),
    ).toBe("unknown");
  }
  expect(
    startupState({
      type: 3,
      data: Buffer.from("0100000070bc7590b058dd01", "hex"),
    }),
  ).toBe("disabled");
  expect(
    registryCommand({
      type: 1,
      data: Buffer.from('"C:\\app.exe"\0', "utf16le"),
    }),
  ).toBe('"C:\\app.exe"');
  for (const value of [
    null,
    {
      type: 2,
      data: Buffer.from("x\0", "utf16le"),
    },
    {
      type: 1,
      data: Buffer.from("x", "utf16le"),
    },
    {
      type: 1,
      data: Buffer.from("x\0y\0", "utf16le"),
    },
  ]) {
    expect(registryCommand(value)).toBeNull();
  }
});
test("public helpers use caller context and preserve native errors", async () => {
  const calls: string[] = [];
  const controller = new AbortController();
  const host = bindHostAPI(
    "backend" as HostContext,
    controller.signal,
    async (_context, call) => {
      calls.push(call.operation);
      return call.operation === "autostart.disable"
        ? {
            kind: "result",
            payload: null,
          }
        : {
            kind: "error",
            error: {
              code: "PERMISSION_DENIED",
              message: "Denied",
            },
          };
    },
    registry,
  );
  const command = bindCommandHost({
    input: {
      const: null,
    },
    output: {
      const: null,
    },
    run: async (_input: unknown, _context: CommandContext) => {
      await autostart.disableAutostart();
      await expect(
        autostart.enableAutostart([
          "--login",
        ]),
      ).rejects.toMatchObject({
        code: "PERMISSION_DENIED",
      });
      await expect(autostart.getAutostartStatus()).rejects.toMatchObject({
        code: "PERMISSION_DENIED",
      });
      return null;
    },
  });
  await command.run(null, {
    host,
    signal: controller.signal,
    state: {
      get: () => undefined,
      set() {},
      delete: () => false,
    },
    events: {
      async emit() {},
    },
  });
  expect(calls).toEqual([
    "autostart.disable",
    "autostart.enable",
    "autostart.getStatus",
  ]);
});
test("host supplies trusted app metadata only to a registered adapter", async () => {
  let observed: unknown;
  const catalog = [
    {
      ...autostart._definition,
      thread: "worker" as const,
      operations: async () => ({
        createOperations: (
          environment: import("@bunaway/plugin").NativeEnvironment,
        ) => {
          observed = environment.app;
          return {
            execute: () => null,
            dispose() {},
          };
        },
      }),
    },
  ];
  const unregistered = await operations(
    [],
    ".",
    "worker",
    undefined,
    catalog,
    app,
  );
  expect(observed).toBeUndefined();
  await unregistered.dispose();
  const registered = await operations(
    [
      autostart._definition,
    ],
    ".",
    "worker",
    undefined,
    catalog,
    app,
  );
  expect(observed).toEqual(app);
  await registered.dispose();
});
test("MSIX package identity is unsupported and native DLL disposal is idempotent", () => {
  const registryModule = new URL(
    "../../plugins/autostart/src/platforms/windows-registry.ts",
    import.meta.url,
  ).href;
  const child = Bun.spawnSync([
    process.execPath,
    "-e",
    `
import assert from "node:assert/strict";
import { mock } from "bun:test";
const ffi = await import("bun:ffi");
let packageResult = 15700;
const closed = [];
mock.module("bun:ffi", () => ({ ...ffi, dlopen: (name) => ({
  symbols: { GetCurrentPackageFullName: () => packageResult },
  close: () => closed.push(name),
}) }));
const { createRegistry } = await import(${JSON.stringify(registryModule)});
const registry = createRegistry();
registry.unpackaged();
packageResult = 122; // GetCurrentPackageFullName's real size-query result for a packaged process.
assert.throws(() => registry.unpackaged(), { code: "UNSUPPORTED" });
packageResult = 5;
assert.throws(() => registry.unpackaged(), { code: "PERMISSION_DENIED" });
registry.dispose();
registry.dispose();
assert.equal(closed.length, 3);
assert.throws(() => registry.unpackaged(), { code: "CANCELLED" });
`,
  ]);
  expect(child.exitCode, child.stderr.toString()).toBe(0);
});
