import { expect, test } from "bun:test";
import { bindHostAPI } from "#core/host-api";
import { bindCommandHost } from "@bunaway/plugin-api/host";
import type { CommandContext } from "@bunaway/plugin-api";
import { s } from "@bunaway/plugin";
import { type HostContext, NativeRegistry } from "@bunaway/protocol";
import {
  autostartPlugin,
  disableAutostart,
  enableAutostart,
  getAutostartStatus,
} from "@bunaway/plugin-autostart";
import {
  commandLine,
  type AppLaunch,
  registrationName,
} from "#plugins/autostart/src/launch";
import { registryCommand, startupState } from "#plugins/autostart/src/registry";
import { operations } from "#native/host-api/bun/plugins";

const registry = new NativeRegistry([
  autostartPlugin,
]);
const app: AppLaunch = {
  id: "com.example.app",
  launch: {
    mode: "packaged",
    executablePath: "C:\\App Folder\\한글.exe",
    args: [],
  },
};

test("autostart exposes strict app-scoped read and configure contracts", () => {
  expect([
    ...registry.permissions.keys(),
  ]).toEqual([
    "autostart:configure",
    "autostart:read",
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
      args: [
        "x".repeat(261),
      ],
    },
  ]) {
    expect(() =>
      registry.validateCall({
        operation: "autostart.enable",
        payload,
      }),
    ).toThrow();
  }
  expect(() =>
    registry.validateCall({
      operation: "autostart.getStatus",
      payload: {},
    }),
  ).toThrow();
  for (const permission of [
    "autostart:read",
    "autostart:configure",
  ]) {
    const policy = {
      permissions: [
        permission,
      ],
    };
    expect(
      registry.allowed(
        policy,
        {
          operation: "autostart.getStatus",
          payload: null,
        },
        () => false,
      ),
    ).toBe(permission === "autostart:read");
    expect(
      registry.allowed(
        policy,
        {
          operation: "autostart.disable",
          payload: null,
        },
        () => false,
      ),
    ).toBe(permission === "autostart:configure");
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
  ).toBe('"C:\\App Folder\\한글.exe" "" "공백 값" "a\\"b" "끝\\\\" "& %PATH%"');
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
  ).toContain('"--no-env-file" "C:\\app\\assets\\boot.js" "--login"');
  expect(() =>
    commandLine(dev, [
      "--dev-url",
      "https://example.com",
    ]),
  ).toThrow();
});

test("absent, malformed and unknown approval states never claim to be enabled", () => {
  expect(startupState(null)).toBe("unknown");
  for (const state of [
    2,
    3,
    6,
    7,
    99,
  ]) {
    const data = Buffer.alloc(12);
    data.writeUInt32LE(state);
    expect(
      startupState({
        type: 3,
        data,
      }),
    ).toBe(state === 2 ? "enabled" : state === 3 ? "disabled" : "unknown");
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
    input: s.null(),
    output: s.null(),
    run: async (_input: unknown, _context: CommandContext) => {
      await disableAutostart();
      await expect(
        enableAutostart([
          "--login",
        ]),
      ).rejects.toMatchObject({
        code: "PERMISSION_DENIED",
      });
      await expect(getAutostartStatus()).rejects.toMatchObject({
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
      ...autostartPlugin,
      execution: "io" as const,
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
  const unregistered = await operations([], ".", "io", undefined, catalog, app);
  expect(observed).toBeUndefined();
  await unregistered.dispose();
  const registered = await operations(
    [
      autostartPlugin,
    ],
    ".",
    "io",
    undefined,
    catalog,
    app,
  );
  expect(observed).toEqual(app);
  await registered.dispose();
});

test("MSIX package identity is unsupported and native DLL disposal is idempotent", () => {
  const registryModule = new URL(
    "../../plugins/autostart/src/registry.ts",
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
