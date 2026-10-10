import { expect, test } from "bun:test";
import { bindHostAPI } from "#core/host-api";
import { bindCommandHost } from "@bunaway/plugin-api/host";
import type { CommandContext } from "@bunaway/plugin-api";
import {
  type HostCall,
  type HostContext,
  NativeRegistry,
  type HostResponse,
  type Policy,
} from "@bunaway/protocol";
import { s } from "@bunaway/plugin";
import {
  openFile,
  openUrl,
  openerPlugin,
  revealFile,
} from "@bunaway/plugin-opener";
import {
  fileInput,
  MAX_FILE_PATH_LENGTH,
  normalizeFilePath,
} from "#plugins/opener/src/path";
import { matches } from "#plugins/opener/src/scope";
import { createOperations } from "#plugins/opener/src/windows";
import { MAX_URL_LENGTH, normalizeUrl } from "#plugins/opener/src/url";

const emptyPolicy: Policy = {
  version: 1,
  views: [],
  backend: {
    permissions: [],
  },
};

const registry = new NativeRegistry([
  openerPlugin,
]);
const operation = registry.operation("opener.openUrl");
const matchesNoScope = () => false;

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

test("file grants authorize exact paths, separate operations, and deny wins", () => {
  const path = "C:\\한글 폴더\\report.txt";
  for (const action of [
    "openFile",
    "revealFile",
  ]) {
    const permission = `opener:${action}`;
    const call = {
      operation: `opener.${action}`,
      payload: {
        path,
      },
    };
    const grant = {
      identifier: permission,
      allow: [
        {
          path: path.replaceAll("\\", "/"),
        },
      ],
    };
    registry.validatePolicy({
      ...emptyPolicy,
      backend: {
        permissions: [
          grant,
        ],
      },
    });
    expect(
      registry.allowed(
        {
          permissions: [
            grant,
          ],
        },
        call,
        matches,
      ),
    ).toBe(true);
    for (const other of [
      `${path}.old`,
      "C:\\한글 폴더\\Report.txt",
      "C:\\한글 폴더\\sub\\report.txt",
      "C:\\한글 폴더\\..\\report.txt",
    ]) {
      expect(
        registry.allowed(
          {
            permissions: [
              grant,
            ],
          },
          {
            ...call,
            payload: {
              path: other,
            },
          },
          matches,
        ),
      ).toBe(false);
    }
    expect(
      registry.allowed(
        {
          permissions: [
            grant,
            {
              identifier: permission,
              deny: [
                {
                  path,
                },
              ],
            },
          ],
        },
        call,
        matches,
      ),
    ).toBe(false);
    expect(
      registry.allowed(
        {
          permissions: [
            "opener:openUrl",
            permission,
          ],
        },
        call,
        matches,
      ),
    ).toBe(false);
    expect(
      registry.allowed(
        {
          permissions: [
            {
              ...grant,
              identifier:
                action === "openFile" ? "opener:revealFile" : "opener:openFile",
            },
          ],
        },
        call,
        matches,
      ),
    ).toBe(false);
    expect(() =>
      registry.validateCall({
        ...call,
        payload: {
          path,
          extra: true,
        },
      }),
    ).toThrow();
    expect(registry.operation(call.operation).output).toEqual({
      const: null,
    });
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
    input: s.null(),
    output: s.null(),
    run: async (_payload: unknown, _context: CommandContext) => {
      expect(await openFile(path.replaceAll("\\", "/"))).toBeNull();
      expect(await revealFile(path)).toBeNull();
      denied = true;
      await expect(openFile(path)).rejects.toMatchObject({
        code: "PERMISSION_DENIED",
      });
      await expect(revealFile("relative.txt")).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
      return null;
    },
  });
  await command.run(null, {
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
    "opener.openFile",
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
  ]);
});

test("opener preserves the strict URL operation and adds separately scoped file operations", () => {
  expect(operation.permission).toBe("opener:openUrl");
  expect(openerPlugin.native?.permissions).toEqual([
    {
      name: "opener:openUrl",
    },
    {
      name: "opener:openFile",
      scope: fileInput,
    },
    {
      name: "opener:revealFile",
      scope: fileInput,
    },
  ]);
  expect(operation.output).toEqual({
    const: null,
  });
  expect(
    registry.validateCall({
      operation: operation.name,
      payload: {
        url: "https://example.com/",
      },
    }).payload,
  ).toEqual({
    url: "https://example.com/",
  });
  expect(() =>
    registry.validateCall({
      operation: operation.name,
      payload: {
        url: "https://example.com/",
        extra: true,
      },
    }),
  ).toThrow();
  expect(() =>
    registry.validateCall({
      operation: operation.name,
      payload: {
        url: 42,
      },
    }),
  ).toThrow();
  expect(() =>
    registry.validatePolicy({
      ...emptyPolicy,
      backend: {
        permissions: [
          {
            identifier: "opener:openUrl",
            allow: [
              {},
            ],
          },
        ],
      },
    }),
  ).toThrow();
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
      "opener:openUrl",
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
    if (!registry.allowed(allowedPermissions, call, matchesNoScope)) {
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
        if (!registry.allowed(permissions, call, matchesNoScope)) {
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
      input: s.null(),
      output: s.null(),
      run: async (_payload: unknown, _context: CommandContext) => {
        await openUrl(url);
        return null;
      },
    });
    const context: CommandContext = {
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
    input: s.null(),
    output: s.null(),
    run: async (_payload: unknown, _context: CommandContext) => {
      await openUrl("https://example.com/");
      return null;
    },
  });
  const context: CommandContext = {
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
  const executeUI = adapter.executeUI;
  if (!executeUI) {
    throw new Error("Missing UI adapter.");
  }
  await expect(
    Promise.resolve().then(() =>
      executeUI(
        "opener.openUrl",
        {
          url: "https://example.com/",
        },
        "backend",
        {
          requestId: "disposed",
          permissions: {
            permissions: [
              "opener:openUrl",
            ],
          },
        },
      ),
    ),
  ).rejects.toMatchObject({
    code: "CANCELLED",
  });
});
