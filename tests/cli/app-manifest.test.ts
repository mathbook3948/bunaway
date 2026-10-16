import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
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
import {
  parsePackageVersions,
  readPackageVersions,
} from "@bunaway/runtime-bun/app-metadata";
import { appModules, pluginImportsSource } from "#cli/app-modules";
import { writeJson } from "#cli/files";
import { writePluginManifest } from "#cli/plugins";
import { loadPluginCatalog } from "#native/host-api/bun/plugin-catalog";

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
          thread: "worker",
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
          thread: "main",
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
          thread: "ui",
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

test("manifest generation and catalog loading preserve the operation registration boundary", async () => {
  const assets = await mkdtemp(resolve(tmpdir(), "bunaway-manifest-boundary-"));
  const native = {
    operations: Array.from(
      {
        length: 256,
      },
      (_, index) => ({
        name: `example.read${index}`,
      }),
    ),
  };
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
    native.operations.push({
      name: "example.overflow",
    });
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

test("package manifest versions are optional strings and malformed values reject startup", async () => {
  expect(parsePackageVersions({})).toEqual({
    version: null,
    framework: null,
  });
  expect(
    parsePackageVersions({
      app: {
        id: "dev.example",
      },
      framework: {},
    }),
  ).toEqual({
    version: null,
    framework: null,
  });
  expect(
    parsePackageVersions({
      app: {
        version: "1.2.3",
      },
      framework: {
        version: "0.4.5",
      },
    }),
  ).toEqual({
    version: "1.2.3",
    framework: "0.4.5",
  });
  for (const value of [
    null,
    [],
    {
      app: null,
    },
    {
      app: [],
    },
    {
      app: {
        version: "",
      },
    },
    {
      app: {
        version: 1,
      },
    },
    {
      app: {
        version: null,
      },
    },
    {
      framework: {
        version: "x".repeat(257),
      },
    },
    {
      framework: "0.4.5",
    },
  ]) {
    expect(() => parsePackageVersions(value)).toThrow();
  }
  const directory = await mkdtemp(resolve(tmpdir(), "bunaway-package-"));
  try {
    await writeJson(resolve(directory, "manifest.json"), {
      app: {
        version: "2.0.0",
      },
    });
    expect(await readPackageVersions(directory)).toEqual({
      version: "2.0.0",
      framework: null,
    });
  } finally {
    await rm(directory, {
      recursive: true,
      force: true,
    });
  }
});

test("generated process backend embeds app metadata as a build-time constant", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "bunaway-metadata-"));
  try {
    const entry = resolve(directory, "app.ts");
    await Bun.write(entry, "export default { commands: {}, events: {} };");
    const runtime = resolve(directory, "runtime.ts");
    await Bun.write(
      runtime,
      "export async function runBunApp(_app: unknown, options: unknown) { console.log(JSON.stringify(options)); }",
    );
    const metadata = {
      name: 'Quote " App',
      identifier: "dev.example.app",
      version: null,
      framework: "0.4.5",
    };
    const build = await Bun.build({
      entrypoints: [
        "bunaway-generated/backend.ts",
      ],
      root: directory,
      target: "bun",
      plugins: [
        appModules({
          appEntry: entry,
          processRuntime: runtime,
          appMetadata: metadata,
        }),
      ],
    });
    expect(build.success).toBe(true);
    const output = resolve(directory, "backend.js");
    await Bun.write(output, build.outputs[0] ?? "");
    const result = Bun.spawnSync([
      process.execPath,
      output,
    ]);
    expect(JSON.parse(result.stdout.toString())).toEqual({
      app: metadata,
    });
    expect(() =>
      appModules({
        appEntry: entry,
        processRuntime: runtime,
      }),
    ).toThrow("app metadata");
  } finally {
    await rm(directory, {
      recursive: true,
      force: true,
    });
  }
});
