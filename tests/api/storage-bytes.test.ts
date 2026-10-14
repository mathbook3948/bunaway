import { expect, test } from "bun:test";
import storage from "@bunaway/plugin-storage";
import { NativeRegistry } from "@bunaway/protocol";
import { MAX_STORAGE_BYTES } from "../../plugins/storage/src/bytes.ts";
import { windowsOperations } from "../../plugins/storage/src/platforms/windows-operations.ts";
import { pluginParsers } from "../fixtures/plugin-parsers.ts";

const parsers = pluginParsers("storage", windowsOperations);
const path = "C:/notes/한글.bin";
const operations = [
  "storage.readBytes",
  "storage.writeBytes",
  "storage.appendBytes",
  "storage.appendText",
] as const;

test("byte contracts accept canonical base64 through the native validation boundary", async () => {
  for (const bytes of [
    "",
    "AA==",
    "AP8=",
    Buffer.from([
      0,
      1,
      128,
      255,
    ]).toString("base64"),
    Buffer.alloc(MAX_STORAGE_BYTES, 255).toString("base64"),
  ]) {
    for (const operation of [
      "storage.writeBytes",
      "storage.appendBytes",
    ] as const) {
      const payload = {
        path,
        bytes,
      };
      expect(
        await parsers.validateCall({
          operation,
          payload,
        }),
      ).toEqual({
        operation,
        payload,
      });
    }
    expect(await parsers.validateOutput("storage.readBytes", bytes)).toBe(
      bytes,
    );
  }
  expect(
    await parsers.validateCall({
      operation: "storage.readBytes",
      payload: {
        path,
      },
    }),
  ).toEqual({
    operation: "storage.readBytes",
    payload: {
      path,
    },
  });
  expect(
    await parsers.validateCall({
      operation: "storage.appendText",
      payload: {
        path,
        text: "한글\u0000🙂",
      },
    }),
  ).toEqual({
    operation: "storage.appendText",
    payload: {
      path,
      text: "한글\u0000🙂",
    },
  });
});

test("byte contracts reject malformed, noncanonical and oversized input and output", async () => {
  for (const bytes of [
    "A",
    "AA",
    "AA=",
    "AA===",
    "AA==\n",
    "AA== ",
    "-w==",
    "_w==",
    "AB==",
    "AAF=",
    Buffer.alloc(MAX_STORAGE_BYTES + 1).toString("base64"),
  ]) {
    for (const operation of [
      "storage.writeBytes",
      "storage.appendBytes",
    ] as const) {
      await expect(
        parsers.validateCall({
          operation,
          payload: {
            path,
            bytes,
          },
        }),
      ).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
    }
    await expect(
      parsers.validateOutput("storage.readBytes", bytes),
    ).rejects.toMatchObject({
      code: "INTERNAL",
    });
  }
  for (const payload of [
    {
      path,
    },
    {
      path,
      bytes: [
        0,
        255,
      ],
    },
    {
      path,
      bytes: "",
      extra: true,
    },
    {
      path: "bad\u0000",
      bytes: "",
    },
  ]) {
    await expect(
      parsers.validateCall({
        operation: "storage.writeBytes",
        payload,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  }
});

test("byte and append grants are independent from each other and text replacement", () => {
  const registry = new NativeRegistry([
    storage._definition,
  ]);
  for (const operation of operations) {
    const permissions = {
      permissions: [
        operation,
      ],
    };
    for (const target of [
      ...operations,
      "storage.readText",
      "storage.writeText",
    ]) {
      expect(
        registry.allowed(permissions, {
          operation: target,
          payload: null,
        }),
      ).toBe(target === operation);
    }
  }
});
