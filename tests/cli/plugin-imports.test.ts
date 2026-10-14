import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { frameworkRoot, writeJson } from "#cli/files";
import { buildPluginBundle } from "#cli/plugin-imports";

test.each([
  "browser",
  "bun",
] as const)(
  "local browser mappings and tsconfig aliases retain Bun's %s resolution",
  async (target) => {
    await mkdir(resolve(frameworkRoot, "build"), {
      recursive: true,
    });
    const root = await mkdtemp(
      resolve(frameworkRoot, "build/plugin-browser-maps-"),
    );
    try {
      await writeJson(resolve(root, "package.json"), {
        type: "module",
        imports: {
          "#helper": "./src/helper.ts",
          "#disabled": "./src/disabled.ts",
        },
        browser: {
          "./src/helper.ts": "./src/browser.ts",
          "#disabled": false,
        },
      });
      await writeJson(resolve(root, "tsconfig.json"), {
        compilerOptions: {
          paths: {
            "#alias": [
              "./src/alias.ts",
            ],
            "local-alias": [
              "./src/alias.ts",
            ],
          },
        },
      });
      for (const name of [
        "helper",
        "browser",
        "disabled",
        "alias",
      ]) {
        await Bun.write(
          resolve(root, `src/${name}.ts`),
          `export const value = ${JSON.stringify(name)};`,
        );
      }
      const entry = resolve(root, "src/index.ts");
      await Bun.write(
        entry,
        `
import * as helper from "#helper";
import * as disabled from "#disabled";
import {value as alias} from "#alias";
import {value as local} from "local-alias";
export default [helper.value, disabled, require("#helper").value, require("#disabled"), alias, local];
export const dynamic = () => import("#helper");
`,
      );
      const config = {
        entrypoints: [
          entry,
        ],
        target,
        format: "esm" as const,
      };
      const direct = await Bun.build(config);
      const built = await buildPluginBundle(root, {
        ...config,
        packages: "external",
      });
      expect(await built.outputs[0]?.text()).toBe(
        await direct.outputs[0]?.text(),
      );

      // Bun 1.4.2 rejects a disabled file reached through package imports. Preserve
      // that failure instead of silently bundling the disabled implementation.
      if (target === "browser") {
        // Use a fresh package scope so Bun cannot reuse a cached package.json.
        const blocked = resolve(root, "blocked");
        await mkdir(blocked);
        await writeJson(resolve(blocked, "package.json"), {
          type: "module",
          imports: {
            "#helper": "./src/helper.ts",
          },
          browser: {
            "./src/helper.ts": false,
          },
        });
        await Bun.write(
          resolve(blocked, "src/helper.ts"),
          'export const value = "DISABLED";',
        );
        const blockedEntry = resolve(blocked, "src/index.ts");
        await Bun.write(
          blockedEntry,
          'import * as helper from "#helper"; export default helper;',
        );
        const blockedConfig = {
          ...config,
          entrypoints: [
            blockedEntry,
          ],
        };
        await expect(Bun.build(blockedConfig)).rejects.toThrow();
        await expect(
          buildPluginBundle(blocked, {
            ...blockedConfig,
            packages: "external",
          }),
        ).rejects.toThrow();
      }
    } finally {
      await rm(root, {
        recursive: true,
        force: true,
      });
    }
  },
);

test.each([
  "browser",
  "bun",
] as const)(
  "package-import resolver matches Bun's %s conditions and package-map boundaries",
  async (target) => {
    await mkdir(resolve(frameworkRoot, "build"), {
      recursive: true,
    });
    const root = await mkdtemp(
      resolve(frameworkRoot, "build/plugin-import-maps-"),
    );
    try {
      await writeJson(resolve(root, "package.json"), {
        type: "module",
        imports: {
          "#nested": {
            [target]: {
              unavailable: "./src/missing.ts",
            },
            default: "./src/fallback.ts",
          },
          "#array": [
            "./src/fallback.ts",
            "./src/missing.ts",
          ],
          "#wild/*": "./src/general.ts",
          "#wild/exact/*": "./src/specific.ts",
          "#module": {
            module: "./src/module.ts",
            default: "./src/fallback.ts",
          },
          "#node": {
            node: "./src/node.ts",
            default: "./src/fallback.ts",
          },
          "#development": {
            development: "./src/development.ts",
            default: "./src/fallback.ts",
          },
          "#production": {
            production: "./src/production.ts",
            default: "./src/fallback.ts",
          },
          "#blocked": {
            [target]: null,
            default: "./src/fallback.ts",
          },
        },
      });
      for (const name of [
        "fallback",
        "general",
        "specific",
        "module",
        "node",
        "development",
        "production",
      ]) {
        await Bun.write(
          resolve(root, `src/${name}.ts`),
          `export const value = ${JSON.stringify(name)};`,
        );
      }
      const entry = resolve(root, "src/index.ts");
      await Bun.write(
        entry,
        `
import {value as nested} from "#nested";
import {value as array} from "#array";
import {value as wildcard} from "#wild/exact/item";
import {value as module} from "#module";
import {value as node} from "#node";
import {value as development} from "#development";
import {value as production} from "#production";
export default [nested, array, wildcard, module, node, development, production];
`,
      );
      const config = {
        entrypoints: [
          entry,
        ],
        target,
        format: "esm",
        metafile: true,
      } as const;
      const direct = await Bun.build({
        ...config,
        entrypoints: [
          entry,
        ],
      });
      const built = await buildPluginBundle(root, {
        ...config,
        entrypoints: [
          entry,
        ],
        packages: "external",
      });
      expect(direct.success).toBe(true);
      expect(built.success).toBe(true);
      expect(Object.keys(built.metafile?.inputs ?? {}).sort()).toEqual(
        Object.keys(direct.metafile?.inputs ?? {}).sort(),
      );
      expect(await built.outputs[0]?.text()).toBe(
        await direct.outputs[0]?.text(),
      );
      await Bun.write(entry, 'export {value} from "#blocked";');
      await expect(
        buildPluginBundle(root, {
          ...config,
          entrypoints: [
            entry,
          ],
          packages: "external",
        }),
      ).rejects.toThrow();
    } finally {
      await rm(root, {
        recursive: true,
        force: true,
      });
    }
  },
);
