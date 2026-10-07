import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { bindHostAPI } from "../../packages/core/src/host-api.ts";
import type { NativeWindowServices } from "../../packages/plugin-api/src/native.ts";
import type { HostContext, Policy } from "../../packages/protocol/src/index.ts";
import { NativeRegistry } from "../../packages/protocol/src/index.ts";
import { windowsPlugin } from "../../plugins/windows/src/index.ts";
import { matches } from "../../plugins/windows/src/scope.ts";
import { createOperations } from "../../plugins/windows/src/windows.ts";

const registry = new NativeRegistry([
  windowsPlugin,
]);
const operation = registry.operation("windows.show");
test("an empty plugin registry exposes no built-in window or feature calls", async () => {
  const empty = new NativeRegistry([]);
  expect(empty.operations.size).toBe(0);
  expect(empty.permissions.size).toBe(0);
  let nativeCalls = 0;
  const host = bindHostAPI(
    "backend" as HostContext,
    new AbortController().signal,
    async () => {
      nativeCalls++;
      return {
        kind: "result",
        payload: null,
      };
    },
    empty,
  );
  await expect(
    host.call(operation, {
      view: "main",
    }),
  ).rejects.toMatchObject({
    code: "UNSUPPORTED",
  });
  expect(nativeCalls).toBe(0);
});

test("window permissions use generic deny-first matching and filter list results", async () => {
  const actions: string[] = [];
  const permissions: Policy["backend"] = {
    permissions: [
      "windows:list",
      {
        identifier: "windows:control",
        allow: [
          {
            view: "main",
          },
          {
            view: "private",
          },
        ],
        deny: [
          {
            view: "private",
          },
        ],
      },
    ],
  };
  const services: NativeWindowServices = {
    specs: [
      "main",
      "private",
    ].map((view) => ({
      view,
      home: "https://app.bunaway.local",
      title: view,
      window: {
        width: 800,
        height: 600,
      },
    })),
    read: () => ({
      closed: false,
      cleaned: false,
      ready: true,
      failure: null,
      deadline: Infinity,
    }),
    create() {},
    close: () => true,
    window: (view) => ({
      show: () => actions.push(view),
      focus: () => true,
      close: () => true,
      isFullscreen: () => false,
      setSize() {},
      setPosition() {},
      setFullscreen() {},
      setCloseConfirmation() {},
    }),
    stopping: () => false,
    cancelled: () => false,
    now: Date.now,
    tick: async () => {},
  };
  const adapter = createOperations({
    dataRoot: ".",
    capabilities: [],
    windows: services,
  });
  const execute = adapter.executeUI;
  if (!execute) {
    throw new Error("Missing UI adapter");
  }
  registry.validatePolicy({
    version: 1,
    views: [],
    backend: permissions,
  });
  expect(
    registry.allowed(
      permissions,
      {
        operation: "windows.show",
        payload: {
          view: "private",
        },
      },
      matches,
    ),
  ).toBe(false);
  expect(
    await execute("windows.list", null, "backend", {
      requestId: "list",
      permissions,
    }),
  ).toEqual([
    {
      view: "main",
      open: true,
    },
  ]);
  await execute(
    "windows.show",
    {
      view: "main",
    },
    "backend",
    {
      requestId: "show",
      permissions,
    },
  );
  await expect(
    Promise.resolve().then(() =>
      execute(
        "windows.show",
        {
          view: "private",
        },
        "backend",
        {
          requestId: "denied",
          permissions,
        },
      ),
    ),
  ).rejects.toMatchObject({
    code: "PERMISSION_DENIED",
  });
  expect(actions).toEqual([
    "main",
  ]);
  await adapter.dispose();
});

test("plugin SDK dependencies never reach Core or the Backend SDK", async () => {
  const seen = new Set<string>();
  async function visit(directory: string) {
    if (seen.has(directory)) {
      return;
    }
    seen.add(directory);
    const manifest = await Bun.file(
      resolve(import.meta.dir, "../../packages", directory, "package.json"),
    ).json();
    const release = await Bun.file(
      resolve(import.meta.dir, "../../framework.json"),
    ).json();
    for (const name of Object.keys({
      ...manifest.dependencies,
      ...manifest.peerDependencies,
    })) {
      expect(name).not.toBe("@bunaway/core");
      expect(name).not.toBe("@bunaway/backend");
      const entry = Object.entries(release.packages).find(
        ([, packageName]) => packageName === name,
      );
      if (entry) {
        await visit(entry[0]);
      }
    }
  }
  await visit("plugin-sdk");
  expect(seen.has("plugin-api")).toBe(true);
});

test("a zero-plugin UI bundle contains no optional feature implementation", async () => {
  const result = await Bun.build({
    entrypoints: [
      resolve(import.meta.dir, "../../native/windows/bun/ui.ts"),
    ],
    target: "bun",
    metafile: true,
  });
  expect(result.success).toBe(true);
  expect(
    Object.keys(result.metafile?.inputs ?? {}).some(
      (path) => path.includes("/plugins/") || path.startsWith("plugins/"),
    ),
  ).toBe(false);
  const output = await result.outputs[0]?.text();
  for (const name of [
    "windows.show",
    "storage.readText",
    "log.write",
    "capabilities.get",
  ]) {
    expect(output?.includes(JSON.stringify(name))).toBe(false);
  }
});
