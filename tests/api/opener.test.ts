import { expect, test } from "bun:test";
import { bindHostAPI } from "../../packages/core/src/host-api.ts";
import { bindCommandHost } from "../../packages/plugin-api/src/host.ts";
import type { CommandContext } from "../../packages/plugin-api/src/index.ts";
import {
  type HostCall,
  type HostContext,
  NativeRegistry,
  type HostResponse,
  type Policy,
} from "../../packages/protocol/src/index.ts";
import { s } from "../../packages/plugin-sdk/src/index.ts";
import { openUrl, openerPlugin } from "../../plugins/opener/src/index.ts";
import { createOperations } from "../../plugins/opener/src/windows.ts";
import { MAX_URL_LENGTH, normalizeUrl } from "../../plugins/opener/src/url.ts";

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

test("opener declares one strict URL operation and its permission", () => {
  expect(operation.permission).toBe("opener:openUrl");
  expect(openerPlugin.native?.permissions).toEqual([
    {
      name: "opener:openUrl",
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
