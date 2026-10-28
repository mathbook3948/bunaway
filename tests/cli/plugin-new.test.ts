import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { frameworkRoot, writeJson } from "#cli/files";
import { buildNativePlugin } from "#cli/plugin-build";
import { createNativePlugin } from "#cli/plugin-new";
import { readPluginDeclaration } from "#cli/plugins";
import { deadline } from "../fixtures/deadlines.ts";

setDefaultTimeout(deadline("build"));

const REFERENCE_MAP = `{
  "packages": [
    {
      "name": "@bunaway/plugin-os",
      "source": "plugins/os/src/index.ts",
      "pages": {
        "reference/plugins/os": ["default"]
      }
    }
  ],
  "members": [],
  "commands": {},
  "operations": {
    "reference/plugins/os": ["os.info"]
  },
  "configuration": {}
}
`;

/** A repository root with the manifests the scaffold registers into, under the real node_modules. */
async function repository() {
  await mkdir(resolve(frameworkRoot, "build"), {
    recursive: true,
  });
  const root = await mkdtemp(resolve(frameworkRoot, "build/plugin-new-"));
  await writeJson(resolve(root, "framework.json"), {
    format: 1,
    version: "0.0.0",
    packages: {},
    plugins: {
      os: "@bunaway/plugin-os",
    },
  });
  await writeJson(resolve(root, "package.json"), {
    name: "fixture",
    private: true,
    workspaces: [
      "plugins/*",
    ],
    devDependencies: {
      "@bunaway/plugin-os": "workspace:*",
      zod: "4.6.5",
    },
  });
  await Bun.write(
    resolve(root, "tsconfig.base.json"),
    Bun.file(resolve(frameworkRoot, "tsconfig.base.json")),
  );
  await Bun.write(
    resolve(root, "docs/site/src/reference-map.json"),
    REFERENCE_MAP,
  );
  await Bun.write(
    resolve(root, "docs/site/src/content/docs/reference/plugins/os.mdx"),
    "---\ntitle: os\nsidebar: { order: 7 }\n---\n",
  );
  return root;
}

test("plugin new scaffolds a workspace that builds and is registered in every manifest", async () => {
  const root = await repository();
  try {
    const written = await createNativePlugin("demo-widget", {
      root,
    });
    const plugin = resolve(root, "plugins/demo-widget");
    expect(
      written.map((path) => relative(root, path).split(sep).join("/")).sort(),
    ).toEqual([
      "docs/site/src/content/docs/reference/plugins/demo-widget.mdx",
      "docs/site/src/reference-map.json",
      "framework.json",
      "package.json",
      "plugins/demo-widget/README.md",
      "plugins/demo-widget/package.json",
      "plugins/demo-widget/src/contract.ts",
      "plugins/demo-widget/src/index.ts",
      "plugins/demo-widget/src/operations.ts",
      "plugins/demo-widget/src/platforms/macos.ts",
      "plugins/demo-widget/src/platforms/windows.ts",
      "plugins/demo-widget/tsconfig.json",
    ]);
    const framework = await Bun.file(resolve(root, "framework.json")).json();
    expect(framework.plugins).toEqual({
      os: "@bunaway/plugin-os",
      "demo-widget": "@bunaway/plugin-demo-widget",
    });
    const manifest = await Bun.file(resolve(root, "package.json")).json();
    expect(manifest.devDependencies["@bunaway/plugin-demo-widget"]).toBe(
      "workspace:*",
    );
    const referenceMap = await Bun.file(
      resolve(root, "docs/site/src/reference-map.json"),
    ).text();
    const catalog = JSON.parse(referenceMap);
    expect(catalog.packages[1]).toEqual({
      name: "@bunaway/plugin-demo-widget",
      source: "plugins/demo-widget/src/index.ts",
      buildOutputs: {
        ".": "./dist/index.js",
        "./native/*": "./dist/native/*.js",
      },
      pages: {
        "reference/plugins/demo-widget": [
          "default",
        ],
      },
    });
    expect(catalog.operations["reference/plugins/demo-widget"]).toEqual([
      "demoWidget.ping",
    ]);
    // The untouched entries keep their one-line arrays, so the formatter has nothing to change.
    expect(referenceMap).toContain('"reference/plugins/os": ["default"]');
    expect(referenceMap).toContain(
      '"reference/plugins/demo-widget": ["demoWidget.ping"],',
    );
    const page = await Bun.file(
      resolve(
        root,
        "docs/site/src/content/docs/reference/plugins/demo-widget.mdx",
      ),
    ).text();
    expect(page).toContain("sidebar: { order: 2 }");
    expect(page).toContain("`demoWidget.ping`");
    expect(page).toContain("default");
    // Operations are typed by the contract's instance interface, never by a platform module.
    const operations = await Bun.file(
      resolve(plugin, "src/operations.ts"),
    ).text();
    expect(operations).toContain("defineNativeOperation<DemoWidgetInstance>()");
    expect(operations).not.toContain("/platforms/");
    const pluginManifest = await Bun.file(
      resolve(plugin, "package.json"),
    ).json();
    expect(pluginManifest.name).toBe("@bunaway/plugin-demo-widget");
    expect(pluginManifest.dependencies.zod).toBe("4.6.5");
    expect(pluginManifest.dependencies["@bunaway/plugin-api"]).toBe(
      "workspace:*",
    );
    expect(pluginManifest.peerDependencies["@bunaway/plugin"]).toBe("0.0.0");
    expect(Object.keys(pluginManifest.imports)).toEqual([
      "#demo-widget/*",
    ]);

    const declaration = await readPluginDeclaration(
      resolve(plugin, "src/index.ts"),
      plugin,
    );
    expect(declaration.native.operations.map((entry) => entry.name)).toEqual([
      "demoWidget.ping",
    ]);
    expect(Object.keys(declaration.nativePlatforms).sort()).toEqual([
      "macos",
      "windows",
    ]);
    // The build runs tsc for the declarations, so a type error in the scaffold fails here.
    await buildNativePlugin(plugin);
    for (const output of [
      "dist/index.js",
      "dist/native/windows.js",
      "dist/native/macos.js",
      "dist/types/index.d.ts",
    ]) {
      expect(await Bun.file(resolve(plugin, output)).exists()).toBe(true);
    }
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
    });
  }
});

