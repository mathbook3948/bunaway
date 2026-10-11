import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { hostResponse } from "#native/host-api/bun/host-response";
import { loadPluginCatalog } from "#native/host-api/bun/plugin-catalog";
import { operations, pluginRegistry } from "#native/host-api/bun/plugins";
import { pluginImportsSource } from "#cli/app-modules";
import { writeJson } from "#cli/files";
import { installedPlugins, writePluginManifest } from "#cli/plugins";
import { BunawayError, NativeRegistry, type Policy } from "@bunaway/protocol";

test.each([
  "io",
  "ui",
] as const)(
  "single-entry discovery preserves lazy %s adapters and partial support",
  async (execution) => {
    const root = await mkdtemp(
      resolve(tmpdir(), "bunaway-plugin-declaration-"),
    );
    try {
      const plugin = resolve(root, "node_modules/@example/plugin-demo");
      await mkdir(resolve(plugin, "src"), {
        recursive: true,
      });
      await mkdir(resolve(root, "node_modules/@bunaway/plugin"), {
        recursive: true,
      });
      await writeJson(resolve(root, "package.json"), {
        dependencies: {
          "@example/plugin-demo": "1",
        },
      });
      await writeJson(
        resolve(root, "node_modules/@bunaway/plugin/package.json"),
        {
          name: "@bunaway/plugin",
          version: "0.0.0",
        },
      );
      await writeJson(resolve(plugin, "package.json"), {
        name: "@example/plugin-demo",
        version: "1",
        type: "module",
        exports: {
          ".": "./src/index.ts",
          "./native/windows": "./src/index.ts",
        },
        bunaway: {
          plugin: "./src/index.ts",
        },
        peerDependencies: {
          "@bunaway/plugin": "0.0.0",
        },
      });
      const native = {
        operations: [
          "read",
          "write",
        ].map((name) => ({
          name: `demo.${name}`,
          input: {
            const: null,
          },
          output: {},
        })),
      };
      const entry = resolve(plugin, "src/index.ts");
      const declaration = {
        name: "demo",
        version: "1",
        native,
        nativePlatforms: {
          windows: {
            execution,
            create: "factory",
            operations: [
              "read",
            ],
          },
        },
      };
      const marker = resolve(root, "initialized");
      await Bun.write(
        entry,
        `import { createOperations } from "./windows.ts"; export default ${JSON.stringify(declaration).replaceAll('"factory"', "createOperations")};`,
      );
      await Bun.write(
        resolve(plugin, "src/windows.ts"),
        `import { writeFileSync } from "node:fs";
      export function createOperations(environment) {
        writeFileSync(${JSON.stringify(marker)}, "created");
        return { execute: () => environment.capabilities, dispose() {} };
      }`,
      );
      const installed = await installedPlugins(root, "0.0.0");
      expect(installed[0]?.root).toBe(await realpath(plugin));
      expect(installed[0]?.targets.windows?.operations).toBe(
        await realpath(entry),
      );
      expect(installed[0]?.targets.windows?.supportedOperations).toEqual([
        "demo.read",
      ]);
      expect(await Bun.file(marker).exists()).toBe(false);
      await writePluginManifest(root, installed);
      await Bun.write(
        resolve(root, "imports.js"),
        pluginImportsSource(installed),
      );
      const catalog = await loadPluginCatalog(
        root,
        (await import(pathToFileURL(resolve(root, "imports.js")).href))
          .pluginImports,
      );
      const inactive = await operations(
        [],
        root,
        execution,
        undefined,
        catalog,
      );
      await inactive.dispose();
      expect(await Bun.file(marker).exists()).toBe(false);
      const adapter = await operations(
        installed,
        root,
        execution,
        undefined,
        catalog,
      );
      try {
        expect(await Bun.file(marker).exists()).toBe(true);
        expect(adapter.execute("demo.read", null, "backend")).toEqual([
          {
            name: "demo.read",
            support: "supported",
          },
          {
            name: "demo.write",
            support: "unsupported",
          },
        ]);
        expect(() => adapter.execute("demo.write", null, "backend")).toThrow(
          expect.objectContaining({
            code: "UNSUPPORTED",
          }),
        );
        await expect(
          adapter.executeUI("demo.write", null, "backend", {
            requestId: "1",
            permissions: {
              permissions: [],
            },
          }),
        ).rejects.toMatchObject({
          code: "UNSUPPORTED",
        });
      } finally {
        await adapter.dispose();
      }

      await Bun.write(
        entry,
        `import { createOperations } from "./windows.ts"; export default ${JSON.stringify(
          {
            ...declaration,
            nativePlatforms: {
              windows: {
                execution,
                create: "factory",
                operations: [],
              },
            },
          },
        ).replaceAll('"factory"', "createOperations")};`,
      );
      const empty = await installedPlugins(root, "0.0.0");
      await writePluginManifest(root, empty);
      const loadOperations = catalog[0]?.operations;
      if (!loadOperations) {
        throw new Error("Missing fixture adapter.");
      }
      const emptyCatalog = await loadPluginCatalog(root, {
        demo: {
          operations: loadOperations,
        },
      });
      const emptyAdapter = await operations(
        empty,
        root,
        execution,
        undefined,
        emptyCatalog,
      );
      try {
        expect(() =>
          emptyAdapter.execute("demo.read", null, "backend"),
        ).toThrow(
          expect.objectContaining({
            code: "UNSUPPORTED",
          }),
        );
      } finally {
        await emptyAdapter.dispose();
      }

      // In-package links resolve to the same native entry; links outside the package remain denied below.
      await symlink(
        resolve(plugin, "src"),
        resolve(plugin, "linked-src"),
        process.platform === "win32" ? "junction" : "dir",
      );
      const manifestPath = resolve(plugin, "package.json");
      const manifest = await Bun.file(manifestPath).json();
      await writeJson(manifestPath, {
        ...manifest,
        exports: {
          ".": "./src/index.ts",
          "./native/windows": "./linked-src/index.ts",
        },
      });
      const linked = await installedPlugins(root, "0.0.0");
      expect(linked[0]?.targets.windows?.operations).toBe(
        await realpath(entry),
      );
      await writeJson(manifestPath, manifest);

      for (const target of [
        {
          execution: "other",
          create: "factory",
        },
        {
          execution,
          create: null,
        },
        {
          execution,
          create: "factory",
          operations: [
            "missing",
          ],
        },
        {
          execution,
          create: "factory",
          operations: [
            "read",
            "read",
          ],
        },
      ]) {
        await Bun.write(
          entry,
          `import { createOperations } from "./windows.ts"; export default ${JSON.stringify(
            {
              ...declaration,
              nativePlatforms: {
                windows: target,
              },
            },
          ).replaceAll('"factory"', "createOperations")};`,
        );
        await expect(installedPlugins(root, "0.0.0")).rejects.toThrow();
      }
      const outside = resolve(root, "outside");
      await mkdir(outside);
      await Bun.write(
        resolve(outside, "windows.ts"),
        "throw new Error('must not import');",
      );
      await symlink(
        outside,
        resolve(plugin, "src/escape"),
        process.platform === "win32" ? "junction" : "dir",
      );
      await Bun.write(
        entry,
        `import { createOperations } from "./windows.ts"; export default ${JSON.stringify(
          {
            ...declaration,
            nativePlatforms: {
              windows: {
                execution,
                create: "factory",
              },
            },
          },
        ).replaceAll('"factory"', "createOperations")};`,
      );
      await writeJson(manifestPath, {
        ...(await Bun.file(manifestPath).json()),
        exports: {
          ".": "./src/index.ts",
          "./native/windows": "./src/escape/windows.ts",
        },
      });
      await expect(installedPlugins(root, "0.0.0")).rejects.toThrow(
        "installed package",
      );
    } finally {
      await rm(root, {
        recursive: true,
        force: true,
      });
    }
  },
);

test("plugins without a Windows adapter check operation grants before returning UNSUPPORTED", async () => {
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
        plugin: "index.ts",
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
    await Bun.write(
      resolve(plugin, "index.ts"),
      `export default {
      name: "files", version: "1.0.0", nativePlatforms: {}, native: {
        operations: [{ name: "files.read", input: { type: "string" }, output: { type: "string" } }]
      }
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
            "files.read",
          ],
          "UNSUPPORTED",
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
          if (!registry.allowed(source, call)) {
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
        plugin: "index.ts",
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
    await Bun.write(
      resolve(plugin, "index.ts"),
      `export default {
      name: "demo", version: "1.2.3", nativePlatforms: {}, native: {
        operations: [{ name: "demo.ping", input: { const: null }, output: { const: null } }]
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
          plugin: "index.ts",
        },
        peerDependencies: {
          "@bunaway/plugin": "0.0.0",
        },
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
          }),
        ),
      };
      await Bun.write(
        resolve(plugin, "index.ts"),
        `export default ${JSON.stringify({
          name,
          version: "1.0.0",
          nativePlatforms: {},
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
