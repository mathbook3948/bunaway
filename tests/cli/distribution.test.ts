import { expect, spyOn, test } from "bun:test";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { packFramework } from "../../packages/cli/scripts/pack.ts";
import { bundleWindowsAssets } from "../../packages/cli/src/assets.ts";
import { bundleAssets } from "../../packages/cli/src/build.ts";
import { validateProject } from "../../packages/cli/src/config.ts";
import {
  checkArtifact,
  packageFilename,
  snapshotHashes,
  validateFramework,
} from "../../packages/cli/src/distribution.ts";
import {
  installedPackageRoot,
  json,
  writeJson,
} from "../../packages/cli/src/files.ts";
import { buildWithSdk, sdkPlugin } from "../../packages/cli/src/sdk.ts";
import { createProject, packageDirectory } from "./project.ts";

test("plugin declarations support custom entry paths and JSON exports and are read once per build", async () => {
  const home = await realpath(
    await mkdtemp(resolve(tmpdir(), "bunaway-plugin-exports-")),
  );
  try {
    const project = await createProject(resolve(home, "app"));
    await command(project, [
      "install",
      "--linker",
      "isolated",
    ]);
    const root = await installedPackageRoot(project, "@bunaway/plugin-storage");
    await rename(
      resolve(root, "src/index.ts"),
      resolve(root, "src/public-entry.ts"),
    );
    const scope = resolve(root, "src/scope.ts");
    await writeFile(
      scope,
      (await readFile(scope, "utf8")).replace(
        '"./index.ts"',
        '"./public-entry.ts"',
      ),
    );
    const path = resolve(root, "package.json");
    const manifest = (await json(path)) as Record<string, unknown>;
    await writeJson(path, {
      ...manifest,
      exports: {
        ".": "./src/public-entry.ts",
        "./package.json": "./package.json",
      },
    });
    const descriptorPath = resolve(root, "plugin.json");
    const descriptor = (await json(descriptorPath)) as {
      entry: string;
    };
    descriptor.entry = "./src/public-entry.ts";
    await writeJson(descriptorPath, descriptor);
    const appEntry = resolve(project, "src-bunaway/app.ts");
    await Bun.write(
      appEntry,
      `${await Bun.file(appEntry).text()}
import metadata from "@bunaway/plugin-storage/package.json";
console.log(metadata.name);
`,
    );
    await writeFile(
      resolve(project, "src/main.ts"),
      'import { storage } from "@bunaway/plugin-storage"; document.body.onclick = () => { void storage.readText({ scope: "temp", path: "memo.txt" }, { signal: new AbortController().signal }); };',
    );
    const typedClient = resolve(project, "src/client-contracts.ts");
    await writeFile(
      typedClient,
      `import { client } from "./client.ts";
      export function check() {
        const text: Promise<string> = client.invoke("message.read", null);
        // @ts-expect-error unknown command
        client.invoke("message.typo", null);
        // @ts-expect-error wrong input
        client.invoke("message.save", 42);
        // @ts-expect-error wrong result type
        const wrong: Promise<number> = client.invoke("message.read", null);
        client.listen("message.saved", event => {
          const payload: string = event.payload;
          // @ts-expect-error wrong event payload
          const wrong: number = event.payload;
        }, { onError() {} });
      }
    `,
    );
    try {
      await command(project, [
        "run",
        "typecheck",
      ]);
    } finally {
      await rm(typedClient);
    }
    const invalidBackend = resolve(project, "src-bunaway/type-error.ts");
    await writeFile(
      invalidBackend,
      'import { storage } from "@bunaway/plugin-storage"; storage.readText({ scope: "temp", path: "memo.txt" }, { deadline: 0 });',
    );
    try {
      await expect(
        command(project, [
          "run",
          "typecheck",
        ]),
      ).rejects.toThrow("not assignable");
    } finally {
      await rm(invalidBackend);
    }
    const spawn = spyOn(Bun, "spawn");
    try {
      const valid = await validateProject(project);
      const assets = resolve(home, "assets");
      await bundleWindowsAssets(valid, assets);
      const developmentAssets = resolve(home, "development-assets");
      await bundleWindowsAssets(valid, developmentAssets, false, true);
      expect(
        await Bun.file(resolve(developmentAssets, "app.js")).exists(),
      ).toBe(true);
      const contractReads = spawn.mock.calls.filter(
        ([args]) =>
          Array.isArray(args) &&
          args[1] === "-e" &&
          String(args[2]).includes(
            'matches: typeof plugin.matches === "function"',
          ),
      );
      expect(contractReads).toHaveLength(1);
      expect(await Bun.file(resolve(assets, "boot.js")).exists()).toBe(true);
      expect(
        await Bun.file(resolve(assets, "web/main.js")).text(),
      ).not.toContain("AsyncLocalStorage");
    } finally {
      spawn.mockRestore();
    }
    const entry = resolve(root, "src/public-entry.ts");
    await writeFile(
      entry,
      (await readFile(entry, "utf8")).replace("  matches,", ""),
    );
    await expect(validateProject(project)).rejects.toThrow("require matches");
  } finally {
    await rm(home, {
      recursive: true,
      force: true,
    });
  }
}, 60000);

