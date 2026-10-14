import { expect, test } from "bun:test";
import type { CommandContext } from "@bunaway/plugin-api";
import { bindCommandHost } from "@bunaway/plugin-api/host";
import notification from "@bunaway/plugin-notification";
import { type HostContext, NativeRegistry } from "@bunaway/protocol";
import { bindHostAPI } from "#core/host-api";
import { validateNotificationInput } from "#plugins/notification/src/contract";
import { notificationOperations } from "#plugins/notification/src/operations";
import { pluginParsers } from "../fixtures/plugin-parsers.ts";

const parsers = pluginParsers("notification", notificationOperations);
const registry = new NativeRegistry([
  notification._definition,
]);

test("notification status and Settings require separate permissions and null-only inputs", async () => {
  expect([
    ...registry.operations.keys(),
  ]).toEqual([
    "notification.getStatus",
    "notification.openSettings",
  ]);
  for (const operation of registry.operations.keys()) {
    expect(
      registry.allowed(
        {
          permissions: [
            operation,
          ],
        },
        {
          operation,
          payload: null,
        },
      ),
    ).toBe(true);
    const other = operation.endsWith("getStatus")
      ? "notification.openSettings"
      : "notification.getStatus";
    expect(
      registry.allowed(
        {
          permissions: [
            other,
          ],
        },
        {
          operation,
          payload: null,
        },
      ),
    ).toBe(false);
    await expect(
      parsers.validateCall({
        operation,
        payload: null,
      }),
    ).resolves.toMatchObject({
      payload: null,
    });
    for (const payload of [
      {},
      {
        appUserModelId: "another.app",
      },
      {
        uri: "file:///C:/secret",
      },
      "ms-settings:privacy-notifications",
    ]) {
      await expect(
        parsers.validateCall({
          operation,
          payload,
        }),
      ).rejects.toThrow();
      expect(() => validateNotificationInput(operation, payload)).toThrow();
    }
  }
  expect(() => validateNotificationInput("notification.show", null)).toThrow();
});

test("availability and Windows' setting cannot be confused at the output boundary", async () => {
  for (const setting of [
    "enabled",
    "disabledForApplication",
    "disabledForUser",
    "disabledByGroupPolicy",
    "disabledByManifest",
    "unknown",
  ]) {
    const status = {
      support: "supported",
      appUserModelId: "com.example.app",
      setting,
    };
    await expect(
      parsers.validateOutput("notification.getStatus", status),
    ).resolves.toEqual(status);
  }
  await expect(
    parsers.validateOutput("notification.getStatus", {
      support: "unsupported",
      appUserModelId: "com.example.app",
      setting: null,
    }),
  ).resolves.toBeDefined();
  for (const status of [
    {
      support: "supported",
      appUserModelId: "com.example.app",
      setting: null,
    },
    {
      support: "unsupported",
      appUserModelId: "com.example.app",
      setting: "enabled",
    },
    {
      support: "supported",
      appUserModelId: "com.example.app",
      setting: "granted",
    },
    {
      support: "supported",
      appUserModelId: "com.example.app",
      setting: "enabled",
      permissionGranted: true,
    },
  ]) {
    await expect(
      parsers.validateOutput("notification.getStatus", status),
    ).rejects.toThrow();
  }
});

