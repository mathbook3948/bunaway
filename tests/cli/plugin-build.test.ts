import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { frameworkRoot, writeJson } from "#cli/files";
import { buildNativePlugin } from "#cli/plugin-build";
import { readPluginDeclaration } from "#cli/plugins";

test.each([
  ".ts",
  "",
  ".js",
])(
  "plugin build separates OS code and preserves output on failure (extension %j)",
  async (extension) => {
    await mkdir(resolve(frameworkRoot, "build"), {
      recursive: true,
    });
    const root = await mkdtemp(
      resolve(frameworkRoot, "build/plugin-build-test-"),
    );
    try {
      await mkdir(resolve(root, "src/platforms"), {
        recursive: true,
      });
      await writeJson(resolve(root, "package.json"), {
        name: "test-plugin",
        version: "1",
        type: "module",
      });
      await writeJson(resolve(root, "tsconfig.json"), {
        extends: resolve(frameworkRoot, "tsconfig.base.json"),
        compilerOptions: {
          types: [
            "bun",
          ],
        },
        include: [
          "src/**/*.ts",
        ],
      });
      const entry = resolve(root, "src/index.ts");
      await Bun.write(
        resolve(root, "src/contract.ts"),
        `import { z } from "zod";
export const operations = { read: { input: z.null(), output: z.string() } } as const;`,
      );
      const source = `import { defineNativePlugin } from "@bunaway/plugin";
import { operations } from "./contract.ts";
import { createOperations as windows } from "./platforms/windows${extension}";
import { createOperations as macos } from "./platforms/macos${extension}";
const plugin = defineNativePlugin({ name: "demo", operations, platforms: { windows: { execution: "io", create: windows }, macos: { execution: "io", create: macos } } });
export const api = plugin.api;
export default plugin.definition;`;
      await Bun.write(entry, source);
      await Bun.write(
        resolve(root, "src/platforms/windows.ts"),
        `import { dlopen } from "bun:ffi";
import type { NativeAdapterFactory } from "@bunaway/plugin";
export const createOperations: NativeAdapterFactory = () => { const api = dlopen("kernel32.dll", {}); return { execute: () => "WINDOWS_ONLY_MARKER", dispose: () => api.close() }; };`,
      );
      await Bun.write(
        resolve(root, "src/platforms/macos.ts"),
        `import type { NativeAdapterFactory } from "@bunaway/plugin";
export const createOperations: NativeAdapterFactory = () => ({ execute: () => "MACOS_ONLY_MARKER", dispose() {} });`,
      );
      expect(await buildNativePlugin(root)).toBe(resolve(root, "dist"));
      const neutral = await Bun.file(resolve(root, "dist/index.js")).text();
      expect(neutral).not.toContain("bun:ffi");
      expect(neutral).not.toContain("kernel32.dll");
      expect(neutral).not.toContain("ONLY_MARKER");
      const browser = await Bun.build({
        entrypoints: [
          resolve(root, "dist/index.js"),
        ],
        target: "browser",
        packages: "external",
      });
      expect(browser.success).toBe(true);
      const windows = await Bun.file(
        resolve(root, "dist/native/windows.js"),
      ).text();
      expect(windows).toContain("WINDOWS_ONLY_MARKER");
      expect(windows).not.toContain("MACOS_ONLY_MARKER");
      const macos = await Bun.file(
        resolve(root, "dist/native/macos.js"),
      ).text();
      expect(macos).toContain("MACOS_ONLY_MARKER");
      expect(macos).not.toContain("bun:ffi");
      // Importing every output is portable; factories remain untouched until host activation.
      const child = Bun.spawn(
        [
          process.execPath,
          "-e",
          `for (const file of ["index.js", "native/windows.js", "native/macos.js"]) { const { default: plugin } = await import(new URL(file, ${JSON.stringify(`${pathToFileURL(resolve(root, "dist/")).href}/`)})); if (plugin.version !== "1" || !Object.isFrozen(plugin)) throw new Error("Invalid built plugin version"); }`,
        ],
        {
          cwd: root,
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const errors = new Response(child.stderr).text();
      expect(await child.exited).toBe(0);
      expect(await errors).toBe("");
      expect(
        await Bun.file(resolve(root, "dist/types/index.d.ts")).exists(),
      ).toBe(true);
      await Bun.write(entry, `${source}\nconst invalid: string = 123;`);
      await expect(buildNativePlugin(root)).rejects.toThrow("failed");
      expect(await Bun.file(resolve(root, "dist/index.js")).text()).toBe(
        neutral,
      );
      await Bun.write(entry, source);
      await writeJson(resolve(root, "package.json"), {
        name: "test-plugin",
        version: "2",
        type: "module",
      });
      await buildNativePlugin(root);
      const updated = await Bun.file(resolve(root, "dist/index.js")).text();
      expect(updated).not.toBe(neutral);
      for (const file of [
        "index.js",
        "native/windows.js",
        "native/macos.js",
      ]) {
        expect(
          (await readPluginDeclaration(resolve(root, "dist", file), root))
            .version,
        ).toBe("2");
      }
      for (const version of [
        undefined,
        null,
        123,
        "",
      ]) {
        await writeJson(resolve(root, "package.json"), {
          name: "test-plugin",
          version,
          type: "module",
        });
        await expect(buildNativePlugin(root)).rejects.toThrow(
          "package.json version",
        );
        expect(await Bun.file(resolve(root, "dist/index.js")).text()).toBe(
          updated,
        );
      }
      expect(
        (await readdir(root)).some((name) => name.startsWith(".plugin-build-")),
      ).toBe(false);
    } finally {
      await rm(root, {
        recursive: true,
        force: true,
      });
    }
  },
  30000,
);