test("plugin new refuses invalid and taken names before writing anything", async () => {
  const root = await repository();
  try {
    for (const name of [
      "Demo",
      "-demo",
      "demo--widget",
      "demo_widget",
      "demo-",
      "a".repeat(25),
    ]) {
      await expect(
        createNativePlugin(name, {
          root,
        }),
      ).rejects.toThrow("lower-case words joined by hyphens");
    }
    await expect(
      createNativePlugin("os", {
        root,
      }),
    ).rejects.toThrow("Plugin os already exists.");
    await mkdir(resolve(root, "plugins/taken"), {
      recursive: true,
    });
    await expect(
      createNativePlugin("taken", {
        root,
      }),
    ).rejects.toThrow("Plugin taken already exists.");
    const framework = await Bun.file(resolve(root, "framework.json")).json();
    expect(Object.keys(framework.plugins)).toEqual([
      "os",
    ]);
    expect(
      await Bun.file(resolve(root, "plugins/os/package.json")).exists(),
    ).toBe(false);
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
    });
  }
});

test("plugin new fails on an unexpected reference-map layout before writing anything", async () => {
  const root = await repository();
  try {
    // A second operations map is a layout the scaffold cannot edit without reformatting.
    await Bun.write(
      resolve(root, "docs/site/src/reference-map.json"),
      REFERENCE_MAP.replace(
        '"configuration": {}',
        '"configuration": {},\n  "extra": { "operations": {\n  } }',
      ),
    );
    await expect(
      createNativePlugin("demo-widget", {
        root,
      }),
    ).rejects.toThrow("unexpected layout");
    const framework = await Bun.file(resolve(root, "framework.json")).json();
    expect(Object.keys(framework.plugins)).toEqual([
      "os",
    ]);
    const manifest = await Bun.file(resolve(root, "package.json")).json();
    expect(Object.keys(manifest.devDependencies)).toEqual([
      "@bunaway/plugin-os",
      "zod",
    ]);
    expect(await Bun.file(resolve(root, "plugins/demo-widget")).exists()).toBe(
      false,
    );
    expect(
      await Bun.file(
        resolve(
          root,
          "docs/site/src/content/docs/reference/plugins/demo-widget.mdx",
        ),
      ).exists(),
    ).toBe(false);
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
    });
  }
});

test("plugin new writes the longest allowed name in the formatter's layout", async () => {
  const root = await repository();
  try {
    await createNativePlugin("twenty-four-letter-name1", {
      root,
    });
    const plugin = resolve(root, "plugins/twenty-four-letter-name1");
    // One specifier stays on one line however long; a JSON array breaks past the width.
    expect(await Bun.file(resolve(plugin, "src/index.ts")).text()).toContain(
      'import { twentyFourLetterName1Operations } from "#twenty-four-letter-name1/operations";\n',
    );
    expect(
      await Bun.file(resolve(root, "docs/site/src/reference-map.json")).text(),
    ).toContain(
      '    "reference/plugins/twenty-four-letter-name1": [\n      "twentyFourLetterName1.ping"\n    ],\n',
    );
    const declaration = await readPluginDeclaration(
      resolve(plugin, "src/index.ts"),
      plugin,
    );
    expect(declaration.native.operations.map((entry) => entry.name)).toEqual([
      "twentyFourLetterName1.ping",
    ]);
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
    });
  }
});
