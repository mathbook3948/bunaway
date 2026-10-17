import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { APP_INFO_MAX_LENGTH } from "@bunaway/plugin-api";
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
  appName,
  desktopAppPaths,
  parsePackageVersions,
  readPackageVersions,
  toAppInfo,
} from "@bunaway/runtime-bun/app-metadata";
import { appModules, pluginImportsSource } from "#cli/app-modules";
import { readAppVersions } from "#cli/app-versions";
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
        version: "x".repeat(APP_INFO_MAX_LENGTH + 1),
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

test("legacy packages without a package manifest or app title still start", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "bunaway-legacy-"));
  try {
    // No manifest.json: packages built before ctx.app and hand-assembled packages.
    expect(await readPackageVersions(directory)).toEqual({
      version: null,
      framework: null,
    });
    await writeFile(resolve(directory, "manifest.json"), "{ not json");
    await expect(readPackageVersions(directory)).rejects.toThrow();
    await writeJson(resolve(directory, "manifest.json"), []);
    await expect(readPackageVersions(directory)).rejects.toThrow(
      "Invalid package manifest.",
    );
    // A directory in place of the file is a read error other than ENOENT.
    await rm(resolve(directory, "manifest.json"));
    await mkdir(resolve(directory, "manifest.json"));
    await expect(readPackageVersions(directory)).rejects.toThrow();
  } finally {
    await rm(directory, {
      recursive: true,
      force: true,
    });
  }
  expect(appName(undefined, "dev.example")).toBe("dev.example");
  expect(appName("x".repeat(APP_INFO_MAX_LENGTH), "dev.example")).toHaveLength(
    APP_INFO_MAX_LENGTH,
  );
  for (const title of [
    "",
    null,
    1,
    "x".repeat(APP_INFO_MAX_LENGTH + 1),
  ]) {
    expect(() => appName(title, "dev.example")).toThrow(
      "Invalid package manifest app title.",
    );
  }
});

test("build-time package versions are optional but must be bounded strings", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "bunaway-versions-"));
  try {
    const app = resolve(directory, "app");
    const framework = resolve(directory, "framework");
    await mkdir(app);
    await mkdir(framework);
    await writeJson(resolve(framework, "package.json"), {
      version: "0.4.5",
    });
    await writeJson(resolve(app, "package.json"), {});
    expect(await readAppVersions(app, framework)).toEqual({
      version: null,
      framework: "0.4.5",
    });
    const exact = "1".repeat(APP_INFO_MAX_LENGTH);
    await writeJson(resolve(app, "package.json"), {
      version: exact,
    });
    expect((await readAppVersions(app, framework)).version).toBe(exact);
    for (const version of [
      1,
      null,
      "",
      "1".repeat(APP_INFO_MAX_LENGTH + 1),
    ]) {
      await writeJson(resolve(app, "package.json"), {
        version,
      });
      await expect(readAppVersions(app, framework)).rejects.toThrow(
        "version must be a non-empty string",
      );
    }
    await writeJson(resolve(app, "package.json"), {
      version: "1.0.0",
    });
    await writeJson(resolve(framework, "package.json"), {
      version: 4,
    });
    await expect(readAppVersions(app, framework)).rejects.toThrow(
      "version must be a non-empty string",
    );
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

test("desktop app paths use the package root as the resources directory and reach AppInfo", () => {
  const paths = desktopAppPaths("/pkg/Resources", "/pkg/MacOS/app");
  expect(paths).toEqual({
    package: "/pkg/Resources",
    executable: "/pkg/MacOS/app",
    resources: "/pkg/Resources",
  });
  const info = toAppInfo(
    {
      name: "App",
      identifier: "dev.example",
      version: null,
      framework: null,
      isPackaged: false,
      paths,
    },
    {
      bun: "1.0.0",
      webview: null,
    },
  );
  expect(info.isPackaged).toBe(false);
  expect(info.paths).toEqual(paths);
});

test("toAppInfo rejects missing app metadata with a clear message", () => {
  expect(() =>
    toAppInfo(undefined as never, {
      bun: Bun.version,
      webview: null,
    }),
  ).toThrow(
    "Missing app metadata: the host must pass the app name, identifier, versions, isPackaged and paths.",
  );
  // Metadata generated before isPackaged and paths existed fails the same way.
  const legacy = {
    name: "App",
    identifier: "dev.example",
    version: null,
    framework: null,
  };
  expect(() =>
    toAppInfo(legacy as never, {
      bun: "1.0.0",
      webview: null,
    }),
  ).toThrow("Missing app metadata:");
  expect(() =>
    toAppInfo(
      {
        ...legacy,
        isPackaged: true,
      } as never,
      {
        bun: "1.0.0",
        webview: null,
      },
    ),
  ).toThrow("Missing app metadata:");
});
