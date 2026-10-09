import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { hostResponse } from "../../native/windows/bun/host-response.ts";
import { loadPluginCatalog } from "../../native/windows/bun/plugin-catalog.ts";
import {
  operations,
  permissionMatcher,
  pluginRegistry,
} from "../../native/windows/bun/plugins.ts";
import { pluginImportsSource } from "../../packages/cli/src/app-modules.ts";
import { writeJson } from "../../packages/cli/src/files.ts";
import {
  installedPlugins,
  writePluginManifest,
} from "../../packages/cli/src/plugins.ts";
import {
  BunawayError,
  NativeRegistry,
  type Policy,
} from "../../packages/protocol/src/index.ts";

test("scoped plugins without a Windows adapter preserve authorization and return UNSUPPORTED", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "bunaway-plugin-unsupported-"));
  try {
    const plugin = resolve(root, "node_modules/@example/plugin-files");
    await mkdir(plugin, {
      recursive: true,
    });
    await mkdir(resolve(root, "node_modules/@bunaway/plugin"), {
      recursive: true,
    });
    await writeJson(resolve(root, "package.json"), {
      dependencies: {
        "@example/plugin-files": "1.0.0",
      },
    });
    await writeJson(resolve(plugin, "package.json"), {
      name: "@example/plugin-files",
      version: "1.0.0",
      type: "module",
      bunaway: {
        plugin: "plugin.json",
      },
      peerDependencies: {
        "@bunaway/plugin": "0.0.0",
      },
    });
    await writeJson(
      resolve(root, "node_modules/@bunaway/plugin/package.json"),
      {
        name: "@bunaway/plugin",
        version: "0.0.0",
      },
    );
    await writeJson(resolve(plugin, "plugin.json"), {
      format: 1,
      name: "files",
      entry: "index.ts",
      platforms: {},
    });
    await Bun.write(
      resolve(plugin, "index.ts"),
      `export default {
      name: "files", version: "1.0.0", native: {
        operations: [{ name: "files.read", input: { type: "string" }, output: { type: "string" }, permission: "files:read" }],
        permissions: [{ name: "files:read", scope: { type: "string" } }]
      }, matches: (_permission, input, scope) => input === scope
    };`,
    );
    const installed = await installedPlugins(root, "0.0.0");
    await writePluginManifest(root, installed);
    await Bun.write(
      resolve(root, "plugin-imports.js"),
      pluginImportsSource(installed),
    );
    const catalog = await loadPluginCatalog(
      root,
      (await import(pathToFileURL(resolve(root, "plugin-imports.js")).href))
        .pluginImports,
    );
    expect(catalog[0]?.execution).toBeUndefined();
    expect(catalog[0]?.operations).toBeUndefined();
    const registry = pluginRegistry(installed, catalog);
    const matches = await permissionMatcher(installed, catalog);
    const adapters = await operations(
      installed,
      root,
      "io",
      undefined,
      catalog,
    );
    try {
      const call = registry.validateCall({
        operation: "files.read",
        payload: "notes",
      });
      for (const [permissions, code] of [
        [
          [
            {
              identifier: "files:read",
              allow: [
                "notes",
              ],
            },
          ],
          "UNSUPPORTED",
        ],
        [
          [
            {
              identifier: "files:read",
              allow: [
                "other",
              ],
            },
          ],
          "PERMISSION_DENIED",
        ],
        [
          [
            {
              identifier: "files:read",
              allow: [
                "notes",
              ],
              deny: [
                "notes",
              ],
            },
          ],
          "PERMISSION_DENIED",
        ],
        [
          [],
          "PERMISSION_DENIED",
        ],
      ] satisfies [
        Policy["backend"]["permissions"],
        string,
      ][]) {
        const source = {
          permissions: [
            ...permissions,
          ],
        };
        registry.validatePolicy({
          version: 1,
          views: [],
          backend: source,
        });
        const response = hostResponse(() => {
          if (!registry.allowed(source, call, matches)) {
            throw new BunawayError({
              code: "PERMISSION_DENIED",
              message: "Not allowed.",
            });
          }
          return adapters.execute(call.operation, call.payload, "backend");
        });
        expect(response).toMatchObject({
          kind: "error",
          error: {
            code,
          },
        });
      }
    } finally {
      await adapters.dispose();
    }
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
    });
  }
});

