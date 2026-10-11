import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadPluginCatalog } from "#native/host-api/bun/plugin-catalog";
import { pluginImportsSource } from "#cli/app-modules";
import { writeJson } from "#cli/files";
import { writePluginManifest } from "#cli/plugins";
import {
  type JsonValue,
  MAX_JSON_DEPTH,
  MAX_MESSAGE_BYTES,
  NativeRegistry,
  validateValue,
} from "@bunaway/protocol";
import {
  parseAppManifest,
  readAppManifest,
} from "@bunaway/runtime-bun/app-manifest";

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
        },
      },
    ],
  };
  expect(parseAppManifest(manifest).plugins[0]?.name).toBe("example");
  for (const value of [
    {
      ...manifest,
      plugins: [
        {
          ...manifest.plugins[0],
          execution: "io",
          supportedOperations: [
            "example.missing",
          ],
        },
      ],
    },
    {
      ...manifest,
      plugins: [
        {
          ...manifest.plugins[0],
          supportedOperations: [],
        },
      ],
    },
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
      policy: [],
    },
    {
      format: 1,
      app: {},
      plugins: [],
      developmentSdk: {},
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
            operations: {},
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

test.each([
  "size",
  "depth",
])(
  "manifest preserves the policy JSON %s budget before policy validation",
  async (boundary) => {
    const assets = await mkdtemp(resolve(tmpdir(), "bunaway-policy-boundary-"));
    const policy: {
      value: JsonValue;
    } = {
      value: "",
    };
    if (boundary === "size") {
      policy.value = "x".repeat(
        MAX_MESSAGE_BYTES - Buffer.byteLength(JSON.stringify(policy)),
      );
    } else {
      for (let depth = 1; depth < MAX_JSON_DEPTH; depth++) {
        policy.value = {
          child: policy.value,
        };
      }
    }
    const plugin = {
      name: "example",
      version: "1",
      native: {
        operations: [],
      },
      packageName: "example",
      root: assets,
      targets: {},
    };
    const manifest = {
      format: 1,
      app: {},
      policy,
      plugins: [],
      developmentSdk: {},
    };
    try {
      // The manifest preflights JSON independently; the app's policy validator runs separately.
      validateValue(
        {
          type: "object",
        },
        policy,
      );
      expect(parseAppManifest(manifest).policy).toEqual(policy);
      await writeJson(resolve(assets, "manifest.json"), manifest);
      await writePluginManifest(assets, [
        plugin,
      ]);
      expect((await readAppManifest(assets)).policy).toEqual(policy);
      expect(
        await loadPluginCatalog(assets, {
          example: {},
        }),
      ).toHaveLength(1);
      policy.value =
        boundary === "size"
          ? `${policy.value}x`
          : {
              child: policy.value,
            };
      expect(() =>
        validateValue(
          {
            type: "object",
          },
          policy,
        ),
      ).toThrow();
      expect(() => parseAppManifest(manifest)).toThrow();
      await writeJson(resolve(assets, "manifest.json"), manifest);
      await expect(
        writePluginManifest(assets, [
          plugin,
        ]),
      ).rejects.toThrow();
    } finally {
      await rm(assets, {
        recursive: true,
        force: true,
      });
    }
  },
);

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
        },
        targets: {},
      },
    ];
    await writePluginManifest(assets, plugins);
    expect(await readdir(assets)).toEqual([
      "manifest.json",
    ]);
    const source = pluginImportsSource(plugins);
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
    await writePluginManifest(assets, []);
    expect((await readAppManifest(assets)).plugins).toEqual([]);
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

      native: {
        operations: [
          {
            name: `example${index}.read`,
            input: {
              const: null,
            },
            output: {
              const: "x".repeat(400000),
            },
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

test("manifest generation and catalog loading preserve the native contract size boundary", async () => {
  const assets = await mkdtemp(resolve(tmpdir(), "bunaway-manifest-boundary-"));
  const output = {
    const: "",
  };
  const native = {
    operations: [
      {
        name: "example.read",
        input: {
          const: null,
        },
        output,
      },
    ],
  };
  // Fill the existing native contract budget exactly; manifest metadata must not consume it.
  output.const = "x".repeat(
    MAX_MESSAGE_BYTES - Buffer.byteLength(JSON.stringify(native)),
  );
  const plugin = {
    name: "example",
    version: "1",
    native,
  };
  const manifest = {
    format: 1,
    app: {},
    policy: {},
    plugins: [
      plugin,
    ],
    developmentSdk: {},
  };
  try {
    expect(
      () =>
        new NativeRegistry([
          plugin,
        ]),
    ).not.toThrow();
    expect(parseAppManifest(manifest).plugins[0]?.native).toEqual(native);
    await writePluginManifest(assets, [
      {
        name: plugin.name,
        version: plugin.version,
        native,
        packageName: "example",
        root: assets,
        targets: {},
      },
    ]);
    expect((await readAppManifest(assets)).plugins[0]?.native).toEqual(native);
    expect(
      (
        await loadPluginCatalog(assets, {
          example: {},
        })
      )[0]?.native,
    ).toEqual(native);
    output.const += "x";
    expect(
      () =>
        new NativeRegistry([
          plugin,
        ]),
    ).toThrow();
    expect(() => parseAppManifest(manifest)).toThrow();
  } finally {
    await rm(assets, {
      recursive: true,
      force: true,
    });
  }
});