test("public helpers preserve caller context, cancellation and native failures", async () => {
  const calls: string[] = [];
  const controller = new AbortController();
  const host = bindHostAPI(
    "backend" as HostContext,
    controller.signal,
    async (_context, call) => {
      calls.push(call.operation);
      expect(call.payload).toBeNull();
      return call.operation === "notification.getStatus"
        ? {
            kind: "result",
            payload: {
              support: "supported",
              appUserModelId: "com.example.app",
              setting: "disabledForApplication",
            },
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
      await expect(notification.getStatus()).resolves.toMatchObject({
        setting: "disabledForApplication",
      });
      await expect(notification.openSettings()).rejects.toMatchObject({
        code: "PERMISSION_DENIED",
      });
      controller.abort();
      await expect(notification.getStatus()).rejects.toMatchObject({
        code: "CANCELLED",
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
    "notification.getStatus",
    "notification.openSettings",
  ]);
});

test("native WinRT status and fixed Settings calls balance resources on failures and preserve existing STA ownership", () => {
  const module = new URL(
    "../../plugins/notification/src/winrt.ts",
    import.meta.url,
  ).href;
  const child = Bun.spawnSync([
    process.execPath,
    "-e",
    `
import assert from "node:assert/strict";
import { mock } from "bun:test";
const ffi = await import("bun:ffi");
let initResult = 0, factoryResult = 0, notifierResult = 0, settingResult = 0, settingValue = 0, packageResult = 15700, shellResult = 33;
let init = 0, uninit = 0, stringsCreated = 0, stringsDeleted = 0, bindingsCreated = 0, bindingsClosed = 0;
const released = [], closed = [], observedStrings = [], shellCalls = [];
const writePointer = (out, value) => new DataView(ffi.toArrayBuffer(out, 0, 8)).setBigUint64(0, BigInt(value), true);
mock.module("bun:ffi", () => ({ ...ffi,
  read: { ...ffi.read, ptr: (object, offset = 0) => object < 1000 ? object + 1000 : object + offset },
  CFunction: ({ ptr: address }) => {
    bindingsCreated++;
    const binding = (object, ...args) => {
      if (address === 1116 || address === 1216) { released.push(object); return 0; }
      if (address === 1156) { if (notifierResult >= 0) writePointer(args[1], 200); return notifierResult; }
      if (address === 1264) { if (settingResult >= 0) new DataView(ffi.toArrayBuffer(args[0], 0, 4)).setInt32(0, settingValue, true); return settingResult; }
      assert.fail("Unexpected COM slot " + address);
    };
    binding.close = () => bindingsClosed++;
    return binding;
  },
  dlopen: (name) => ({
    close: () => closed.push(name),
    symbols: {
      RoInitialize: (mode) => { assert.equal(mode, 0); init++; return initResult; },
      RoUninitialize: () => uninit++,
      WindowsCreateString: (text, length, out) => { observedStrings.push(Buffer.from(ffi.toArrayBuffer(text, 0, length * 2)).toString("utf16le")); writePointer(out, ++stringsCreated + 10000); return 0; },
      WindowsDeleteString: () => { stringsDeleted++; return 0; },
      RoGetActivationFactory: (_name, iid, out) => { assert.equal(Buffer.from(ffi.toArrayBuffer(iid, 0, 16)).toString("hex"), "3f10ac5035d29845bbef98fe4d1a3ad4"); if (factoryResult >= 0) writePointer(out, 100); return factoryResult; },
      GetCurrentPackageFullName: () => packageResult,
      ShellExecuteW: (_hwnd, verb, uri, parameters, directory, show) => {
        assert.equal(ffi.CString(verb, 0, 8).toString(), "o\\0p\\0e\\0n\\0");
        assert.equal(Buffer.from(ffi.toArrayBuffer(uri, 0, "ms-settings:notifications\\0".length * 2)).toString("utf16le"), "ms-settings:notifications\\0");
        assert.equal(parameters, null); assert.equal(directory, null); assert.equal(show, 1); shellCalls.push(true); return BigInt(shellResult);
      },
    },
  }),
}));
const { createNotifications, notificationSetting } = await import(${JSON.stringify(module)});
for (const [value, setting] of [[0,"enabled"],[1,"disabledForApplication"],[2,"disabledForUser"],[3,"disabledByGroupPolicy"],[4,"disabledByManifest"],[5,"unknown"],[-1,"unknown"]]) assert.equal(notificationSetting(value), setting);
for (const id of ["", "UPPER", "../app", "app\\0bad", "x".repeat(65)]) assert.throws(() => createNotifications(id), {code:"INVALID_ARGUMENT"});
const native = createNotifications("com.example.app");
for (settingValue of [0,1,2,3,4,99]) {
  const result = native.getStatus();
  assert.equal(result.appUserModelId, "com.example.app"); assert.equal(result.support, "supported"); assert.equal(result.setting, notificationSetting(settingValue));
}
initResult = 1; native.getStatus(); // S_FALSE must balance our reference and preserve the pre-existing STA.
initResult = -2147417850; const beforeUninit = uninit;
assert.throws(() => native.getStatus(), {code:"INTERNAL"}); assert.equal(uninit, beforeUninit);
initResult = 0;
for (factoryResult of [-2147221164,-2147221231,-2147467262]) assert.deepEqual(native.getStatus(), {support:"unsupported",appUserModelId:"com.example.app",setting:null});
factoryResult = -2147024891; assert.throws(() => native.getStatus(), {code:"PERMISSION_DENIED"});
factoryResult = -2147467259; assert.throws(() => native.getStatus(), {code:"INTERNAL"});
factoryResult = 0;
notifierResult = -2147467259; assert.throws(() => native.getStatus(), {code:"INTERNAL"}); notifierResult = 0;
settingResult = -2147024891; assert.throws(() => native.getStatus(), {code:"PERMISSION_DENIED"}); settingResult = 0;
settingResult = -2147023728;
assert.throws(() => native.getStatus(), error => error.code === "UNSUPPORTED" && error.details.hresult === 0x80070490 && error.details.stage === "ToastNotifier.Setting");
settingResult = 0;
packageResult = 122; assert.throws(() => native.getStatus(), {code:"UNSUPPORTED"}); packageResult = 15700;
packageResult = 5; assert.throws(() => native.getStatus(), {code:"PERMISSION_DENIED"}); packageResult = 15700;
assert.equal(native.openSettings(), null);
shellResult = 5; assert.throws(() => native.openSettings(), {code:"PERMISSION_DENIED"});
shellResult = 0; assert.throws(() => native.openSettings(), {code:"INTERNAL"});
assert.equal(shellCalls.length, 3);
assert.equal(stringsCreated, stringsDeleted); assert.equal(bindingsCreated, bindingsClosed); assert.equal(init - 1, uninit);
assert.deepEqual(released.slice(0,2), [200,100]);
assert(observedStrings.includes("com.example.app"));
native.dispose(); native.dispose();
assert.equal(closed.filter(x=>x==="combase.dll").length,1); assert.equal(closed.filter(x=>x==="kernel32.dll").length,1);
assert.throws(() => native.getStatus(), {code:"CANCELLED"}); assert.throws(() => native.openSettings(), {code:"CANCELLED"});
`,
  ]);
  expect(child.exitCode, child.stderr.toString()).toBe(0);
});
