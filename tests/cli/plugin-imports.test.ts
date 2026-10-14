import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { frameworkRoot, writeJson } from "#cli/files";
import { buildPluginBundle } from "#cli/plugin-imports";

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