test("external plugins keep their own versions while SDK compatibility stays exact", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "bunaway-plugin-version-"));
  try {
    const plugin = resolve(root, "node_modules/@example/plugin-demo");
    const sdk = resolve(root, "node_modules/@bunaway/plugin");
    await mkdir(plugin, {
      recursive: true,
    });
    await mkdir(sdk, {
      recursive: true,
    });
    await writeJson(resolve(root, "package.json"), {
      dependencies: {
        "@example/plugin-demo": "1.2.3",
      },
    });
    const manifest = {
      name: "@example/plugin-demo",
      version: "1.2.3",
      type: "module",
      bunaway: {
        plugin: "plugin.json",
      },
      peerDependencies: {
        "@bunaway/plugin": "0.0.0",
      },
    };
    await writeJson(resolve(plugin, "package.json"), manifest);
    await writeJson(resolve(sdk, "package.json"), {
      name: "@bunaway/plugin",
      version: "0.0.0",
    });
    await writeJson(resolve(plugin, "plugin.json"), {
      format: 1,
      name: "demo",
      entry: "index.ts",
      platforms: {},
    });
    await Bun.write(
      resolve(plugin, "index.ts"),
      `export default {
      name: "demo", version: "1.2.3", native: {
        operations: [{ name: "demo.ping", input: { const: null }, output: { const: null }, permission: "demo:ping" }],
        permissions: [{ name: "demo:ping" }]
      }
    };`,
    );
    for (const field of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ]) {
      await writeJson(resolve(root, "package.json"), {
        [field]: {
          "@example/plugin-demo": "1.2.3",
        },
        optionalDependencies: {
          ...(field === "optionalDependencies"
            ? {
                "@example/plugin-demo": "1.2.3",
              }
            : {}),
          "@example/plugin-absent": "1.0.0",
        },
        ...(field === "peerDependencies"
          ? {
              peerDependencies: {
                "@example/plugin-demo": "1.2.3",
                "@example/plugin-absent-peer": "1.0.0",
              },
              peerDependenciesMeta: {
                "@example/plugin-absent-peer": {
                  optional: true,
                },
              },
            }
          : {}),
      });
      const installed = await installedPlugins(root, "0.0.0");
      expect(installed).toHaveLength(1);
      expect(installed[0]?.version).toBe("1.2.3");
    }
    await writeJson(resolve(plugin, "package.json"), {
      ...manifest,
      peerDependencies: {
        "@bunaway/plugin": "9.0.0",
      },
    });
    await expect(installedPlugins(root, "0.0.0")).rejects.toThrow(
      "Incompatible native plugin",
    );
    await writeJson(resolve(plugin, "package.json"), manifest);
    await writeJson(resolve(sdk, "package.json"), {
      name: "@bunaway/plugin",
      version: "9.0.0",
    });
    await expect(installedPlugins(root, "0.0.0")).rejects.toThrow(
      "Incompatible SDK/CLI",
    );
    await writeJson(resolve(root, "package.json"), {
      dependencies: {
        "@example/plugin-required": "1.0.0",
      },
      peerDependencies: {
        "@example/plugin-required": "1.0.0",
      },
      peerDependenciesMeta: {
        "@example/plugin-required": {
          optional: true,
        },
      },
    });
    await expect(installedPlugins(root, "0.0.0")).rejects.toThrow(
      "Missing installed @example/plugin-required",
    );
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
    });
  }
});

test("installed plugin catalog accepts multiple valid packages over the active runtime limit", async () => {
  const build = resolve(import.meta.dir, "../../build");
  await mkdir(build, {
    recursive: true,
  });
  const root = await mkdtemp(resolve(build, "plugin-catalog-"));
  try {
    const sdk = resolve(root, "node_modules/@bunaway/plugin");
    await mkdir(sdk, {
      recursive: true,
    });
    await writeJson(resolve(sdk, "package.json"), {
      name: "@bunaway/plugin",
      version: "0.0.0",
    });
    const dependencies: Record<string, string> = {};
    for (const name of [
      "first",
      "second",
    ]) {
      const packageName = `@example/plugin-${name}`;
      const plugin = resolve(root, "node_modules", packageName);
      await mkdir(plugin, {
        recursive: true,
      });
      dependencies[packageName] = "1.0.0";
      await writeJson(resolve(plugin, "package.json"), {
        name: packageName,
        version: "1.0.0",
        type: "module",
        bunaway: {
          plugin: "plugin.json",
        },
        peerDependencies: {
          "@bunaway/plugin": "0.0.0",
        },
      });
      await writeJson(resolve(plugin, "plugin.json"), {
        format: 1,
        name,
        entry: "index.ts",
        platforms: {},
      });
      const native = {
        operations: Array.from(
          {
            length: 150,
          },
          (_, index) => ({
            name: `${name}.call${index}`,
            input: {
              const: null,
            },
            output: {
              const: null,
            },
            permission: `${name}:call`,
          }),
        ),
        permissions: [
          {
            name: `${name}:call`,
          },
        ],
      };
      await Bun.write(
        resolve(plugin, "index.ts"),
        `export default ${JSON.stringify({
          name,
          version: "1.0.0",
          native,
        })};`,
      );
    }
    await writeJson(resolve(root, "package.json"), {
      dependencies,
    });

    const installed = await installedPlugins(root, "0.0.0");
    expect(installed).toHaveLength(2);
    expect(
      () =>
        new NativeRegistry(
          installed.map(({ name, version, native }) => ({
            name,
            version,
            native,
          })),
        ),
    ).toThrow("Plugin contract limit reached.");
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
    });
  }
});
