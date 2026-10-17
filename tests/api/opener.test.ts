import { expect, test } from "bun:test";
import type { CommandContext } from "@bunaway/plugin-api";
import { bindCommandHost } from "@bunaway/plugin-api/host";
import opener from "@bunaway/plugin-opener";
import {
  type HostCall,
  type HostContext,
  type HostResponse,
  NativeRegistry,
  type Policy,
} from "@bunaway/protocol";
import { bindHostAPI } from "#core/host-api";
import {
  MAX_FILE_PATH_LENGTH,
  MAX_URL_LENGTH,
} from "#plugins/opener/src/contract";
import createOperationsDefinition from "#plugins/opener/src/index";
import { windowsOperations as openerOperations } from "#plugins/opener/src/operations";
import { normalizeFilePath } from "#plugins/opener/src/platforms/windows-path";
import { normalizeUrl } from "#plugins/opener/src/url";
import { testAppInfo } from "../fixtures/app-info.ts";
import { nativeFactory as createOperationsFactory } from "../fixtures/native-platform.ts";
import { pluginParsers } from "../fixtures/plugin-parsers.ts";

const createOperations = createOperationsFactory(
  createOperationsDefinition,
  "windows",
);

const emptyPolicy: Policy = {
  version: 1,
  views: [],
  backend: {
    permissions: [],
  },
};
const parsers = pluginParsers("opener", openerOperations);
const registry = new NativeRegistry([
  opener._definition,
]);
const operation = registry.operation("opener.openUrl");
test("file paths preserve Unicode and spaces and normalize separators and drive letters", () => {
  expect(normalizeFilePath("c:/한글 폴더/😀, 보고서.txt")).toBe(
    "C:\\한글 폴더\\😀, 보고서.txt",
  );
  expect(normalizeFilePath("\\\\server\\share\\한글 값.txt")).toBe(
    "\\\\server\\share\\한글 값.txt",
  );
  expect(
    normalizeFilePath(`C:\\a\\${"a".repeat(MAX_FILE_PATH_LENGTH - 9)}.txt`),
  ).toHaveLength(MAX_FILE_PATH_LENGTH);
  for (const path of [
    null,
    42,
    "",
    "relative.txt",
    "C:file.txt",
    "\\file.txt",
    "C:\\",
    "\\\\server\\share",
    "file:///C:/a.txt",
    "C:\\a\\..\\b.txt",
    "C:\\a\\.\\b.txt",
    "C:\\a\\\\b.txt",
    "C:\\a.txt:stream",
    "\\\\?\\C:\\a.txt",
    "\\\\.\\pipe\\a",
    "C:\\a.txt\0",
    "C:\\a.txt\n",
    "C:\\a.txt ",
    "C:\\NUL.txt",
    "C:\\COM¹",
    "C:\\bad\ud800.txt",
    `C:\\${"a".repeat(MAX_FILE_PATH_LENGTH)}`,
  ]) {
    expect(() => normalizeFilePath(path)).toThrow(
      expect.objectContaining({
        code: "INVALID_ARGUMENT",
      }),
    );
  }
});
test("file grants authorize only the selected operation and do not encode app path rules", async () => {
  for (const action of [
    "openFile",
    "revealFile",
    "trashFile",
  ]) {
    const source = {
      permissions: [
        `opener.${action}`,
      ],
    };
    registry.validatePolicy({
      ...emptyPolicy,
      backend: source,
    });
    for (const path of [
      "C:/한글 폴더/report.txt",
      "C:/other.txt",
    ]) {
      const call = await parsers.validateCall({
        operation: `opener.${action}`,
        payload: {
          path,
        },
      });
      expect(registry.allowed(source, call)).toBe(true);
      expect(
        registry.allowed(
          {
            permissions: [],
          },
          call,
        ),
      ).toBe(false);
    }
    const other = action === "openFile" ? "revealFile" : "openFile";
    expect(
      registry.allowed(source, {
        operation: `opener.${other}`,
        payload: {
          path: "C:/other.txt",
        },
      }),
    ).toBe(false);
  }
});
test("public file APIs use caller context and preserve OS failure codes", async () => {
  const calls: HostCall[] = [];
  const path = "C:\\한글 폴더\\공백 값.txt";
  const controller = new AbortController();
  let denied = false;
  const host = bindHostAPI(
    "backend" as HostContext,
    controller.signal,
    async (_context, call) => {
      calls.push(call);
      return denied
        ? {
            kind: "error",
            error: {
              code: "PERMISSION_DENIED",
              message: "File access denied.",
            },
          }
        : {
            kind: "result",
            payload: null,
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
    run: async (_payload: unknown, _context: CommandContext) => {
      expect(await opener.openFile(path.replaceAll("\\", "/"))).toBeNull();
      expect(await opener.revealFile(path)).toBeNull();
      expect(await opener.trashFile(path)).toBeNull();
      expect(await opener.openFile('/private/tmp/한글 값,".txt')).toBeNull();
      expect(await opener.revealFile('/private/tmp/한글 값,".txt')).toBeNull();
      expect(
        await opener.addRecentDocument(path.replaceAll("\\", "/")),
      ).toBeNull();
      expect(await opener.clearRecentDocuments()).toBeNull();
      // A POSIX path must reach the host, where macOS reports UNSUPPORTED.
      expect(
        await opener.addRecentDocument('/private/tmp/한글 값,".txt'),
      ).toBeNull();
      denied = true;
      await expect(opener.openFile(path)).rejects.toMatchObject({
        code: "PERMISSION_DENIED",
      });
      await expect(opener.trashFile(path)).rejects.toMatchObject({
        code: "PERMISSION_DENIED",
      });
      await expect(opener.addRecentDocument(path)).rejects.toMatchObject({
        code: "PERMISSION_DENIED",
      });
      await expect(opener.clearRecentDocuments()).rejects.toMatchObject({
        code: "PERMISSION_DENIED",
      });
      await expect(
        opener.addRecentDocument("relative.txt"),
      ).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
      await expect(opener.revealFile("relative.txt")).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
      await expect(opener.trashFile("relative.txt")).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
      return null;
    },
  });
  await command.run(null, {
    app: testAppInfo,
    signal: controller.signal,
    host,
    state: {
      get: () => undefined,
      set() {},
      delete: () => false,
    },
    events: {
      async emit() {},
    },
  });
  expect(calls.map((call) => call.operation)).toEqual([
    "opener.openFile",
    "opener.revealFile",
    "opener.trashFile",
    "opener.openFile",
    "opener.revealFile",
    "opener.addRecentDocument",
    "opener.clearRecentDocuments",
    "opener.addRecentDocument",
    "opener.openFile",
    "opener.trashFile",
    "opener.addRecentDocument",
    "opener.clearRecentDocuments",
  ]);
  expect(calls.map((call) => call.payload)).toEqual([
    {
      path,
    },
    {
      path,
    },
    {
      path,
    },
    {
      path: '/private/tmp/한글 값,".txt',
    },
    {
      path: '/private/tmp/한글 값,".txt',
    },
    {
      path,
    },
    {},
    {
      path: '/private/tmp/한글 값,".txt',
    },
    {
      path,
    },
    {
      path,
    },
    {
      path,
    },
    {},
  ]);
});
test("opener preserves strict inputs and independently granted file operations", async () => {
  expect(operation.name).toBe("opener.openUrl");
  expect(
    opener._definition.native?.operations.map(({ name }) => ({
      name,
    })),
  ).toEqual([
    {
      name: "opener.openUrl",
    },
    {
      name: "opener.openFile",
    },
    {
      name: "opener.trashFile",
    },
    {
      name: "opener.revealFile",
    },
    {
      name: "opener.openFileWith",
    },
    {
      name: "opener.openUrlWith",
    },
    {
      name: "opener.addRecentDocument",
    },
    {
      name: "opener.clearRecentDocuments",
    },
  ]);
  expect(Object.keys(operation)).toEqual([
    "name",
  ]);
  expect(
    (
      await parsers.validateCall({
        operation: operation.name,
        payload: {
          url: "https://example.com/",
        },
      })
    ).payload,
  ).toEqual({
    url: "https://example.com/",
  });
  await expect(
    parsers.validateCall({
      operation: operation.name,
      payload: {
        url: "https://example.com/",
        extra: true,
      },
    }),
  ).rejects.toThrow();
  await expect(
    parsers.validateCall({
      operation: operation.name,
      payload: {
        url: 42,
      },
    }),
  ).rejects.toThrow();
  expect(() =>
    registry.validatePolicy({
      ...emptyPolicy,
      backend: {
        permissions: [
          "opener.openUrl",
        ],
      },
    }),
  ).not.toThrow();
});
test("URL validation accepts HTTP and HTTPS and preserves parsed Korean query text", () => {
  for (const input of [
    "https://example.com/a path?q=hello world&lang=한글",
    "http://例え.テスト/경로?q=검색어",
  ]) {
    const normalized = normalizeUrl(input);
    const parsed = new URL(normalized);
    expect(normalized).toBe(new URL(input).href);
    expect(parsed.protocol).toMatch(/^https?:$/);
    expect(
      parsed.searchParams.get("lang") ?? parsed.searchParams.get("q"),
    ).toBe(input.includes("lang=") ? "한글" : "검색어");
  }
});
test("URL validation rejects malformed values and non-HTTP schemes", () => {
  for (const input of [
    null,
    42,
    "",
    " https://example.com/",
    "https://example.com/ ",
    "https://",
    "http:///example.com",
    "https://example.com/\\@evil.test",
    "https://example.com/\npath",
    "file:///C:/secret.txt",
    "javascript:alert(1)",
    "custom+open://example.com/",
  ]) {
    let error: unknown;
    try {
      normalizeUrl(input);
    } catch (cause) {
      error = cause;
    }
    expect(error).toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  }
});
test("URL length is checked after URL encoding", () => {
  const exactLimit = `https://x/${"a".repeat(MAX_URL_LENGTH - 10)}`;
  expect(exactLimit).toHaveLength(MAX_URL_LENGTH);
  expect(normalizeUrl(exactLimit)).toBe(exactLimit);
  const expanded = `https://example.com/${"한".repeat(1000)}`;
  expect(expanded.length).toBeLessThan(MAX_URL_LENGTH);
  let error: unknown;
  try {
    normalizeUrl(expanded);
  } catch (cause) {
    error = cause;
  }
  expect(error).toMatchObject({
    code: "INVALID_ARGUMENT",
  });
});
test("openUrl uses the caller host, and the registered permission controls it", async () => {
  const allowedPermissions: Policy["backend"] = {
    permissions: [
      "opener.openUrl",
    ],
  };
  const deniedPermissions: Policy["backend"] = {
    permissions: [],
  };
  registry.validatePolicy({
    ...emptyPolicy,
    backend: allowedPermissions,
  });
  const calls: HostCall[] = [];
  const callHost = async (
    _context: HostContext,
    call: HostCall,
  ): Promise<HostResponse> => {
    if (!registry.allowed(allowedPermissions, call)) {
      return {
        kind: "error",
        error: {
          code: "PERMISSION_DENIED",
          message: "Permission denied.",
        },
      };
    }
    calls.push(call);
    return {
      kind: "result",
      payload: null,
    };
  };
  const invokeOpenUrl = async (permissions: Policy["backend"], url: string) => {
    const controller = new AbortController();
    const host = bindHostAPI(
      "backend" as HostContext,
      controller.signal,
      async (context, call) => {
        if (!registry.allowed(permissions, call)) {
          return {
            kind: "error",
            error: {
              code: "PERMISSION_DENIED",
              message: "Permission denied.",
            },
          };
        }
        return callHost(context, call);
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
      run: async (_payload: unknown, _context: CommandContext) => {
        await opener.openUrl(url);
        return null;
      },
    });
    const context: CommandContext = {
      app: testAppInfo,
      signal: controller.signal,
      host,
      state: {
        get: () => undefined,
        set() {},
        delete: () => false,
      },
      events: {
        async emit() {},
      },
    };
    await command.run(null, context);
  };
  const url = "https://example.com/한글?q=공백 and value";
  await invokeOpenUrl(allowedPermissions, url);
  expect(calls).toEqual([
    {
      operation: "opener.openUrl",
      payload: {
        url: new URL(url).href,
      },
    },
  ]);
  await expect(
    invokeOpenUrl(deniedPermissions, "https://example.com/"),
  ).rejects.toMatchObject({
    code: "PERMISSION_DENIED",
  });
  expect(calls).toHaveLength(1);
  await expect(
    invokeOpenUrl(allowedPermissions, "file:///C:/secret.txt"),
  ).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
  expect(calls).toHaveLength(1);
});
test("openUrl preserves a native host execution failure", async () => {
  const controller = new AbortController();
  const host = bindHostAPI(
    "backend" as HostContext,
    controller.signal,
    async () => ({
      kind: "error",
      error: {
        code: "INTERNAL",
        message: "Browser launch failed.",
      },
    }),
    registry,
  );
  const command = bindCommandHost({
    input: {
      const: null,
    },
    output: {
      const: null,
    },
    run: async (_payload: unknown, _context: CommandContext) => {
      await opener.openUrl("https://example.com/");
      return null;
    },
  });
  const context: CommandContext = {
    app: testAppInfo,
    signal: controller.signal,
    host,
    state: {
      get: () => undefined,
      set() {},
      delete: () => false,
    },
    events: {
      async emit() {},
    },
  };
  await expect(command.run(null, context)).rejects.toMatchObject({
    code: "INTERNAL",
    message: "Browser launch failed.",
  });
});
test("Windows adapter disposal is repeatable and blocks later opens", async () => {
  if (process.platform !== "win32") {
    return;
  }
  const adapter = createOperations({
    dataRoot: ".",
    capabilities: [],
  });
  await adapter.dispose();
  await adapter.dispose();
  await expect(
    Promise.resolve().then(
      async () =>
        await adapter.execute(
          "opener.openUrl",
          {
            url: "https://example.com/",
          },
          "backend",
        ),
    ),
  ).rejects.toMatchObject({
    code: "CANCELLED",
  });
});
