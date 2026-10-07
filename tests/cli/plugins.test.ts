import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { writeJson } from "../../packages/cli/src/files.ts";
import { installedPlugins } from "../../packages/cli/src/plugins.ts";

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
