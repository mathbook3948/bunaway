import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { writeJson } from "../../packages/cli/src/files.ts";
import { installedPlugins } from "../../packages/cli/src/plugins.ts";
import { NativeRegistry } from "../../packages/protocol/src/index.ts";

test("external plugins keep their own versions while SDK compatibility stays exact", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "bunaway-plugin-version-"));
  try {
    const plugin = resolve(root, "node_modules/@example/plugin-demo");
    const sdk = resolve(root, "node_modules/@bunaway/plugin");
    await mkdir(plugin, { recursive: true });
    await mkdir(sdk, { recursive: true });
    await writeJson(resolve(root, "package.json"), {
      dependencies: { "@example/plugin-demo": "1.2.3" },
    });
    const manifest = {
      name: "@example/plugin-demo",
      version: "1.2.3",
      type: "module",
      bunaway: { plugin: "plugin.json" },
      peerDependencies: { "@bunaway/plugin": "0.0.0" },
    };
    await writeJson(resolve(plugin, "package.json"), manifest);
    await writeJson(resolve(sdk, "package.json"), { name: "@bunaway/plugin", version: "0.0.0" });
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
    expect((await installedPlugins(root, "0.0.0"))[0]?.version).toBe("1.2.3");
    await writeJson(resolve(plugin, "package.json"), {
      ...manifest,
      peerDependencies: { "@bunaway/plugin": "9.0.0" },
    });
    await expect(installedPlugins(root, "0.0.0")).rejects.toThrow("Incompatible native plugin");
    await writeJson(resolve(plugin, "package.json"), manifest);
    await writeJson(resolve(sdk, "package.json"), { name: "@bunaway/plugin", version: "9.0.0" });
    await expect(installedPlugins(root, "0.0.0")).rejects.toThrow("Incompatible SDK/CLI");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("installed plugin catalog accepts multiple valid packages over the active runtime limit", async () => {
  const build = resolve(import.meta.dir, "../../build");
  await mkdir(build, { recursive: true });
  const root = await mkdtemp(resolve(build, "plugin-catalog-"));
  try {
    const sdk = resolve(root, "node_modules/@bunaway/plugin");
    await mkdir(sdk, { recursive: true });
    await writeJson(resolve(sdk, "package.json"), { name: "@bunaway/plugin", version: "0.0.0" });
    const dependencies: Record<string, string> = {};
    for (const name of ["first", "second"]) {
      const packageName = `@example/plugin-${name}`;
      const plugin = resolve(root, "node_modules", packageName);
      await mkdir(plugin, { recursive: true });
      dependencies[packageName] = "1.0.0";
      await writeJson(resolve(plugin, "package.json"), {
        name: packageName,
        version: "1.0.0",
        type: "module",
        bunaway: { plugin: "plugin.json" },
        peerDependencies: { "@bunaway/plugin": "0.0.0" },
      });
      await writeJson(resolve(plugin, "plugin.json"), {
        format: 1,
        name,
        entry: "index.ts",
        platforms: {},
      });
      const native = {
        operations: Array.from({ length: 150 }, (_, index) => ({
          name: `${name}.call${index}`,
          input: { const: null },
          output: { const: null },
          permission: `${name}:call`,
        })),
        permissions: [{ name: `${name}:call` }],
      };
      await Bun.write(
        resolve(plugin, "index.ts"),
        `export default ${JSON.stringify({ name, version: "1.0.0", native })};`,
      );
    }
    await writeJson(resolve(root, "package.json"), { dependencies });

    const installed = await installedPlugins(root, "0.0.0");
    expect(installed).toHaveLength(2);
    expect(
      () =>
        new NativeRegistry(
          installed.map(({ name, version, native }) => ({ name, version, native })),
        ),
    ).toThrow("Plugin contract limit reached.");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
