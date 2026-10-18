import { expect, test } from "bun:test";
import safeStorage from "@bunaway/plugin-safe-storage";
import { NativeRegistry, serializeHostResponse } from "@bunaway/protocol";
import { safeStorageLimits } from "../../plugins/safe-storage/src/contract.ts";
import { safeStorageOperations } from "../../plugins/safe-storage/src/operations.ts";
import { pluginParsers } from "../fixtures/plugin-parsers.ts";

const parsers = pluginParsers("safe-storage", safeStorageOperations);

test("data protection requires independent operation grants and reports platform support", () => {
  const registry = new NativeRegistry([
    safeStorage._definition,
  ]);
  for (const name of registry.operations.keys()) {
    for (const allowed of registry.operations.keys()) {
      expect(
        registry.allowed(
          {
            permissions: [
              allowed,
            ],
          },
          {
            operation: name,
            payload: null,
          },
        ),
      ).toBe(name === allowed);
    }
  }
  expect(safeStorage._definition.nativePlatforms.windows?.thread).toBe(
    "worker",
  );
  expect(Object.keys(safeStorage._definition.nativePlatforms)).toEqual([
    "macos",
    "windows",
  ]);
  expect(safeStorage._definition.nativePlatforms.macos?.operations).toEqual(
    Object.keys(safeStorageOperations),
  );
  expect(safeStorage._definition.nativePlatforms.windows?.operations).toEqual(
    Object.keys(safeStorageOperations),
  );
  expect(() =>
    new NativeRegistry([]).operation("safe-storage.encryptString"),
  ).toThrow();
});

test("data protection contracts bound bytes, Unicode text and ciphertext within transport limits", async () => {
  expect(
    await parsers.validateCall({
      operation: "safe-storage.isAvailable",
      payload: null,
    }),
  ).toEqual({
    operation: "safe-storage.isAvailable",
    payload: null,
  });
  expect(await parsers.validateOutput("safe-storage.isAvailable", false)).toBe(
    false,
  );
  for (const text of [
    "",
    "\uFEFF한글\u0000🙂",
    "\u0001".repeat(safeStorageLimits.textCharacters),
  ]) {
    expect(
      (
        await parsers.validateCall({
          operation: "safe-storage.encryptString",
          payload: {
            text,
          },
        })
      ).payload,
    ).toEqual({
      text,
    });
    expect(
      await parsers.validateOutput("safe-storage.decryptString", text),
    ).toBe(text);
    serializeHostResponse({
      kind: "result",
      payload: text,
    });
  }
  const bytes = Buffer.alloc(safeStorageLimits.plaintextBytes, 255).toString(
    "base64",
  );
  expect(
    (
      await parsers.validateCall({
        operation: "safe-storage.encryptBytes",
        payload: {
          bytes,
        },
      })
    ).payload,
  ).toEqual({
    bytes,
  });
  expect(await parsers.validateOutput("safe-storage.decryptBytes", bytes)).toBe(
    bytes,
  );
  const ciphertext = Buffer.alloc(safeStorageLimits.ciphertextBytes).toString(
    "base64",
  );
  expect(
    (
      await parsers.validateCall({
        operation: "safe-storage.decryptBytes",
        payload: {
          ciphertext,
        },
      })
    ).payload,
  ).toEqual({
    ciphertext,
  });
  serializeHostResponse({
    kind: "result",
    payload: ciphertext,
  });
});

test("data protection rejects noncanonical, oversized and unexpected inputs before native execution", async () => {
  for (const bytes of [
    "AB==",
    "AAF=",
    "AA",
    "AA==\n",
    "-w==",
    Buffer.alloc(safeStorageLimits.plaintextBytes + 1).toString("base64"),
  ]) {
    await expect(
      parsers.validateCall({
        operation: "safe-storage.encryptBytes",
        payload: {
          bytes,
        },
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  }
  for (const ciphertext of [
    "",
    "bad",
    "AA== ",
    Buffer.alloc(safeStorageLimits.ciphertextBytes + 1).toString("base64"),
  ]) {
    await expect(
      parsers.validateCall({
        operation: "safe-storage.decryptString",
        payload: {
          ciphertext,
        },
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  }
  for (const payload of [
    {
      text: "x".repeat(safeStorageLimits.textCharacters + 1),
    },
    {
      text: "secret",
      machine: true,
    },
    {
      text: "secret",
      entropy: "invented",
    },
    {
      text: "\ud800",
    },
  ]) {
    await expect(
      parsers.validateCall({
        operation: "safe-storage.encryptString",
        payload,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  }
  await expect(
    parsers.validateCall({
      operation: "safe-storage.isAvailable",
      payload: {},
    }),
  ).rejects.toThrow();
});

test("data protection measures supplementary Unicode at the UTF-16 boundary", async () => {
  const exactLimit = "🙂".repeat(16384);
  const aboveLimit = "🙂".repeat(16385);
  expect(exactLimit.length).toBe(32768);
  expect(aboveLimit.length).toBe(32770);
  expect(
    (
      await parsers.validateCall({
        operation: "safe-storage.encryptString",
        payload: {
          text: exactLimit,
        },
      })
    ).payload,
  ).toEqual({
    text: exactLimit,
  });
  expect(
    await parsers.validateOutput("safe-storage.decryptString", exactLimit),
  ).toBe(exactLimit);
  await expect(
    parsers.validateCall({
      operation: "safe-storage.encryptString",
      payload: {
        text: aboveLimit,
      },
    }),
  ).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
  await expect(
    parsers.validateOutput("safe-storage.decryptString", aboveLimit),
  ).rejects.toMatchObject({
    code: "INTERNAL",
  });
});

test("decryption results carry no re-encryption signal", async () => {
  // Electron on Windows registers a single DPAPI provider, so its shouldReEncrypt is always false.
  // The decrypt outputs stay plain values instead of a result and flag wrapper.
  for (const [operation, plain] of [
    [
      "safe-storage.decryptString",
      "text",
    ],
    [
      "safe-storage.decryptBytes",
      "AAAA",
    ],
  ] as const) {
    expect(await parsers.validateOutput(operation, plain)).toBe(plain);
    await expect(
      parsers.validateOutput(operation, {
        result: plain,
        shouldReEncrypt: false,
      }),
    ).rejects.toMatchObject({
      code: "INTERNAL",
    });
  }
});
