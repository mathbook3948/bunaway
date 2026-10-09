import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadPluginCatalog } from "../../native/windows/bun/plugin-catalog.ts";
import { writeJson } from "../../packages/cli/src/files.ts";
import { writePluginAssets } from "../../packages/cli/src/plugins.ts";
import {
  parseAppManifest,
  readAppManifest,
} from "../../packages/runtime-bun/src/app-manifest.ts";

test("generated manifest rejects invalid versions, contracts, routing and SDK paths", () => {
  const manifest = {
    format: 1,
    app: {},
    policy: {},
    developmentSdk: {},
    plugins: [
      {
        name: "example",
        version: "1",
        native: {
          operations: [],
          permissions: [],
        },
        authorization: false,
      },
    ],
  };
  expect(parseAppManifest(manifest).plugins[0]?.name).toBe("example");
  for (const value of [
    {
      ...manifest,
      format: 2,
    },
    {
      ...manifest,
      app: [],
    },
    {
      ...manifest,
      policy: null,
    },
    {
      ...manifest,
      plugins: [
        {
          ...manifest.plugins[0],
          execution: "main",
        },
      ],
    },
    {
      ...manifest,
      plugins: [
        {
          ...manifest.plugins[0],
          native: {
            operations: [],
          },
        },
      ],
    },
    {
      ...manifest,
      plugins: [
        ...manifest.plugins,
        ...manifest.plugins,
      ],
    },
    {
      ...manifest,
      developmentSdk: {
        "@bunaway/backend": "../../other.js",
      },
    },
  ]) {
    expect(() => parseAppManifest(value)).toThrow();
  }
});

test("regeneration preserves app data, drops removed plugins and rejects mismatched import modules", async () => {
  const assets = await mkdtemp(resolve(tmpdir(), "bunaway-app-manifest-"));
  try {
    await writeJson(resolve(assets, "manifest.json"), {
      format: 1,
      app: {
        title: "Example",
      },
      policy: {},
      plugins: [],
      developmentSdk: {
        example: "sdk0.js",
      },
    });
    const plugins = [
      {
        name: "example",
        version: "1",
        packageName: "example",
        root: assets,
        native: {
          operations: [],
          permissions: [],
        },
        targets: {},
      },
    ];
    const generated = await writePluginAssets(assets, plugins);
    const source = await Bun.file(generated).text();
    expect(source).not.toContain("version");
    expect(source).not.toContain("native");
    await Bun.write(resolve(assets, "plugin-imports.js"), source);
    const imports = (
      await import(pathToFileURL(resolve(assets, "plugin-imports.js")).href)
    ).pluginImports;
    expect((await loadPluginCatalog(assets, imports))[0]?.name).toBe("example");
    const manifest = await readAppManifest(assets);
    expect(manifest.app).toEqual({
      title: "Example",
    });
    expect(manifest.developmentSdk).toEqual({});
    await writeJson(resolve(assets, "manifest.json"), {
      ...manifest,
      plugins: [
        {
          ...manifest.plugins[0],
          execution: "ui",
        },
      ],
    });
    await expect(loadPluginCatalog(assets, imports)).rejects.toThrow(
      "Generated plugin imports do not match",
    );
    await writeJson(resolve(assets, "manifest.json"), {
      ...manifest,
      plugins: [
        {
          ...manifest.plugins[0],
          name: "toString",
        },
      ],
    });
    await expect(loadPluginCatalog(assets, imports)).rejects.toThrow(
      "Generated plugin imports do not match",
    );
    await writePluginAssets(assets, []);
    expect((await readAppManifest(assets)).plugins).toEqual([]);
    expect(await Bun.file(generated).text()).not.toContain("example");
  } finally {
    await rm(assets, {
      recursive: true,
      force: true,
    });
  }
});

test("installed manifest catalogs preserve per-plugin limits without a combined wire-message limit", () => {
  const plugins = Array.from(
    {
      length: 3,
    },
    (_, index) => ({
      name: `example${index}`,
      version: "1",
      authorization: false,
      native: {
        operations: [
          {
            name: `example${index}.read`,
            permission: `example${index}:read`,
            input: {
              const: null,
            },
            output: {
              const: "x".repeat(400000),
            },
          },
        ],
        permissions: [
          {
            name: `example${index}:read`,
          },
        ],
      },
    }),
  );
  expect(
    parseAppManifest({
      format: 1,
      app: {},
      policy: {},
      plugins,
      developmentSdk: {},
    }).plugins,
  ).toHaveLength(3);
});
