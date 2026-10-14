import { expect, test } from "bun:test";
import {
  copyFile,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repository = resolve(import.meta.dir, "../..");
const sdk = pathToFileURL(
  resolve(repository, "packages/plugin-sdk/src/index.ts"),
).href;
const schemas = pathToFileURL(Bun.resolveSync("zod", repository)).href;
const operationNames = [
  "renamed.shared",
  "renamed.generated",
  "renamed.windowsOnly",
  "renamed.macosOnly",
];

type Scenario = {
  documented?: string[];
  extraPlugin?: boolean;
  missingDeclaration?: boolean;
  pageText?: string;
};

/** Run the real checker with source declarations and a minimal reference catalog. */
async function checkReference(scenario: Scenario = {}) {
  const root = await mkdtemp(join(tmpdir(), "bunaway-doc-reference-"));
  const write = async (path: string, contents: string) => {
    const destination = resolve(root, path);
    await mkdir(dirname(destination), {
      recursive: true,
    });
    await writeFile(destination, contents);
  };
  try {
    await write("packages/cli/package.json", "{}");
    await write("packages/cli/src/main.ts", "export {};");
    await write("packages/protocol/package.json", "{}");
    await write("packages/protocol/src/validation.ts", "interface Schema {}");
    await write("packages/protocol/src/schema.ts", "export {};");
    // Keep declaration inspection on its production path and SDK implementation.
    await write(
      "packages/cli/src/plugins.ts",
      `export { readPluginDeclaration } from ${JSON.stringify(pathToFileURL(resolve(repository, "packages/cli/src/plugins.ts")).href)};`,
    );
    await write(
      "plugins/different-directory/package.json",
      '{"name":"@fixture/demo"}',
    );
    await write(
      "plugins/different-directory/src/inventory.ts",
      `import { z } from ${JSON.stringify(schemas)};
export const operation = { input: z.null(), output: z.null(), handler() { throw new Error("Operations must not execute"); } };
export const renamedInventory = { shared: operation, ...Object.fromEntries(["generated"].map(name => [name, operation])) };
export const unusedInventory = { phantom: operation };`,
    );
    if (!scenario.missingDeclaration) {
      await write(
        "plugins/different-directory/src/index.ts",
        `import { defineNativePlugin as declare } from ${JSON.stringify(sdk)};
import { writeFileSync } from "node:fs";
import { renamedInventory as importedOperations, operation } from "./inventory.ts";
function initialize() { writeFileSync(${JSON.stringify(resolve(root, "native-created"))}, "created"); throw new Error("Native factories must not run"); }
const renamedPlatforms = {
  windows: { initialize, operations: { ...importedOperations, windowsOnly: operation } },
  macos: { initialize, operations: { macosOnly: operation, shared: operation } },
};
export default declare({ name: "renamed", platforms: renamedPlatforms });`,
      );
    }
    // A directory alone is not part of the authoritative framework inventory.
    await write(
      "plugins/unregistered/package.json",
      '{"name":"@fixture/unregistered"}',
    );
    await write(
      "plugins/unregistered/src/index.ts",
      'throw new Error("Unregistered plugin must not load");',
    );
    const plugins: Record<string, string> = {
      "different-directory": "@fixture/demo",
    };
    if (scenario.extraPlugin) {
      plugins.added = "@fixture/added";
      await write("plugins/added/package.json", '{"name":"@fixture/added"}');
      await write(
        "plugins/added/src/index.ts",
        `import { defineNativePlugin } from ${JSON.stringify(sdk)};
import { operation } from "../../different-directory/src/inventory.ts";
export default defineNativePlugin({name: "added", platforms: { linux: { operations: { read: operation } } }});`,
      );
    }
    await write(
      "framework.json",
      JSON.stringify({
        plugins,
      }),
    );
    await write(
      "docs/site/src/reference-map.json",
      JSON.stringify({
        packages: [],
        members: [],
        commands: {},
        operations: {
          "reference/operations": scenario.documented ?? operationNames,
        },
        configuration: {},
      }),
    );
    await write(
      "docs/site/src/content/docs/reference/operations.mdx",
      scenario.pageText ?? operationNames.join("\n"),
    );
    await write("docs/site/src/content/docs/reference/schema.mdx", "Schema");
    await write("docs/site/src/content/docs/reference/policy.mdx", "Policy");
    const scripts = resolve(root, "docs/site/scripts");
    await mkdir(scripts, {
      recursive: true,
    });
    await copyFile(
      resolve(repository, "docs/site/scripts/check-reference.mjs"),
      resolve(scripts, "check-reference.mjs"),
    );
    await symlink(
      resolve(repository, "docs/site/node_modules"),
      resolve(root, "docs/site/node_modules"),
      "junction",
    );
    const child = Bun.spawn(
      [
        "node",
        resolve(scripts, "check-reference.mjs"),
      ],
      {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(await Bun.file(resolve(root, "native-created")).exists()).toBe(
      false,
    );
    return {
      exitCode,
      output: `${stdout}\n${stderr}`,
    };
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
    });
  }
}

test("discovers spread, generated and platform operations despite renamed declarations without native side effects", async () => {
  const result = await checkReference();
  expect(result.exitCode).toBe(0);
  expect(result.output).toContain(
    "4 public exports, members, commands, operations",
  );
});

for (const omitted of [
  "renamed.generated",
  "renamed.macosOnly",
]) {
  test(`rejects omitted documentation for ${omitted}`, async () => {
    const result = await checkReference({
      documented: operationNames.filter((name) => name !== omitted),
    });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain(`Host operations: undocumented ${omitted}`);
  });
}

test("discovers a newly registered plugin without editing the checker", async () => {
  const result = await checkReference({
    extraPlugin: true,
  });
  expect(result.exitCode).toBe(1);
  expect(result.output).toContain("Host operations: undocumented added.read");
});

test("rejects mapped operations absent from their documentation page", async () => {
  const result = await checkReference({
    pageText: "No operation names here",
  });
  expect(result.exitCode).toBe(1);
  expect(result.output).toContain(
    "mapped renamed.generated is absent from the page",
  );
});

test("rejects stale mappings for operations outside the registered declaration", async () => {
  const result = await checkReference({
    documented: [
      ...operationNames,
      "renamed.phantom",
    ],
    pageText: [
      ...operationNames,
      "renamed.phantom",
    ].join("\n"),
  });
  expect(result.exitCode).toBe(1);
  expect(result.output).toContain(
    "Host operations: stale mapping for renamed.phantom",
  );
});

test("fails when a registered plugin cannot be inspected", async () => {
  const result = await checkReference({
    missingDeclaration: true,
  });
  expect(result.exitCode).toBe(1);
  expect(result.output).toContain("Cannot inspect host operations");
});
