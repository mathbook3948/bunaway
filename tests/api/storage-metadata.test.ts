import { storageOperations } from "../../plugins/storage/src/contract.ts";
import { pluginParsers } from "../fixtures/plugin-parsers.ts";

const parsers = pluginParsers("storage", storageOperations);

import { expect, test } from "bun:test";
import { type CommandContext, command } from "@bunaway/backend";
import type { CoreServices } from "@bunaway/core";
import {
  type StorageMetadata,
  storage,
  storagePlugin,
} from "@bunaway/plugin-storage";
import { NativeRegistry } from "@bunaway/protocol";
import { bindHostAPI } from "../fixtures/host-plugins.ts";

const location = {
  path: "notes/한글 memo.txt",
} as const;
const fileMetadata: Extract<
  StorageMetadata,
  {
    kind: "file";
  }
> = {
  kind: "file",
  sizeBytes: 5,
  createdAtMs: 1,
  modifiedAtMs: 2,
  accessedAtMs: null,
};
const directoryMetadata: Extract<
  StorageMetadata,
  {
    kind: "directory";
  }
> = {
  kind: "directory",
  sizeBytes: null,
  createdAtMs: null,
  modifiedAtMs: null,
  accessedAtMs: null,
};
const registry = new NativeRegistry([
  storagePlugin,
]);

function checkMetadataNarrowing(value: StorageMetadata | null): void {
  if (value?.kind === "file") {
    const sizeBytes: number = value.sizeBytes;
    void sizeBytes;
  } else if (value?.kind === "directory") {
    const sizeBytes: null = value.sizeBytes;
    void sizeBytes;
  }
}

export function checkStorageTypes(): void {
  const exists: Promise<boolean> = storage.exists(location);
  const stat: Promise<StorageMetadata | null> = storage.stat(location);
  const invalidScope = storage.exists({
    // @ts-expect-error storage has no scope input
    scope: "home",
    path: "memo.txt",
  });
  void [
    exists,
    stat,
    invalidScope,
    checkMetadataNarrowing,
  ];
}

test("metadata operations validate inputs and file or directory results", () => {
  for (const operation of [
    "storage.exists",
    "storage.stat",
  ] as const) {
    expect(
      parsers.validateCall({
        operation,
        payload: location,
      }),
    ).toEqual({
      operation,
      payload: location,
    });
  }
  expect(parsers.validateOutput("storage.exists", false)).toBe(false);
  expect(parsers.validateOutput("storage.stat", null)).toBeNull();
  expect(parsers.validateOutput("storage.stat", fileMetadata)).toEqual(
    fileMetadata,
  );
  expect(parsers.validateOutput("storage.stat", directoryMetadata)).toEqual(
    directoryMetadata,
  );

  for (const input of [
    {
      ...location,
      path: "memo\u0000.txt",
    },
    {
      ...location,
      path: "",
    },
  ]) {
    expect(() =>
      parsers.validateCall({
        operation: "storage.stat",
        payload: input,
      }),
    ).toThrow();
  }
  for (const output of [
    {
      ...fileMetadata,
      kind: "link",
    },
    {
      ...fileMetadata,
      sizeBytes: -1,
    },
    {
      ...fileMetadata,
      sizeBytes: Number.MAX_SAFE_INTEGER + 1,
    },
    {
      ...directoryMetadata,
      sizeBytes: 0,
    },
  ]) {
    expect(() => parsers.validateOutput("storage.stat", output)).toThrow();
  }
});

test("exists and stat require their own operation grants", () => {
  for (const operation of [
    "storage.exists",
    "storage.stat",
  ]) {
    const source = {
      permissions: [
        operation,
      ],
    };
    registry.validatePolicy({
      version: 1,
      views: [],
      backend: source,
    });
    expect(
      registry.allowed(source, {
        operation,
        payload: location,
      }),
    ).toBe(true);
    for (const other of [
      "storage.exists",
      "storage.stat",
      "storage.readText",
      "storage.writeText",
    ]) {
      if (other !== operation) {
        expect(
          registry.allowed(source, {
            operation: other,
            payload: location,
          }),
        ).toBe(false);
      }
    }
    expect(
      registry.allowed(
        {
          permissions: [],
        },
        {
          operation,
          payload: location,
        },
      ),
    ).toBe(false);
  }
});

function storagePath(payload: unknown): string {
  if (
    payload === null ||
    typeof payload !== "object" ||
    !("path" in payload) ||
    typeof payload.path !== "string"
  ) {
    throw new Error("Storage query payload is invalid.");
  }
  return payload.path;
}

function hostContext(callHost: CoreServices["callHost"]): CommandContext {
  const controller = new AbortController();
  return {
    host: bindHostAPI(
      "main" as Parameters<typeof bindHostAPI>[0],
      controller.signal,
      callHost,
    ),
    signal: controller.signal,
    state: {
      get: () => undefined,
      set() {},
      delete: () => false,
    },
    events: {
      async emit() {},
    },
  };
}

test("generated backend queries return missing results and forward access errors", async () => {
  const calls: string[] = [];
  const context = hostContext(async (_source, call) => {
    calls.push(call.operation);
    const path = storagePath(call.payload);
    if (path === "denied.txt") {
      return {
        kind: "error",
        error: {
          code: "PERMISSION_DENIED",
          message: "Storage access denied.",
        },
      };
    }
    if (call.operation === "storage.exists") {
      return {
        kind: "result",
        payload: path !== "missing.txt",
      };
    }
    return {
      kind: "result",
      payload: path === "missing.txt" ? null : fileMetadata,
    };
  });

  await command({
    input: {
      const: null,
    },
    output: {
      const: null,
    },
    async handle() {
      expect(await storage.exists(location)).toBe(true);
      expect(
        await storage.exists({
          ...location,
          path: "missing.txt",
        }),
      ).toBe(false);
      expect(await storage.stat(location)).toEqual(fileMetadata);
      expect(
        await storage.stat({
          ...location,
          path: "missing.txt",
        }),
      ).toBeNull();
      await expect(
        storage.stat({
          ...location,
          path: "denied.txt",
        }),
      ).rejects.toMatchObject({
        code: "PERMISSION_DENIED",
      });
      return null;
    },
  }).run(null, context);

  expect(calls).toEqual([
    "storage.exists",
    "storage.exists",
    "storage.stat",
    "storage.stat",
    "storage.stat",
  ]);
});
