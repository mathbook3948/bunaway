import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { frameworkRoot, json, writeJson } from "./files.ts";

/** Lower-case words joined by single hyphens, as every plugin directory is named. */
const PLUGIN_DIRECTORY_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
/** Keeps every generated line inside the formatter's width, so the files need no reformatting. */
const MAX_PLUGIN_NAME_LENGTH = 24;
const LINE_WIDTH = 80;
const PLUGIN_PAGES = "docs/site/src/content/docs/reference/plugins";
const REFERENCE_MAP = "docs/site/src/reference-map.json";

type FrameworkManifest = {
  version?: unknown;
  plugins?: unknown;
};

type RootManifest = {
  devDependencies?: Record<string, string>;
};

/** Names derived once from the directory name and shared by every generated file. */
type PluginSpec = {
  directory: string;
  /** camelCase registration name, import alias owner and operation prefix. */
  id: string;
  /** PascalCase prefix of the generated types. */
  pascal: string;
  packageName: string;
  sdkVersion: string;
  zodVersion: string;
  sidebarOrder: number;
};

function record(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${what} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function camel(directory: string): string {
  return directory.replace(/-([a-z0-9])/g, (_, letter: string) =>
    letter.toUpperCase(),
  );
}

/**
 * An import statement in the shape the repository formatter prints it: one specifier always
 * stays on one line, several break onto their own lines past the line width.
 */
function importLine(
  keyword: "import" | "import type" | "export type",
  names: string[],
  from: string,
): string {
  const single = `${keyword} { ${names.join(", ")} } from "${from}";`;
  if (names.length === 1 || single.length <= LINE_WIDTH) {
    return single;
  }
  return `${keyword} {\n${names.map((name) => `  ${name},`).join("\n")}\n} from "${from}";`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

/** The files of a plugin that builds, type checks and passes every repository check unchanged. */
function pluginFiles(spec: PluginSpec): Record<string, string> {
  const { directory, id, pascal, packageName } = spec;
  const alias = `#${directory}`;
  const platform = (
    name: "windows" | "macos",
  ) => `import { BunawayError } from "@bunaway/protocol";
${importLine(
  "import type",
  [
    `${pascal}Instance`,
  ],
  `${alias}/contract`,
)}

/** Own native resources for the host's lifetime: open them here and release them in dispose. */
export function initialize(): ${pascal}Instance & {
  dispose(): void;
} {
  let disposed = false;
  return {
    ping() {
      if (disposed) {
        throw new BunawayError({
          code: "CANCELLED",
          message: "${pascal} adapter is disposed.",
        });
      }
      return {
        platform: "${name}",
      };
    },
    dispose() {
      disposed = true;
    },
  };
}

export function dispose(instance: ReturnType<typeof initialize>): void {
  instance.dispose();
}
`;
  return {
    "package.json": `${JSON.stringify(
      {
        name: packageName,
        version: "0.0.0",
        type: "module",
        bunaway: {
          plugin: "./dist/index.js",
        },
        exports: {
          ".": {
            types: "./dist/types/index.d.ts",
            default: "./dist/index.js",
          },
          "./native/*": {
            types: "./dist/types/index.d.ts",
            default: "./dist/native/*.js",
          },
        },
        scripts: {
          build: "bunaway plugin build",
          typecheck: "tsc --project tsconfig.json",
        },
        dependencies: {
          "@bunaway/protocol": "workspace:*",
          zod: spec.zodVersion,
        },
        peerDependencies: {
          "@bunaway/plugin": spec.sdkVersion,
        },
        devDependencies: {
          "@bunaway/plugin": "workspace:*",
        },
        imports: {
          [`${alias}/*`]: {
            "bunaway-source": "./src/*.ts",
            types: "./dist/types/*.d.ts",
            default: "./src/*.ts",
          },
        },
      },
      null,
      2,
    )}\n`,
    // Written as text: the formatter keeps short JSON arrays on one line.
    "tsconfig.json": `{
  "extends": "../../tsconfig.base.json",
  "include": ["src/**/*.ts"],
  "compilerOptions": {
    "types": ["bun"],
    "resolveJsonModule": true,
    "rootDir": "./src",
    "outDir": "./dist/types"
  }
}
`,
    "README.md": `# ${pascal} plugin

\`${packageName}\` provides permission-mediated \`${id}.ping(null)\` on Windows and macOS.
Register \`${id}\` in the app definition. Each operation requires its own permission; registration grants none.

See the [public contract](../../${PLUGIN_PAGES}/${directory}.mdx) for inputs, results and failures.
Platform adapters own their native resources from \`initialize\` until \`dispose\`.

\`tests/api/${directory}.test.ts\` should check the contract and independent permissions.
`,
    "src/contract.ts": `import { z } from "zod";

/** Platforms the plugin runs on; the native adapter reports which one answered. */
export const ${id}PlatformSchema = z.enum([
  "windows",
  "macos",
]);
export const pingOutputSchema = z.strictObject({
  platform: ${id}PlatformSchema,
});
/** Result of ${id}.ping. */
export type ${pascal}Ping = z.infer<typeof pingOutputSchema>;

/** What every platform adapter provides; operations are typed by this interface, not by a platform module. */
export interface ${pascal}Instance {
  ping(): ${pascal}Ping;
}
`,
    "src/operations.ts": `import { defineNativeOperation } from "@bunaway/plugin";
import { z } from "zod";
${importLine(
  "import",
  [
    `type ${pascal}Instance`,
    "pingOutputSchema",
  ],
  `${alias}/contract`,
)}

const operation = defineNativeOperation<${pascal}Instance>();
/** Each operation requires its own permission, named after the operation. */
export const ${id}Operations = {
  ping: operation({
    input: z.null(),
    output: pingOutputSchema,
    handler: (_input, { instance }) => instance.ping(),
  }),
};
`,
    "src/index.ts": `import { defineNativePlugin } from "@bunaway/plugin";
${importLine(
  "import",
  [
    `${id}Operations`,
  ],
  `${alias}/operations`,
)}
import {
  dispose as disposeMacos,
  initialize as initializeMacos,
} from "${alias}/platforms/macos";
import {
  dispose as disposeWindows,
  initialize as initializeWindows,
} from "${alias}/platforms/windows";
/** Describe in one sentence what the plugin does and which OS features it touches. */
export default defineNativePlugin({
  name: "${id}",
  platforms: {
    macos: {
      initialize: initializeMacos,
      dispose: disposeMacos,
      operations: ${id}Operations,
    },
    windows: {
      initialize: initializeWindows,
      dispose: disposeWindows,
      operations: ${id}Operations,
    },
  },
});

${importLine(
  "export type",
  [
    `${pascal}Ping`,
  ],
  `${alias}/contract`,
)}
`,
    "src/platforms/windows.ts": platform("windows"),
    "src/platforms/macos.ts": platform("macos"),
  };
}

/** The reference page the documentation checker requires for every registered plugin. */
function pluginPage(spec: PluginSpec): string {
  const { directory, id, pascal, packageName, sidebarOrder } = spec;
  return `---
title: ${directory}
description: ${pascal} 플러그인의 공개 계약. 플러그인이 하는 일을 한 문장으로 적습니다.
sidebar: { order: ${sidebarOrder} }
---

기본 export(\`default\`)를 \`${id}\`로 가져와 앱에 등록하고 호출합니다.

\`${packageName}\` 패키지를 설치하고 앱의 \`plugins\`에 \`${id}\`를 등록합니다. Windows와
macOS에서 제공합니다. 화면과 백엔드는 같은 패키지의 \`${id}\`를 사용합니다.

\`\`\`ts
import ${id} from "${packageName}";

const { platform } = await ${id}.ping(null);
\`\`\`

| 함수 | 입력 | 결과 | 권한 |
| --- | --- | --- | --- |
| \`${id}.ping\` | \`null\` | \`Promise<${pascal}Ping>\` | \`${id}.ping\` |

\`${pascal}Ping\`은 응답한 플랫폼 이름(\`platform: "windows" | "macos"\`)을 돌려줍니다.
어댑터가 dispose된 뒤의 호출은 \`CANCELLED\`로 실패합니다.
`;
}

/** Add the package and its operations to the reference map without reformatting the rest of the file. */
function withReferenceEntries(text: string, spec: PluginSpec): string {
  const { directory, id, packageName } = spec;
  const packagesEnd = /\n {2}\],\n {2}"members": \[/;
  const operationsStart = '"operations": {\n';
  if (!packagesEnd.test(text) || text.split(operationsStart).length !== 2) {
    throw new Error(`${REFERENCE_MAP}: unexpected layout.`);
  }
  const entry = `,
    {
      "name": "${packageName}",
      "source": "plugins/${directory}/src/index.ts",
      "buildOutputs": {
        ".": "./dist/index.js",
        "./native/*": "./dist/native/*.js"
      },
      "pages": {
        "reference/plugins/${directory}": ["default"]
      }
    }
  ],
  "members": [`;
  const page = `    "reference/plugins/${directory}": `;
  const flat = `${page}["${id}.ping"],\n`;
  // The formatter breaks a JSON array only past the line width.
  const operations =
    flat.length - 1 <= LINE_WIDTH
      ? flat
      : `${page}[\n      "${id}.ping"\n    ],\n`;
  return text
    .replace(packagesEnd, entry)
    .replace(operationsStart, `${operationsStart}${operations}`);
}

/** Validate the name and read every manifest before anything is written. */
async function planPlugin(
  name: string,
  root: string,
): Promise<{
  spec: PluginSpec;
  framework: Record<string, unknown>;
  rootManifest: RootManifest;
  referenceMap: string;
}> {
  if (
    !PLUGIN_DIRECTORY_NAME.test(name) ||
    name.length > MAX_PLUGIN_NAME_LENGTH
  ) {
    throw new Error(
      `Plugin names are lower-case words joined by hyphens, at most ${MAX_PLUGIN_NAME_LENGTH} characters: ${name}.`,
    );
  }
  const framework = record(
    await json(resolve(root, "framework.json")),
    "framework.json",
  ) as FrameworkManifest;
  const plugins = record(framework.plugins, "framework.json plugins");
  if (typeof framework.version !== "string") {
    throw new Error("framework.json must carry the framework version.");
  }
  if (name in plugins || (await exists(resolve(root, "plugins", name)))) {
    throw new Error(`Plugin ${name} already exists.`);
  }
  const rootManifest = record(
    await json(resolve(root, "package.json")),
    "package.json",
  ) as RootManifest;
  const zodVersion = rootManifest.devDependencies?.zod;
  if (!zodVersion) {
    throw new Error("package.json must pin zod in devDependencies.");
  }
  const referenceMap = await Bun.file(resolve(root, REFERENCE_MAP)).text();
  const pages = await readdir(resolve(root, PLUGIN_PAGES));
  const id = camel(name);
  return {
    spec: {
      directory: name,
      id,
      pascal: `${id[0]?.toUpperCase() ?? ""}${id.slice(1)}`,
      packageName: `@bunaway/plugin-${name}`,
      sdkVersion: framework.version,
      zodVersion,
      sidebarOrder: pages.filter((page) => page.endsWith(".mdx")).length + 1,
    },
    framework: framework as Record<string, unknown>,
    rootManifest,
    referenceMap,
  };
}

/**
 * Scaffold a native plugin workspace and register it everywhere the repository checks:
 * `framework.json`, the root `package.json`, the documentation reference map and a reference
 * page. The generated plugin builds, type checks and exposes one `ping` operation per platform
 * so the author replaces its body instead of copying another plugin. Nothing is written until
 * every manifest has been read and the name is free. Run `bun install` afterwards so the
 * lockfile learns the new workspace.
 */
export async function createNativePlugin(
  name: string,
  options: {
    root?: string;
  } = {},
): Promise<string[]> {
  const root = resolve(options.root ?? frameworkRoot);
  const { spec, framework, rootManifest, referenceMap } = await planPlugin(
    name,
    root,
  );
  const written: string[] = [];
  const write = async (path: string, contents: string) => {
    await mkdir(dirname(path), {
      recursive: true,
    });
    await writeFile(path, contents);
    written.push(path);
  };
  const pluginRoot = resolve(root, "plugins", spec.directory);
  for (const [path, contents] of Object.entries(pluginFiles(spec))) {
    await write(resolve(pluginRoot, path), contents);
  }
  await write(
    resolve(root, PLUGIN_PAGES, `${spec.directory}.mdx`),
    pluginPage(spec),
  );
  const plugins = framework.plugins as Record<string, string>;
  plugins[spec.directory] = spec.packageName;
  await writeJson(resolve(root, "framework.json"), framework);
  written.push(resolve(root, "framework.json"));
  rootManifest.devDependencies = {
    ...rootManifest.devDependencies,
    [spec.packageName]: "workspace:*",
  };
  await writeJson(resolve(root, "package.json"), rootManifest);
  written.push(resolve(root, "package.json"));
  await write(
    resolve(root, REFERENCE_MAP),
    withReferenceEntries(referenceMap, spec),
  );
  return written;
}
