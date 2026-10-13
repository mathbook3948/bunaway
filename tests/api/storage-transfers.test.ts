import { expect, test } from "bun:test";
import { storagePlugin } from "@bunaway/plugin-storage";
import { NativeRegistry } from "@bunaway/protocol";
import { storageOperations } from "../../plugins/storage/src/contract.ts";
import { pluginParsers } from "../fixtures/plugin-parsers.ts";

const parsers = pluginParsers("storage", storageOperations);
const endpoints = {
  from: "C:/notes/한글.txt",
  to: "C:/archive/한글.txt",
};

test("file transfers require two explicit endpoints and reject implicit overwrite or recursive policy", async () => {
  for (const operation of [
    "storage.copyFile",
    "storage.move",
  ]) {
    expect(
      (
        await parsers.validateCall({
          operation,
          payload: endpoints,
        })
      ).payload,
    ).toEqual(endpoints);
    for (const payload of [
      {
        from: endpoints.from,
      },
      {
        to: endpoints.to,
      },
      {
        ...endpoints,
        overwrite: true,
      },
      {
        ...endpoints,
        recursive: true,
      },
      {
        ...endpoints,
        to: "bad\u0000path",
      },
    ]) {
      await expect(
        parsers.validateCall({
          operation,
          payload,
        }),
      ).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
    }
    expect(await parsers.validateOutput(operation, null)).toBeNull();
  }
});

test("copy and move grants do not imply one another or general read/write", () => {
  const registry = new NativeRegistry([
    storagePlugin,
  ]);
  for (const operation of [
    "storage.copyFile",
    "storage.move",
  ]) {
    for (const target of registry.operations.keys()) {
      expect(
        registry.allowed(
          {
            permissions: [
              operation,
            ],
          },
          {
            operation: target,
            payload: endpoints,
          },
        ),
      ).toBe(target === operation);
    }
  }
});
