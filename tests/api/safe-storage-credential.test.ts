import { expect, test } from "bun:test";
import { WIN32_ERROR_UNKNOWN } from "@bunaway/plugin/win32";
import safeStorage from "@bunaway/plugin-safe-storage";
import macosSafeStorage from "@bunaway/plugin-safe-storage/native/macos";
import { NativeRegistry } from "@bunaway/protocol";
import { safeStorageLimits } from "../../plugins/safe-storage/src/contract.ts";
import {
  safeStorageOperations,
  windowsSafeStorageOperations,
} from "../../plugins/safe-storage/src/operations.ts";
import { WindowsSafeStorage } from "../../plugins/safe-storage/src/platforms/windows.ts";
import {
  assertCredentialAppId,
  credentialFailure,
  credentialTargetName,
} from "../../plugins/safe-storage/src/platforms/windows-credential.ts";
import { pluginParsers } from "../fixtures/plugin-parsers.ts";

const parsers = pluginParsers("safe-storage", windowsSafeStorageOperations);

test("credential operations exist on Windows only and each needs its own grant", () => {
  expect(safeStorage._definition.nativePlatforms.windows?.operations).toEqual(
    Object.keys(windowsSafeStorageOperations),
  );
  expect(safeStorage._definition.nativePlatforms.macos?.operations).toEqual(
    Object.keys(safeStorageOperations),
  );
  const registry = new NativeRegistry([
    safeStorage._definition,
  ]);
  for (const name of [
    "safe-storage.setSecret",
    "safe-storage.getSecret",
    "safe-storage.deleteSecret",
  ]) {
    expect(registry.operations.has(name)).toBe(true);
    expect(
      registry.allowed(
        {
          permissions: [
            "safe-storage.encryptString",
          ],
        },
        {
          operation: name,
          payload: null,
        },
      ),
    ).toBe(false);
  }
});

test("secret keys and values are bounded before reaching the native adapter", async () => {
  const valid = {
    key: "a.B_c-1",
    value: "토큰🙂",
  };
  expect(
    (
      await parsers.validateCall({
        operation: "safe-storage.setSecret",
        payload: valid,
      })
    ).payload,
  ).toEqual(valid);
  const longest = "x".repeat(safeStorageLimits.secretCharacters);
  expect(
    (
      await parsers.validateCall({
        operation: "safe-storage.setSecret",
        payload: {
          key: "k".repeat(safeStorageLimits.secretKeyCharacters),
          value: longest,
        },
      })
    ).payload,
  ).toBeDefined();
  expect(safeStorageLimits.secretBlobBytes).toBe(2560);
  for (const payload of [
    {
      key: "",
      value: "v",
    },
    {
      key: "has:colon",
      value: "v",
    },
    {
      key: "space key",
      value: "v",
    },
    {
      key: "k".repeat(safeStorageLimits.secretKeyCharacters + 1),
      value: "v",
    },
    {
      key: "k",
      value: "",
    },
    {
      key: "k",
      value: `${longest}x`,
    },
    {
      key: "k",
      value: "\ud800",
    },
    {
      key: "k",
      value: "v",
      extra: 1,
    },
  ]) {
    await expect(
      parsers.validateCall({
        operation: "safe-storage.setSecret",
        payload,
      }),
    ).rejects.toThrow();
  }
  for (const operation of [
    "safe-storage.getSecret",
    "safe-storage.deleteSecret",
  ]) {
    await expect(
      parsers.validateCall({
        operation,
        payload: {
          key: "a:b",
        },
      }),
    ).rejects.toThrow();
  }
  expect(await parsers.validateOutput("safe-storage.getSecret", null)).toBe(
    null,
  );
  expect(await parsers.validateOutput("safe-storage.getSecret", "v")).toBe("v");
  expect(await parsers.validateOutput("safe-storage.deleteSecret", false)).toBe(
    false,
  );
});

test("target names are namespaced by app id and unambiguous", () => {
  expect(credentialTargetName("com.example.app", "token")).toBe(
    "bunaway.safe-storage:com.example.app:token",
  );
  // Keys cannot contain ":", so an app id with a colon cannot collide with another app's key.
  expect(credentialTargetName("a:b", "c")).not.toBe(
    credentialTargetName("a", "b-c"),
  );
  expect(
    credentialTargetName("a", "c").startsWith("bunaway.safe-storage:"),
  ).toBe(true);
});

test("credential storage requires a stable host app identity", () => {
  for (const id of [
    undefined,
    "",
    "a\0b",
    "x".repeat(1025),
  ]) {
    expect(() => assertCredentialAppId(id)).toThrow(
      expect.objectContaining({
        code: "INVALID_ARGUMENT",
      }),
    );
  }
  expect(assertCredentialAppId("com.example.app")).toBe("com.example.app");
  // Without an app id only the credential operations fail; DPAPI operations are unaffected.
  const adapter = new WindowsSafeStorage();
  expect(() => adapter.getSecret("k")).toThrow(
    expect.objectContaining({
      code: "INVALID_ARGUMENT",
    }),
  );
  adapter.dispose();
  expect(() => adapter.getSecret("k")).toThrow(
    expect.objectContaining({
      code: "CANCELLED",
    }),
  );
});

test("credential failures are classified without echoing key or value", () => {
  for (const code of [
    170,
    1062,
    1312,
    1722,
    1723,
  ]) {
    expect(credentialFailure(code).code).toBe("BUSY");
  }
  expect(credentialFailure(5).code).toBe("PERMISSION_DENIED");
  for (const code of [
    87,
    1168,
    WIN32_ERROR_UNKNOWN,
  ]) {
    expect(credentialFailure(code).code).toBe("INTERNAL");
  }
});

test("macOS reports the credential operations as unsupported", async () => {
  const create = macosSafeStorage._definition.nativePlatforms.macos?.create;
  if (!create) {
    throw new Error("macOS adapter is missing.");
  }
  const adapter = create({
    dataRoot: "unused",
    capabilities: [],
  });
  try {
    await expect(
      Promise.resolve().then(() =>
        adapter.execute(
          "safe-storage.getSecret",
          {
            key: "token",
          },
          "backend",
        ),
      ),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
  } finally {
    adapter.dispose();
  }
});