async function command(
  cwd: string,
  args: string[],
  executable = process.execPath,
): Promise<string> {
  const child = Bun.spawn(
    [
      executable,
      ...args,
    ],
    {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  const code = await child.exited;
  const output = `${await stdout}\n${await stderr}`;
  if (code !== 0) {
    throw new Error(output);
  }
  return output;
}

test("generated apps discover installed plugins from every direct dependency section", async () => {
  const home = await realpath(
    await mkdtemp(resolve(tmpdir(), "bunaway-plugin-dependencies-")),
  );
  try {
    const project = await createProject(resolve(home, "app"));
    await command(project, [
      "install",
    ]);
    const path = resolve(project, "package.json");
    const original = await Bun.file(path).json();
    const specifier = original.dependencies["@bunaway/plugin-storage"];
    delete original.dependencies["@bunaway/plugin-storage"];
    for (const field of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ]) {
      const pkg = structuredClone(original);
      pkg[field] = {
        ...pkg[field],
        "@bunaway/plugin-storage": specifier,
      };
      pkg.optionalDependencies = {
        ...pkg.optionalDependencies,
        "@bunaway/plugin-absent": "0.0.0",
      };
      pkg.peerDependencies = {
        ...pkg.peerDependencies,
        "@bunaway/plugin-absent-peer": "0.0.0",
      };
      pkg.peerDependenciesMeta = {
        "@bunaway/plugin-absent-peer": {
          optional: true,
        },
      };
      await writeJson(path, pkg);
      const valid = await validateProject(project);
      expect(valid.nativePlugins?.map((plugin) => plugin.packageName)).toEqual([
        "@bunaway/plugin-storage",
      ]);
      const assets = resolve(home, `assets-${field}`);
      await bundleWindowsAssets(valid, assets);
      expect(await Bun.file(resolve(assets, "boot.js")).exists()).toBe(true);
      expect(await Bun.file(resolve(assets, "app.js")).exists()).toBe(true);
    }
  } finally {
    await rm(home, {
      recursive: true,
      force: true,
    });
  }
}, 60000);

test("workspace and isolated installs resolve transitive SDKs from their declaring packages", async () => {
  const home = await realpath(
    await mkdtemp(resolve(tmpdir(), "bunaway-isolated-")),
  );
  try {
    for (const workspace of [
      false,
      true,
    ]) {
      const root = resolve(home, workspace ? "workspace" : "standalone");
      await mkdir(resolve(root, "apps"), {
        recursive: true,
      });
      const project = await createProject(resolve(root, "apps/app"));
      if (workspace) {
        await writeJson(resolve(root, "package.json"), {
          private: true,
          workspaces: [
            "apps/*",
          ],
        });
        await command(root, [
          "install",
        ]);
      } else {
        await command(project, [
          "install",
          "--linker",
          "isolated",
        ]);
      }
      expect(
        await Bun.file(
          resolve(project, "node_modules/@bunaway/protocol/package.json"),
        ).exists(),
      ).toBe(false);
      const cli = await installedPackageRoot(project, "@bunaway/cli");
      const protocol = await installedPackageRoot(cli, "@bunaway/protocol");
      expect(
        (
          (await json(resolve(protocol, "package.json"))) as {
            name: string;
          }
        ).name,
      ).toBe("@bunaway/protocol");
      expect(
        await command(project, [
          "run",
          "validate",
        ]),
      ).toContain("valid");
      await command(project, [
        "run",
        "typecheck",
      ]);
      const valid = await validateProject(project);
      const assets = resolve(root, "assets");
      await mkdir(assets);
      await bundleAssets(valid, assets, true);
      expect(await Bun.file(resolve(assets, "boot.js")).exists()).toBe(true);
      expect(await Bun.file(resolve(assets, "app.js")).exists()).toBe(true);
      const manifestPath = resolve(protocol, "package.json");
      const original = await readFile(manifestPath, "utf8");
      try {
        await writeJson(manifestPath, {
          ...JSON.parse(original),
          version: "99.0.0",
        });
        await expect(
          command(project, [
            "run",
            "validate",
          ]),
        ).rejects.toThrow("Incompatible SDK/CLI package");
      } finally {
        await writeFile(manifestPath, original);
      }
    }
  } finally {
    await rm(home, {
      recursive: true,
      force: true,
    });
  }
}, 60000);

test("Windows host relative SDK imports share the installed app's error class", async () => {
  const home = await realpath(
    await mkdtemp(resolve(tmpdir(), "bunaway-sdk-identity-")),
  );
  try {
    const project = await createProject(resolve(home, "app"));
    await command(project, [
      "install",
    ]);
    const plugin = await sdkPlugin(project);
    const native = resolve(
      project,
      "node_modules/@bunaway/cli/native/windows/bun/identity.ts",
    );
    await Bun.write(
      native,
      'export { BunawayError } from "../../../packages/protocol/src/index.ts";',
    );
    const entry = resolve(project, "identity.ts");
    await Bun.write(
      entry,
      `import { BunawayError as AppError } from "@bunaway/protocol";
import { BunawayError as HostError } from "./node_modules/@bunaway/cli/native/windows/bun/identity.ts";
if (AppError !== HostError) throw new Error("SDK error classes differ");
console.log("SHARED_SDK_CLASS");`,
    );
    const outputs = await buildWithSdk(
      {
        entrypoints: [
          entry,
        ],
        target: "bun",
      },
      plugin,
    );
    const bundled = resolve(home, "identity.js");
    const output = outputs[0];
    if (!output) {
      throw new Error("Missing identity bundle.");
    }
    await Bun.write(bundled, output);
    expect(
      await command(project, [
        bundled,
      ]),
    ).toContain("SHARED_SDK_CLASS");
  } finally {
    await rm(home, {
      recursive: true,
      force: true,
    });
  }
}, 30000);

test("upgrading the complete installed release preserves app sources and changes bun.lock", async () => {
  const home = await realpath(
    await mkdtemp(resolve(tmpdir(), "bunaway-upgrade-")),
  );
  try {
    const project = await createProject(resolve(home, "app"));
    await command(project, [
      "install",
    ]);
    const before = await snapshotHashes(resolve(project, "src-bunaway"));
    const frontend = await snapshotHashes(resolve(project, "src"));
    const lock = await readFile(resolve(project, "bun.lock"), "utf8");
    const directory = resolve(home, "next-release");
    await mkdir(directory);
    const pkgPath = resolve(project, "package.json");
    const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
    const info = (await json(
      resolve(project, "node_modules/@bunaway/cli/framework.json"),
    )) as {
      packages: Record<string, string>;
      plugins: Record<string, string>;
    };
    const packages = [
      ...Object.values(info.packages),
      ...Object.values(info.plugins).filter(
        (name) => name in pkg.dependencies || name in pkg.devDependencies,
      ),
    ];
    const dependency = (name: string) =>
      `file:${resolve(directory, packageFilename(name, "0.0.1")).replaceAll("\\", "/")}`;
    // Synthesize a next release from installed packages without mutating repository versions.
    for (const name of packages) {
      const stage = resolve(directory, name.replace("@bunaway/", ""));
      await cp(resolve(project, "node_modules", name), stage, {
        recursive: true,
      });
      const manifestPath = resolve(stage, "package.json");
      const manifest = (await json(manifestPath)) as {
        version: string;
        dependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
      };
      manifest.version = "0.0.1";
      for (const dep of Object.keys(manifest.dependencies ?? {})) {
        if (dep.startsWith("@bunaway/") && manifest.dependencies) {
          manifest.dependencies[dep] = dependency(dep);
        }
      }
      for (const dep of Object.keys(manifest.peerDependencies ?? {})) {
        if (dep.startsWith("@bunaway/") && manifest.peerDependencies) {
          manifest.peerDependencies[dep] = dependency(dep);
        }
      }
      await writeJson(manifestPath, manifest);
      if (name === "@bunaway/cli") {
        const releasePath = resolve(stage, "framework.json");
        await writeJson(releasePath, {
          ...((await json(releasePath)) as object),
          version: "0.0.1",
          nativeHost: "0.0.1",
        });
        for (const directory of Object.keys(
          (
            (await json(releasePath)) as {
              packages: object;
            }
          ).packages,
        )) {
          const path = resolve(stage, "packages", directory, "package.json");
          await writeJson(path, {
            ...((await json(path)) as object),
            version: "0.0.1",
          });
        }
        await rm(resolve(stage, "artifact.files.json"));
        await writeJson(
          resolve(stage, "artifact.files.json"),
          await snapshotHashes(stage),
        );
      }
      await command(stage, [
        "pm",
        "pack",
        "--ignore-scripts",
        "--filename",
        resolve(directory, packageFilename(name, "0.0.1")),
        "--quiet",
      ]);
      for (const declarations of [
        pkg.dependencies,
        pkg.devDependencies,
      ]) {
        if (name in declarations) {
          declarations[name] = dependency(name);
        }
      }
    }
    await writeJson(pkgPath, pkg);
    await command(project, [
      "install",
    ]);
    expect(
      await command(project, [
        "run",
        "bunaway",
        "--version",
      ]),
    ).toContain("0.0.1");
    expect(
      await command(project, [
        "run",
        "validate",
      ]),
    ).toContain("valid");
    await command(project, [
      "run",
      "typecheck",
    ]);
    expect(await snapshotHashes(resolve(project, "src-bunaway"))).toEqual(
      before,
    );
    expect(await snapshotHashes(resolve(project, "src"))).toEqual(frontend);
    expect(await readFile(resolve(project, "bun.lock"), "utf8")).not.toBe(lock);
  } finally {
    await rm(home, {
      recursive: true,
      force: true,
    });
  }
}, 60000);

test("installed packages create a vendor-free app that relocates and reinstalls from bun.lock", async () => {
  const home = await realpath(
    await mkdtemp(resolve(tmpdir(), "bunaway-installed-")),
  );
  try {
    const directory = resolve(home, "artifacts");
    await mkdir(directory);
    const alias = resolve(home, "artifact alias");
    await symlink(directory, alias, "junction");
    const artifact = await packFramework(alias, {
      localDependencies: true,
    });
    expect(dirname(artifact)).toBe(directory);
    const consumer = resolve(home, "tools");
    await mkdir(consumer);
    await writeJson(resolve(consumer, "package.json"), {
      private: true,
      type: "module",
    });
    await command(consumer, [
      "add",
      "--exact",
      artifact,
    ]);
    const installed = resolve(consumer, "node_modules/@bunaway/cli");
    await checkArtifact(installed);
    expect(
      await command(consumer, [
        "run",
        "bunaway",
        "--version",
      ]),
    ).toContain("0.0.0");
    await command(consumer, [
      "run",
      "bunaway",
      "create",
      "../app",
      "--package-dir",
      alias,
    ]);
    const project = resolve(home, "moved app");
    await rename(resolve(home, "app"), project);
    await command(project, [
      "install",
    ]);
    await rm(consumer, {
      recursive: true,
      force: true,
    });
    expect(
      await Bun.file(
        resolve(project, "vendor/bunaway/framework.json"),
      ).exists(),
    ).toBe(false);
    expect(await Bun.file(resolve(project, "bunaway.lock.json")).exists()).toBe(
      false,
    );
    expect(
      await command(project, [
        "run",
        "validate",
      ]),
    ).toContain("valid");
    await command(project, [
      "run",
      "typecheck",
    ]);
    const lock = await readFile(resolve(project, "bun.lock"), "utf8");
    await rm(resolve(project, "node_modules"), {
      recursive: true,
      force: true,
    });
    await command(project, [
      "install",
      "--frozen-lockfile",
    ]);
    expect(await readFile(resolve(project, "bun.lock"), "utf8")).toBe(lock);
    expect(
      await command(project, [
        "run",
        "validate",
      ]),
    ).toContain("valid");
    for (const modules of [
      {
        module: "Preserve",
        moduleResolution: "Bundler",
      },
      {
        module: "NodeNext",
        moduleResolution: "NodeNext",
      },
    ]) {
      await writeFile(
        resolve(project, "api.ts"),
        `import { createProject } from "@bunaway/cli";
import { command } from "@bunaway/backend";
import { createClient } from "@bunaway/client";
const result: Promise<string> = createProject("app");
// @ts-expect-error a path string is required.
createProject(42);
command({ input: { type: "string" }, output: { type: "string" }, handle: value => value });
`,
      );
      await writeJson(resolve(project, "api.tsconfig.json"), {
        compilerOptions: {
          ...modules,
          target: "ES2022",
          strict: true,
          noEmit: true,
          allowImportingTsExtensions: true,
          types: [
            "bun",
          ],
          skipLibCheck: false,
        },
        include: [
          "api.ts",
        ],
      });
      await command(project, [
        "run",
        "tsc",
        "--project",
        "api.tsconfig.json",
      ]);
    }
    if (process.env.BUNAWAY_NATIVE_DISTRIBUTION_TEST === "1") {
      await command(project, [
        "run",
        "doctor",
      ]);
      expect(
        await command(project, [
          "run",
          "build",
        ]),
      ).toContain("Built");
    }
    const sdk = resolve(project, "node_modules/@bunaway/client/package.json");
    const original = await readFile(sdk, "utf8");
    await writeJson(sdk, {
      ...JSON.parse(original),
      version: "99.0.0",
    });
    await expect(
      command(project, [
        "run",
        "validate",
      ]),
    ).rejects.toThrow("Incompatible SDK");
    await writeFile(sdk, original);
    const pkgPath = resolve(project, "package.json");
    const pkg = await readFile(pkgPath, "utf8");
    await writeJson(pkgPath, {
      ...JSON.parse(pkg),
      dependencies: {
        ...JSON.parse(pkg).dependencies,
        "@bunaway/client": "99.0.0",
      },
    });
    await expect(
      command(project, [
        "run",
        "validate",
      ]),
    ).rejects.toThrow("Incompatible Bun/SDK");
    await writeFile(pkgPath, pkg);
    const source = resolve(
      project,
      "node_modules/@bunaway/cli/native/windows/bun/boot.ts",
    );
    await writeFile(source, "changed host");
    await expect(
      command(project, [
        "run",
        "validate",
      ]),
    ).rejects.toThrow("inventory mismatch");
  } finally {
    await rm(home, {
      recursive: true,
      force: true,
    });
  }
}, 60000);

test("asset workers accept policies larger than the Windows command-line limit", async () => {
  const home = await realpath(
    await mkdtemp(resolve(tmpdir(), "bunaway-worker args-")),
  );
  try {
    const project = await createProject(resolve(home, "app"));
    await command(project, [
      "install",
    ]);
    const { policy } = await validateProject(project);
    const view = policy.views[0];
    if (!view) {
      throw new Error("Missing policy view.");
    }
    view.commands = Array.from(
      {
        length: 256,
      },
      (_, index) => `command.${index}`.padEnd(128, "a"),
    );
    view.events = Array.from(
      {
        length: 256,
      },
      (_, index) => `event.${index}`.padEnd(128, "a"),
    );
    await writeJson(resolve(project, "src-bunaway/policy.json"), policy);
    const valid = await validateProject(project);
    const assets = resolve(home, "bundled assets");
    expect(
      JSON.stringify([
        valid,
        assets,
      ]).length,
    ).toBeGreaterThan(32767);
    await bundleAssets(valid, assets);
    expect(await Bun.file(resolve(assets, "backend.js")).exists()).toBe(true);
    expect(await Bun.file(resolve(assets, "web/main.js")).exists()).toBe(true);
  } finally {
    await rm(home, {
      recursive: true,
      force: true,
    });
  }
}, 30000);

test("framework validation rejects extra installed inputs but permits designated native caches", async () => {
  const home = await realpath(
    await mkdtemp(resolve(tmpdir(), "bunaway-snapshot-inputs-")),
  );
  try {
    const project = await createProject(resolve(home, "app"));
    await command(project, [
      "install",
    ]);
    const root = resolve(project, "node_modules/@bunaway/cli");
    for (const directory of [
      "node_modules/installer-managed-package",
      "build",
      "runtime/bun-bundle/vendor",
      "native/windows/bun/vendor",
      "native/macos/vendor",
    ]) {
      await Bun.write(
        resolve(root, directory, "nested/cache.txt"),
        "generated native cache",
      );
    }
    await validateProject(project);
    for (const name of [
      "native/windows/bun/unexpected.hpp",
      "native/windows/bun/vendor-extra/json.hpp",
      "packages/core/src/extra.ts",
      "packages/core/src/node_modules/extra.ts",
    ]) {
      const path = resolve(root, name);
      await Bun.write(path, "unexpected immutable input");
      await expect(validateProject(project)).rejects.toThrow(
        "inventory mismatch",
      );
      await rm(path);
    }
    await validateProject(project);
  } finally {
    await rm(home, {
      recursive: true,
      force: true,
    });
  }
}, 30000);

test("framework validation rejects reserved SDK override selectors without an install", async () => {
  const home = await realpath(
    await mkdtemp(resolve(tmpdir(), "bunaway-overrides-")),
  );
  try {
    const project = await createProject(resolve(home, "app"));
    const packagePath = resolve(project, "package.json");
    const original = (await json(packagePath)) as Record<string, unknown>;
    for (const field of [
      "overrides",
      "resolutions",
    ]) {
      for (const rule of [
        {
          "@bunaway/backend": "workspace:*",
        },
        {
          "@bunaway/client": "99.0.0",
        },
        {
          "@bunaway/core@^0.0.0": "99.0.0",
        },
        {
          consumer: {
            "@bunaway/protocol": "99.0.0",
          },
        },
        {
          "consumer>@bunaway/runtime-bun": "99.0.0",
        },
        {
          "**/@bunaway/cli": "99.0.0",
        },
        {
          "consumer/**/@bunaway/client": "99.0.0",
        },
      ]) {
        await writeJson(packagePath, {
          ...original,
          [field]: rule,
        });
        await expect(validateFramework(project)).rejects.toThrow(
          "Incompatible Bun/SDK",
        );
      }
    }
    await writeJson(packagePath, {
      ...original,
      overrides: {
        typescript: "7.0.2",
      },
      resolutions: {
        "@types/bun": "1.4.2",
      },
    });
    await command(project, [
      "install",
    ]);
    expect(
      await command(project, [
        "run",
        "validate",
      ]),
    ).toContain("valid");
  } finally {
    await rm(home, {
      recursive: true,
      force: true,
    });
  }
}, 30000);

test("repeated API validation reads installed SDK versions despite resolver caches", async () => {
  const home = await realpath(
    await mkdtemp(resolve(tmpdir(), "bunaway-resolution-cache-")),
  );
  try {
    const project = await createProject(resolve(home, "app"));
    await command(project, [
      "install",
    ]);
    await validateFramework(project);
    const cached = Bun.resolveSync("@bunaway/client", project);
    const manifest = resolve(
      project,
      "node_modules/@bunaway/client/package.json",
    );
    const original = await readFile(manifest, "utf8");
    await writeJson(manifest, {
      ...JSON.parse(original),
      version: "99.0.0",
    });
    expect(Bun.resolveSync("@bunaway/client", project)).toBe(cached);
    await expect(validateFramework(project)).rejects.toThrow(
      "Incompatible SDK/CLI package",
    );
    await writeFile(manifest, original);
    await validateFramework(project);
  } finally {
    await rm(home, {
      recursive: true,
      force: true,
    });
  }
}, 30000);

test("validation and bundling reject SDK aliases from nested and transitive importers", async () => {
  const home = await realpath(
    await mkdtemp(resolve(tmpdir(), "bunaway-nested-sdk-")),
  );
  try {
    const project = await createProject(resolve(home, "app"));
    await command(project, [
      "install",
    ]);
    const valid = await validateProject(project);
    const foreign = resolve(project, "foreign-sdk/index.ts");
    await Bun.write(foreign, 'export const marker = "FOREIGN_SDK_99_0_0";\n');
    for (const [directory, entry, name] of [
      [
        "src/nested",
        "src/main.ts",
        "@bunaway/client",
      ],
      [
        "src-bunaway/nested",
        "src-bunaway/app.ts",
        "@bunaway/core",
      ],
      [
        "shared",
        "src/main.ts",
        "@bunaway/client",
      ],
    ] as const) {
      const parent = resolve(project, directory);
      const source = resolve(parent, "mapped.ts");
      const entryPath = resolve(project, entry);
      const original = await readFile(entryPath, "utf8");
      try {
        await Bun.write(
          source,
          `import { marker } from "${name}"; console.log(marker);\n`,
        );
        await writeJson(resolve(parent, "tsconfig.json"), {
          compilerOptions: {
            paths: {
              [name]: [
                relative(parent, foreign),
              ],
            },
          },
        });
        await Bun.write(
          entryPath,
          `${original}\nimport ${JSON.stringify(`./${relative(dirname(entryPath), source).replaceAll("\\", "/")}`)};\n`,
        );
        await expect(validateProject(project)).rejects.toThrow(
          "Incompatible SDK resolution",
        );
        await expect(
          bundleAssets(valid, resolve(home, "assets")),
        ).rejects.toThrow("Incompatible SDK resolution");
      } finally {
        await writeFile(entryPath, original);
        await rm(parent, {
          recursive: true,
          force: true,
        });
      }
    }
  } finally {
    await rm(home, {
      recursive: true,
      force: true,
    });
  }
}, 30000);

test("nested aliases to pinned SDK sources and unrelated local modules remain valid", async () => {
  const home = await realpath(
    await mkdtemp(resolve(tmpdir(), "bunaway-pinned-alias-")),
  );
  try {
    const project = await createProject(resolve(home, "app"));
    await command(project, [
      "install",
    ]);
    const nested = resolve(project, "src/nested");
    await Bun.write(
      resolve(nested, "message.ts"),
      'export const message = "LOCAL_ALIAS_OK";\n',
    );
    await Bun.write(
      resolve(nested, "mapped.ts"),
      'import * as sdk from "@bunaway/client"; import { message } from "local-message"; console.log(sdk, message);\n',
    );
    await writeJson(resolve(nested, "tsconfig.json"), {
      compilerOptions: {
        paths: {
          "@bunaway/client": [
            "../../node_modules/@bunaway/client/src/index.ts",
          ],
          "local-message": [
            "./message.ts",
          ],
        },
      },
    });
    const assets = resolve(home, "assets");
    await bundleAssets(await validateProject(project), assets);
    expect(
      await Bun.file(resolve(assets, "web/nested/mapped.js")).text(),
    ).toContain("LOCAL_ALIAS_OK");
  } finally {
    await rm(home, {
      recursive: true,
      force: true,
    });
  }
}, 30000);

test("bundling does not reuse the calling process's stale SDK source cache", async () => {
  const home = await realpath(
    await mkdtemp(resolve(tmpdir(), "bunaway-bundle-cache-")),
  );
  try {
    const project = await createProject(resolve(home, "app"));
    await command(project, [
      "install",
    ]);
    const index = resolve(project, "node_modules/@bunaway/client/src/index.ts");
    const original = await readFile(index, "utf8");
    await writeFile(index, `${original}\nconsole.log("STALE_SDK_SOURCE");\n`);
    const cached = await Bun.build({
      entrypoints: [
        resolve(project, "src/main.ts"),
      ],
      target: "browser",
    });
    expect(cached.success).toBe(true);
    expect(await cached.outputs[0]?.text()).toContain("STALE_SDK_SOURCE");
    await writeFile(index, original);
    const valid = await validateProject(project);
    for (const name of [
      "first-assets",
      "second-assets",
    ]) {
      const assets = resolve(home, name);
      await bundleAssets(valid, assets);
      expect(
        await Bun.file(resolve(assets, "web/main.js")).text(),
      ).not.toContain("STALE_SDK_SOURCE");
    }
  } finally {
    await rm(home, {
      recursive: true,
      force: true,
    });
  }
}, 30000);

test("artifact audit rejects omitted schemas, declarations and Git attributes with a regenerated inventory", async () => {
  const home = await realpath(
    await mkdtemp(resolve(tmpdir(), "bunaway-audit-")),
  );
  try {
    const artifact = await packFramework(home);
    const extract = Bun.spawn(
      [
        "tar",
        "-xzf",
        artifact,
        "-C",
        home,
      ],
      {
        stdout: "ignore",
        stderr: "pipe",
      },
    );
    const errors = new Response(extract.stderr).text();
    expect(await extract.exited, await errors).toBe(0);
    const root = resolve(home, "package");
    await checkArtifact(root);
    const inventoryPath = resolve(root, "artifact.files.json");
    const inventory = await readFile(inventoryPath);
    const extra = resolve(root, "native/windows/bun/unexpected.txt");
    await writeFile(extra, "not a native cache");
    await expect(checkArtifact(root)).rejects.toThrow("inventory mismatch");
    await rm(extra);
    const source = resolve(root, "native/windows/bun/boot.ts");
    const sourceOriginal = await readFile(source);
    await writeFile(source, "modified host");
    await expect(checkArtifact(root)).rejects.toThrow("inventory mismatch");
    await writeFile(source, sourceOriginal);
    for (const name of [
      "docs/decisions/0012-integrated-app-build.md",
      "native/host-api/generated/process.schema.json",
      "packages/cli/dist/types/cli/src/index.d.ts",
      "packages/cli/templates/vanilla/gitattributes",
      "packages/cli/templates/vite/gitattributes",
      "packages/cli/templates/vite/src-bunaway/policy.json",
      "packages/cli/templates/react/src/App.tsx",
      "packages/cli/templates/vue/src/components/HelloWorld.vue",
      "packages/cli/templates/svelte/svelte.config.js",
      "packages/cli/templates/svelte/src-bunaway/policy.json",
      "packages/cli/src/assets.ts",
      "packages/cli/src/sdk.ts",
      "packages/cli/src/managed-command.ts",
    ]) {
      const path = resolve(root, name);
      const original = await readFile(path);
      await rm(path);
      await expect(checkArtifact(root)).rejects.toThrow("inventory mismatch");
      const hashes = await snapshotHashes(root);
      delete hashes["artifact.files.json"];
      await writeJson(inventoryPath, hashes);
      await expect(checkArtifact(root)).rejects.toThrow(
        "missing required input",
      );
      await writeFile(path, original);
      await writeFile(inventoryPath, inventory);
    }
  } finally {
    await rm(home, {
      recursive: true,
      force: true,
    });
  }
}, 30000);

test("a standalone plugin install does not install Core, Backend SDK or sibling plugins", async () => {
  const home = await realpath(
    await mkdtemp(resolve(tmpdir(), "bunaway-plugin-only-")),
  );
  try {
    const artifacts = await packageDirectory();
    await writeJson(resolve(home, "package.json"), {
      type: "module",
      dependencies: {
        "@bunaway/plugin-windows": `file:${resolve(artifacts, packageFilename("@bunaway/plugin-windows", "0.0.0"))}`,
      },
    });
    await command(home, [
      "install",
      "--linker",
      "isolated",
    ]);
    const plugin = await installedPackageRoot(home, "@bunaway/plugin-windows");
    const manifest = (await json(resolve(plugin, "package.json"))) as {
      dependencies: Record<string, string>;
    };
    expect(Object.keys(manifest.dependencies).sort()).toEqual([
      "@bunaway/plugin-api",
      "@bunaway/protocol",
    ]);
    for (const name of [
      "@bunaway/core",
      "@bunaway/backend",
      "@bunaway/plugin-storage",
      "@bunaway/plugin-log",
      "@bunaway/plugin-capabilities",
    ]) {
      await expect(installedPackageRoot(plugin, name)).rejects.toThrow();
    }
    const nativeBundle = await Bun.build({
      entrypoints: [
        resolve(plugin, "src/windows.ts"),
      ],
      target: "bun",
    });
    expect(nativeBundle.success).toBe(true);
    const entry = resolve(home, "app.ts");
    await writeFile(
      entry,
      'import { windowsPlugin } from "@bunaway/plugin-windows"; if (windowsPlugin.name !== "windows") throw new Error("Missing window plugin");',
    );
    await command(home, [
      entry,
    ]);
    const built = await Bun.build({
      entrypoints: [
        entry,
      ],
      target: "browser",
      metafile: true,
    });
    expect(built.success).toBe(true);
    const inputs = Object.keys(built.metafile?.inputs ?? {});
    expect(
      inputs.some((name) =>
        /(?:backend-sdk|core|node:async_hooks|src\/windows\.ts)/.test(name),
      ),
    ).toBe(false);
  } finally {
    await rm(home, {
      recursive: true,
      force: true,
    });
  }
}, 60_000);
