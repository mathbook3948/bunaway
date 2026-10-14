import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PLATFORMS } from "@bunaway/plugin-api";
import { frameworkRoot, writeJson } from "#cli/files";
import { buildNativePlugin } from "#cli/plugin-build";
import { readPluginDeclaration } from "#cli/plugins";

test.each([
  ".ts",
  "",
  ".js",
  "#",
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
      const manifest = {
        name: "test-plugin",
        version: "1",
        type: "module",
        imports: {
          "#demo/*": {
            types: "./dist/types/*.d.ts",
            default: "./src/*.ts",
          },
        },
      };
      await writeJson(resolve(root, "package.json"), manifest);
      await writeJson(resolve(root, "tsconfig.json"), {
        extends: resolve(frameworkRoot, "tsconfig.base.json"),
        compilerOptions: {
          rootDir: "./src",
          outDir: "./dist/types",
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
export const operations = { read: { input: z.null(), output: z.string().transform(value => value + "!") } } as const;`,
      );
      const unified = extension === ".ts" || extension === "#";
      const prefix = extension === "#" ? "#demo" : ".";
      const suffix = extension === "#" ? "" : extension;
      const imports = PLATFORMS.map((platform) =>
        unified
          ? `import { initialize as ${platform}, dispose as ${platform}Dispose } from "${prefix}/platforms/${platform}${suffix}";`
          : `import { createOperations as ${platform} } from "${prefix}/platforms/${platform}${suffix}";`,
      ).join("\n");
      const targets = PLATFORMS.map((platform) =>
        unified
          ? `${platform}: { initialize: ${platform}, dispose: ${platform}Dispose, operations: {read: defineNativeOperation<ReturnType<typeof ${platform}>>()({...operations.read, handler: (_input, {instance}) => instance.value})} }`
          : `${platform}: { thread: "worker", create: ${platform} }`,
      ).join(", ");
      const source = `import { defineNativeOperation, defineNativePlugin } from "@bunaway/plugin";
import { operations } from "${prefix}/contract${suffix}";
${imports}
const plugin = defineNativePlugin({ name: "demo", ${unified ? "" : "operations,"} platforms: { ${targets} } });
export const api = plugin;
export default plugin;`;
      await Bun.write(entry, source);
      await Bun.write(
        resolve(root, "src/platforms/windows.ts"),
        unified
          ? `import { dlopen } from "bun:ffi";
export function initialize() { const api = dlopen("kernel32.dll", {}); return { value: "WINDOWS_ONLY_MARKER", api }; }
export function dispose(instance: ReturnType<typeof initialize>) { instance.api.close(); }`
          : `import { dlopen } from "bun:ffi";
import type { NativeAdapterFactory } from "@bunaway/plugin";
export const createOperations: NativeAdapterFactory = () => { const api = dlopen("kernel32.dll", {}); return { execute: () => "WINDOWS_ONLY_MARKER", dispose: () => api.close() }; };`,
      );
      for (const platform of PLATFORMS) {
        if (platform === "windows") {
          continue;
        }
        await Bun.write(
          resolve(root, "src/platforms", `${platform}.ts`),
          unified
            ? `export function initialize() { return {value:"${platform.toUpperCase()}_ONLY_MARKER"}; }
export function dispose(_instance: ReturnType<typeof initialize>) {}`
            : `import type { NativeAdapterFactory } from "@bunaway/plugin";
export const createOperations: NativeAdapterFactory = () => ({ execute: () => "${platform.toUpperCase()}_ONLY_MARKER", dispose() {} });`,
        );
      }
      expect(await buildNativePlugin(root)).toBe(resolve(root, "dist"));
      const neutral = await Bun.file(resolve(root, "dist/index.js")).text();
      expect(neutral).not.toContain("bun:ffi");
      expect(neutral).not.toContain("kernel32.dll");
      expect(neutral).not.toContain("ONLY_MARKER");
      expect(neutral).not.toContain('from "#demo/');
      const browser = await Bun.build({
        entrypoints: [
          resolve(root, "dist/index.js"),
        ],
        target: "browser",
        packages: "external",
      });
      expect(browser.success).toBe(true);
      for (const platform of PLATFORMS) {
        const bundle = await Bun.file(
          resolve(root, "dist/native", `${platform}.js`),
        ).text();
        expect(bundle).not.toContain('from "#demo/');
        for (const other of PLATFORMS) {
          const marker = `${other.toUpperCase()}_ONLY_MARKER`;
          if (other === platform) {
            expect(bundle).toContain(marker);
          } else {
            expect(bundle).not.toContain(marker);
          }
        }
        if (platform !== "windows") {
          expect(bundle).not.toContain("bun:ffi");
        }
      }
      const outputs = [
        "index.js",
        ...PLATFORMS.map((platform) => `native/${platform}.js`),
      ];
      // Importing every output is portable; factories remain untouched until host activation.
      const child = Bun.spawn(
        [
          process.execPath,
          "-e",
          `for (const file of ${JSON.stringify(outputs)}) { const { default: plugin } = await import(new URL(file, ${JSON.stringify(`${pathToFileURL(resolve(root, "dist/")).href}/`)})); if (plugin._definition.version !== "1" || !Object.isFrozen(plugin)) throw new Error("Invalid built plugin version"); if (file === "native/linux.js") { const adapter = plugin._definition.nativePlatforms.linux.create({dataRoot:".",capabilities:[]}); try { if (await adapter.execute("demo.read", null, "test") !== "LINUX_ONLY_MARKER!") throw new Error("Built parser did not run exactly once"); } finally { adapter.dispose(); } } }`,
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
      if (unified) {
        await Bun.write(
          entry,
          source.replaceAll("=> instance.value", "=> 123"),
        );
        await expect(buildNativePlugin(root)).rejects.toThrow("failed");
        expect(await Bun.file(resolve(root, "dist/index.js")).text()).toBe(
          neutral,
        );
        await Bun.write(entry, source);
      }
      await writeJson(resolve(root, "package.json"), {
        ...manifest,
        version: "2",
      });
      await buildNativePlugin(root);
      const updated = await Bun.file(resolve(root, "dist/index.js")).text();
      expect(updated).not.toBe(neutral);
      for (const file of outputs) {
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
          ...manifest,
          version,
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

test("handler map support survives neutral and opposite-platform exports without running setup", async () => {
  const root = await mkdtemp(resolve(frameworkRoot, "build/plugin-handlers-"));
  try {
    await mkdir(resolve(root, "src/platforms"), {
      recursive: true,
    });
    await writeJson(resolve(root, "package.json"), {
      name: "handler-plugin",
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
    await Bun.write(
      resolve(root, "src/contract.ts"),
      `import {z} from "zod"; export const operations = {
      read:{input:z.string(),output:z.string()},write:{input:z.string(),output:z.number()}
    };`,
    );
    await Bun.write(
      resolve(root, "src/index.ts"),
      `import {defineNativePlugin} from "@bunaway/plugin";
      import {operations} from "./contract.ts";
      import {createOperations as windows} from "./platforms/windows.ts";
      import {createOperations as macos} from "./platforms/macos.ts";
      export default defineNativePlugin({name:"demo",operations,platforms:{windows:{thread:"ui",create:windows},macos:{thread:"worker",create:macos}}});`,
    );
    for (const [platform, key, result] of [
      [
        "windows",
        "read",
        'input+"WINDOWS_ONLY"',
      ],
      [
        "macos",
        "write",
        "input.length",
      ],
    ]) {
      await Bun.write(
        resolve(root, "src/platforms", `${platform}.ts`),
        `import {defineNativeAdapter} from "@bunaway/plugin";
        import {operations} from "../contract.ts";
        export const createOperations = defineNativeAdapter(operations,{
          setup(){throw new Error("Setup must not run during declaration inspection");},
          handlers:{${key}(input){return ${result};}},dispose(){}
        });`,
      );
    }
    await buildNativePlugin(root);
    for (const entry of [
      "index.js",
      "native/windows.js",
      "native/macos.js",
    ]) {
      const declaration = await readPluginDeclaration(
        resolve(root, "dist", entry),
        root,
      );
      expect(declaration.nativePlatforms.windows?.operations).toEqual([
        "read",
      ]);
      expect(declaration.nativePlatforms.macos?.operations).toEqual([
        "write",
      ]);
    }
    const neutral = await Bun.file(resolve(root, "dist/index.js")).text();
    expect(neutral).not.toContain("WINDOWS_ONLY");
    expect(neutral).not.toContain("Setup must not run");
    const native = await Bun.file(resolve(root, "dist/native/macos.js")).text();
    expect(native).not.toContain("WINDOWS_ONLY");
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
    });
  }
});

test("platform objects and re-exports preserve native schemas without leaking implementation types", async () => {
  const root = await mkdtemp(resolve(frameworkRoot, "build/plugin-exports-"));
  try {
    await mkdir(resolve(root, "src/platforms"), {
      recursive: true,
    });
    await writeJson(resolve(root, "package.json"), {
      name: "exports-plugin",
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
    await Bun.write(
      resolve(root, "src/platforms/implementation.ts"),
      `
import { defineNativeOperation } from "@bunaway/plugin";
import { z } from "zod";
class PrivateNativeState { read(value: string) { return value + "NATIVE_IMPLEMENTATION"; } }
export function initialize() { return new PrivateNativeState(); }
export const operations = {
  read: defineNativeOperation<PrivateNativeState>()({
    input: z.string().transform(async value => value + "INPUT_TRANSFORM"),
    output: z.string().transform(async value => value + "OUTPUT_TRANSFORM"),
    handler: (input, {instance}) => instance.read(input),
  }),
};
export default operations;
`,
    );
    await Bun.write(
      resolve(root, "src/platforms/windows.ts"),
      'export * from "./implementation.ts"; export {default} from "./implementation.ts";',
    );
    await Bun.write(
      resolve(root, "src/index.ts"),
      `
import {defineNativePlugin} from "@bunaway/plugin";
import operations, {initialize as start} from "./platforms/windows.ts";
const plugin = defineNativePlugin({name:"demo",platforms:{windows:{initialize:start,operations}}});
export const api = plugin;
export default plugin;
`,
    );
    await buildNativePlugin(root);
    const neutral = await Bun.file(resolve(root, "dist/index.js")).text();
    for (const marker of [
      "NATIVE_IMPLEMENTATION",
      "INPUT_TRANSFORM",
      "OUTPUT_TRANSFORM",
    ]) {
      expect(neutral).not.toContain(marker);
    }
    const declaration = await Bun.file(
      resolve(root, "dist/types/index.d.ts"),
    ).text();
    for (const marker of [
      "PrivateNativeState",
      "initialize",
      "handler",
      "Zod",
      "platforms/",
    ]) {
      expect(declaration).not.toContain(marker);
    }
    expect(declaration).toContain("input: string");
    expect(declaration).toContain("Promise<string>");
    const { default: plugin } = await import(
      pathToFileURL(resolve(root, "dist/native/windows.js")).href
    );
    const adapter = plugin._definition.nativePlatforms.windows.create({
      dataRoot: root,
      capabilities: [],
    });
    try {
      expect(await adapter.execute("demo.read", "start", "backend")).toBe(
        "startINPUT_TRANSFORMNATIVE_IMPLEMENTATIONOUTPUT_TRANSFORM",
      );
      await expect(
        adapter.execute("demo.read", 42, "backend"),
      ).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
    } finally {
      await adapter.dispose();
    }
    await Bun.write(
      resolve(root, "src/platforms/windows.ts"),
      'export * from "./implementation.ts"; export {default} from "./implementation.ts"; export const invalid = new Map();',
    );
    await expect(buildNativePlugin(root)).rejects.toThrow();
    expect(await Bun.file(resolve(root, "dist/index.js")).text()).toBe(neutral);
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
    });
  }
}, 30000);
