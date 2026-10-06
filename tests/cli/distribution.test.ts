import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { packFramework } from "../../packages/cli/scripts/pack.ts";
import { bundleAssets } from "../../packages/cli/src/build.ts";
import { validateProject } from "../../packages/cli/src/config.ts";
import { createProject } from "../../packages/cli/src/create.ts";
import {
  checkArtifact,
  snapshotHashes,
  validateFramework,
} from "../../packages/cli/src/distribution.ts";
import { json, verifyHash, writeJson } from "../../packages/cli/src/files.ts";

async function command(
  cwd: string,
  args: string[],
  executable = process.execPath,
): Promise<string> {
  const child = Bun.spawn([executable, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  const code = await child.exited;
  const output = `${await stdout}\n${await stderr}`;
  if (code !== 0) throw new Error(output);
  return output;
}

test("packed CLI installs outside the checkout, creates a relocatable version-locked SDK/native snapshot", async () => {
  const home = await realpath(await mkdtemp(resolve(tmpdir(), "bunaway-artifact-")));
  try {
    const artifact = await packFramework(resolve(home, "artifacts"));
    const consumer = resolve(home, "consumer");
    await mkdir(consumer);
    await writeJson(resolve(consumer, "package.json"), {
      name: "local-consumer",
      private: true,
      type: "module",
    });
    await command(consumer, ["add", "--exact", artifact]);
    const installed = resolve(consumer, "node_modules/@bunaway/cli");
    await checkArtifact(installed);
    expect(await command(consumer, ["run", "bunaway", "--version"])).toContain("0.0.0");
    expect(
      await command(consumer, [
        "-e",
        "import { createProject } from '@bunaway/cli'; console.log(typeof createProject)",
      ]),
    ).toContain("function");
    await command(consumer, ["add", "--dev", "--exact", "typescript@7.0.2", "@types/bun@1.4.2"]);
    await writeFile(
      resolve(consumer, "api.ts"),
      `
import {
  createProject, validateProject, buildProject, prepareNative,
  currentTarget, devProject, RestartController, doctor,
} from "@bunaway/cli";

const created: Promise<string> = createProject("./typed-app");
const target: "windows-x64" | "macos-arm64" = currentTarget();
const native = prepareNative(target);
const project = await validateProject("./typed-app");
const view: string | undefined = project.policy.views[0]?.id;
const built: Promise<string> = buildProject(project.root).then(value => value.executable);
const healthy: Promise<boolean> = doctor(project.root);
const development: Promise<void> = devProject(project.root);
const controller = new RestartController({
  stop: async () => {}, build: async () => "built",
  start: async (value: string) => {}, error: (error: unknown) => {},
});
// @ts-expect-error createProject requires a path string.
createProject(42);
// @ts-expect-error currentTarget does not return a number.
const invalidTarget: number = currentTarget();
// @ts-expect-error policy retains the protocol's declared structure.
project.policy.invalidField;
// @ts-expect-error RestartController keeps its build result type.
new RestartController<string>({ stop: async () => {}, build: async () => 42, start: async () => {}, error: () => {} });
`,
    );
    for (const modules of [
      { module: "Preserve", moduleResolution: "Bundler" },
      { module: "NodeNext", moduleResolution: "NodeNext" },
    ]) {
      await writeJson(resolve(consumer, "tsconfig.json"), {
        compilerOptions: {
          ...modules,
          target: "ES2022",
          strict: true,
          noEmit: true,
          types: ["bun"],
          skipLibCheck: false,
        },
        include: ["api.ts"],
      });
      await command(consumer, ["run", "tsc", "--project", "tsconfig.json"]);
    }
    for (const directory of [
      "build",
      "runtime/bun-bundle/vendor",
      "native/windows/bun/vendor",
      "native/macos/vendor",
    ]) {
      await mkdir(resolve(installed, directory), { recursive: true });
      await writeFile(resolve(installed, directory, "cache.txt"), "native cache");
    }
    await checkArtifact(installed);
    await command(consumer, ["run", "bunaway", "create", "../created app"]);
    const project = resolve(home, "moved app");
    await rename(resolve(home, "created app"), project);
    await command(project, ["install"]);
    expect(
      await command(consumer, [
        "-e",
        "import { validateProject } from '@bunaway/cli'; await validateProject(process.argv[1]); console.log('valid');",
        project,
      ]),
    ).toContain("valid");
    expect(await command(consumer, ["run", "bunaway", "validate", project])).toContain("valid");
    if (process.env.BUNAWAY_NATIVE_DISTRIBUTION_TEST === "1") {
      await command(consumer, [
        "-e",
        "import { prepareNative } from '@bunaway/cli'; await prepareNative();",
      ]);
      expect(await command(consumer, ["run", "bunaway", "build", project])).toContain("Built");
      await checkArtifact(installed);
      await command(consumer, ["run", "bunaway", "create", "../second app"]);
      await rm(resolve(home, "second app"), { recursive: true, force: true });
    }
    // Removing the installer proves the app only uses its own vendor snapshot.
    await rm(consumer, { recursive: true, force: true });
    await rm(resolve(home, "artifacts"), { recursive: true, force: true });
    expect(await command(project, ["run", "validate"])).toContain("valid");
    await command(project, ["run", "typecheck"]);
    await command(project, ["init"], "git");
    await command(project, ["-c", "core.autocrlf=true", "add", "."], "git");
    const frameworkLock = (await json(resolve(project, "bunaway.lock.json"))) as {
      files: Record<string, string>;
    };
    for (const autocrlf of ["false", "true"]) {
      const checkout = resolve(home, `checkout-${autocrlf}`);
      await mkdir(checkout);
      await command(
        project,
        [
          "-c",
          `core.autocrlf=${autocrlf}`,
          "checkout-index",
          "--all",
          `--prefix=${checkout.replaceAll("\\", "/")}/`,
        ],
        "git",
      );
      expect(await snapshotHashes(resolve(checkout, "vendor/bunaway"))).toEqual(
        frameworkLock.files,
      );
      await command(checkout, ["install", "--frozen-lockfile"]);
      expect(await command(checkout, ["run", "validate"])).toContain("valid");
      await command(checkout, ["run", "typecheck"]);
    }
    if (process.env.BUNAWAY_NATIVE_DISTRIBUTION_TEST === "1") {
      await command(project, ["run", "doctor"]);
      expect(await command(project, ["run", "build"])).toContain("Built");
      const manifestPath =
        process.platform === "win32"
          ? "dist/windows-x64/manifest.json"
          : "dist/macos-arm64/app.created-app.app/Contents/Resources/manifest.json";
      const manifest = (await json(resolve(project, manifestPath))) as {
        bun: { version: string };
        assets: Record<string, string>;
      };
      expect(manifest.bun.version).toBe("1.4.2");
      expect(manifest.assets["licenses/FRAMEWORK-LICENSE.txt"]).toBeDefined();
      expect(manifest.assets["licenses/THIRD-PARTY-NOTICES.txt"]).toBeDefined();
      const resources = resolve(project, manifestPath, "..");
      for (const [name, hash] of Object.entries(manifest.assets)) {
        await verifyHash(resolve(resources, name), hash);
      }
    }
    const sdk = resolve(project, "vendor/bunaway/packages/client-sdk/package.json");
    const original = await readFile(sdk, "utf8");
    await writeJson(sdk, { ...JSON.parse(original), version: "99.0.0" });
    await expect(command(project, ["run", "validate"])).rejects.toThrow("Incompatible SDK");
    await writeFile(sdk, original);
    const framework = resolve(project, "vendor/bunaway/framework.json");
    const release = await readFile(framework, "utf8");
    for (const mutation of [
      { webProtocol: { major: 2, minor: 0 } },
      { processProtocol: { major: 1, minor: 9 } },
      { nativeHost: "99.0.0" },
    ]) {
      await writeJson(framework, { ...JSON.parse(release), ...mutation });
      await expect(command(project, ["run", "validate"])).rejects.toThrow("Incompatible framework");
    }
    await writeFile(framework, release);
    const runtime = resolve(project, "vendor/bunaway/runtime/build-manifests/windows-x64.json");
    const runtimeOriginal = await readFile(runtime, "utf8");
    const pin = JSON.parse(runtimeOriginal);
    pin.bun.version = "99.0.0";
    await writeJson(runtime, pin);
    await expect(command(project, ["run", "validate"])).rejects.toThrow("Incompatible Bun pin");
    await writeFile(runtime, runtimeOriginal);
    const lockPath = resolve(project, "bunaway.lock.json");
    const lockOriginal = await readFile(lockPath, "utf8");
    const lock = JSON.parse(lockOriginal);
    delete lock.files["native/host-api/generated/process.schema.json"];
    await writeJson(lockPath, lock);
    await expect(command(project, ["run", "validate"])).rejects.toThrow(
      "Framework lock is missing required input",
    );
    await writeFile(lockPath, lockOriginal);
    const appPackage = resolve(project, "package.json");
    const appOriginal = await readFile(appPackage, "utf8");
    const app = JSON.parse(appOriginal);
    app.dependencies["@bunaway/client"] = "99.0.0";
    await writeJson(appPackage, app);
    await expect(command(project, ["run", "validate"])).rejects.toThrow("Incompatible Bun/SDK");
    await writeFile(appPackage, appOriginal);
    const foreignSdk = resolve(project, "foreign-client");
    await cp(resolve(project, "vendor/bunaway/packages/client-sdk"), foreignSdk, {
      recursive: true,
    });
    const foreignPackage = (await json(resolve(foreignSdk, "package.json"))) as Record<
      string,
      unknown
    >;
    await writeJson(resolve(foreignSdk, "package.json"), { ...foreignPackage, version: "99.0.0" });
    const foreignDependency = { "@bunaway/client": "file:./foreign-client" };
    for (const field of ["devDependencies", "optionalDependencies", "peerDependencies"]) {
      const app = JSON.parse(appOriginal);
      app[field] = { ...app[field], ...foreignDependency };
      await writeJson(appPackage, app);
      if (field === "devDependencies") {
        await command(project, ["install"]);
        expect(
          await command(project, [
            "-e",
            "console.log(Bun.resolveSync('@bunaway/client', process.cwd()))",
          ]),
        ).toContain("foreign-client");
      }
      await expect(command(project, ["run", "validate"])).rejects.toThrow("Incompatible Bun/SDK");
    }
    const workspaceApp = JSON.parse(appOriginal);
    workspaceApp.devDependencies["@bunaway/client"] = "workspace:*";
    await writeJson(appPackage, workspaceApp);
    await expect(command(project, ["run", "validate"])).rejects.toThrow(
      "Incompatible SDK resolution",
    );
    await command(project, ["install"]);
    expect(await command(project, ["run", "validate"])).toContain("valid");
    await writeFile(appPackage, appOriginal);
    for (const field of ["overrides", "resolutions"]) {
      const app = JSON.parse(appOriginal);
      app[field] = foreignDependency;
      await writeJson(appPackage, app);
      await expect(command(project, ["run", "validate"])).rejects.toThrow("Incompatible Bun/SDK");
      await rm(resolve(project, "node_modules"), { recursive: true, force: true });
      await rm(resolve(project, "bun.lock"), { force: true });
      await command(project, ["install"]);
      expect(
        await command(project, [
          "-e",
          "console.log(Bun.resolveSync('@bunaway/client', process.cwd()))",
        ]),
      ).toContain("foreign-client");
      await expect(command(project, ["run", "validate"])).rejects.toThrow("Incompatible Bun/SDK");
      await expect(command(project, ["run", "build"])).rejects.toThrow("Incompatible Bun/SDK");
      await writeFile(appPackage, appOriginal);
      await expect(command(project, ["run", "validate"])).rejects.toThrow(
        "Incompatible SDK resolution",
      );
      await command(project, ["install"]);
      expect(await command(project, ["run", "validate"])).toContain("valid");
    }
    const tsconfig = resolve(project, "tsconfig.json");
    const tsconfigOriginal = await readFile(tsconfig, "utf8");
    for (const parent of [project, resolve(project, "src/backend"), resolve(project, "src/web")]) {
      const configPath = resolve(parent, "tsconfig.json");
      const root = parent === project;
      const original = root ? JSON.parse(tsconfigOriginal) : {};
      await writeJson(configPath, {
        ...original,
        compilerOptions: {
          ...original.compilerOptions,
          paths: {
            "@bunaway/client": [`${root ? "./" : "../../"}foreign-client/src/index.ts`],
          },
        },
      });
      expect(
        await command(project, [
          "-e",
          `console.log(Bun.resolveSync('@bunaway/client', ${JSON.stringify(parent)}))`,
        ]),
      ).toContain("foreign-client");
      await expect(command(project, ["run", "validate"])).rejects.toThrow(
        "Incompatible SDK resolution",
      );
      if (root) await writeFile(configPath, tsconfigOriginal);
      else await rm(configPath);
      expect(await command(project, ["run", "validate"])).toContain("valid");
    }
    const foreignCore = resolve(project, "foreign-core");
    await cp(resolve(project, "vendor/bunaway/packages/core"), foreignCore, { recursive: true });
    const corePackage = (await json(resolve(foreignCore, "package.json"))) as Record<
      string,
      unknown
    >;
    await writeJson(resolve(foreignCore, "package.json"), { ...corePackage, version: "99.0.0" });
    await writeJson(appPackage, {
      ...JSON.parse(appOriginal),
      overrides: { "@bunaway/core": "file:./foreign-core" },
    });
    await command(project, ["install"]);
    expect(
      await command(project, [
        "-e",
        `console.log(Bun.resolveSync('@bunaway/core', ${JSON.stringify(
          resolve(project, "vendor/bunaway/packages/backend-sdk/src/index.ts"),
        )}))`,
      ]),
    ).toContain("foreign-core");
    await writeFile(appPackage, appOriginal);
    await expect(command(project, ["run", "validate"])).rejects.toThrow(
      "Incompatible SDK resolution",
    );
    await command(project, ["install"]);
    expect(await command(project, ["run", "validate"])).toContain("valid");
    await rm(foreignSdk, { recursive: true, force: true });
    await rm(foreignCore, { recursive: true, force: true });
    await writeFile(resolve(project, "vendor/bunaway/native/windows/bun/boot.ts"), "changed host");
    await expect(command(project, ["run", "validate"])).rejects.toThrow("Hash mismatch");
    await rm(resolve(project, "bunaway.lock.json"));
    await expect(command(project, ["run", "validate"])).rejects.toThrow("legacy project");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 180000);

test("asset workers accept policies larger than the Windows command-line limit", async () => {
  const home = await realpath(await mkdtemp(resolve(tmpdir(), "bunaway-worker args-")));
  try {
    const project = await createProject(resolve(home, "app"));
    await command(project, ["install"]);
    const { policy } = await validateProject(project);
    const view = policy.views[0];
    if (!view) throw new Error("Missing policy view.");
    view.commands = Array.from({ length: 256 }, (_, index) => `command.${index}`.padEnd(128, "a"));
    view.events = Array.from({ length: 256 }, (_, index) => `event.${index}`.padEnd(128, "a"));
    await writeJson(resolve(project, "policy.json"), policy);
    const valid = await validateProject(project);
    const assets = resolve(home, "bundled assets");
    expect(JSON.stringify([valid, assets]).length).toBeGreaterThan(32767);
    await bundleAssets(valid, assets);
    expect(await Bun.file(resolve(assets, "backend.js")).exists()).toBe(true);
    expect(await Bun.file(resolve(assets, "web/main.js")).exists()).toBe(true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 30000);

test("framework validation rejects extra snapshot inputs but permits designated native caches", async () => {
  const home = await realpath(await mkdtemp(resolve(tmpdir(), "bunaway-snapshot-inputs-")));
  try {
    const project = await createProject(resolve(home, "app"));
    await command(project, ["install"]);
    const root = resolve(project, "vendor/bunaway");
    for (const directory of [
      "build",
      "runtime/bun-bundle/vendor",
      "native/windows/bun/vendor",
      "native/macos/vendor",
    ]) {
      await Bun.write(resolve(root, directory, "nested/cache.txt"), "generated native cache");
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
      await expect(validateProject(project)).rejects.toThrow("Unexpected framework snapshot file");
      await rm(path);
    }
    await validateProject(project);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 30000);

test("framework validation rejects reserved SDK override selectors without an install", async () => {
  const home = await realpath(await mkdtemp(resolve(tmpdir(), "bunaway-overrides-")));
  try {
    const project = await createProject(resolve(home, "app"));
    const packagePath = resolve(project, "package.json");
    const original = (await json(packagePath)) as Record<string, unknown>;
    for (const field of ["overrides", "resolutions"]) {
      for (const rule of [
        { "@bunaway/backend": "workspace:*" },
        { "@bunaway/client": "99.0.0" },
        { "@bunaway/core@^0.0.0": "99.0.0" },
        { consumer: { "@bunaway/protocol": "99.0.0" } },
        { "consumer>@bunaway/runtime-bun": "99.0.0" },
        { "**/@bunaway/cli": "99.0.0" },
        { "consumer/**/@bunaway/client": "99.0.0" },
      ]) {
        await writeJson(packagePath, { ...original, [field]: rule });
        await expect(validateFramework(project)).rejects.toThrow("Incompatible Bun/SDK");
      }
    }
    await writeJson(packagePath, {
      ...original,
      overrides: { typescript: "7.0.2" },
      resolutions: { "@types/bun": "1.4.2" },
    });
    await command(project, ["install"]);
    expect(await command(project, ["run", "validate"])).toContain("valid");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 30000);

test("repeated API validation rejects changed SDK links despite Bun's resolver cache", async () => {
  const home = await realpath(await mkdtemp(resolve(tmpdir(), "bunaway-resolution-cache-")));
  try {
    const project = await createProject(resolve(home, "app"));
    await command(project, ["install"]);
    await validateFramework(project);
    expect(Bun.resolveSync("@bunaway/client", project)).toContain("client-sdk");
    await cp(
      resolve(project, "vendor/bunaway/packages/client-sdk"),
      resolve(project, "foreign-client"),
      { recursive: true },
    );
    const packagePath = resolve(project, "package.json");
    const original = await readFile(packagePath, "utf8");
    await writeJson(packagePath, {
      ...JSON.parse(original),
      overrides: { "@bunaway/client": "file:./foreign-client" },
    });
    await command(project, ["install"]);
    expect(
      await command(project, [
        "-e",
        "console.log(Bun.resolveSync('@bunaway/client', process.cwd()))",
      ]),
    ).toContain("foreign-client");
    await writeFile(packagePath, original);
    await expect(validateFramework(project)).rejects.toThrow("Incompatible SDK resolution");
    await command(project, ["install"]);
    await validateFramework(project);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 30000);

test("validation and bundling reject SDK aliases from nested and transitive importers", async () => {
  const home = await realpath(await mkdtemp(resolve(tmpdir(), "bunaway-nested-sdk-")));
  try {
    const project = await createProject(resolve(home, "app"));
    await command(project, ["install"]);
    const valid = await validateProject(project);
    const foreign = resolve(project, "foreign-sdk/index.ts");
    await Bun.write(foreign, 'export const marker = "FOREIGN_SDK_99_0_0";\n');
    for (const [directory, entry, name] of [
      ["src/web/nested", "src/web/main.ts", "@bunaway/client"],
      ["src/backend/nested", "src/backend/index.ts", "@bunaway/core"],
      ["shared", "src/web/main.ts", "@bunaway/client"],
    ] as const) {
      const parent = resolve(project, directory);
      const source = resolve(parent, "mapped.ts");
      const entryPath = resolve(project, entry);
      const original = await readFile(entryPath, "utf8");
      try {
        await Bun.write(source, `import { marker } from "${name}"; console.log(marker);\n`);
        await writeJson(resolve(parent, "tsconfig.json"), {
          compilerOptions: { paths: { [name]: [relative(parent, foreign)] } },
        });
        await Bun.write(
          entryPath,
          `${original}\nimport ${JSON.stringify(`./${relative(dirname(entryPath), source).replaceAll("\\", "/")}`)};\n`,
        );
        await expect(validateProject(project)).rejects.toThrow("Incompatible SDK resolution");
        await expect(bundleAssets(valid, resolve(home, "assets"))).rejects.toThrow(
          "Incompatible SDK resolution",
        );
      } finally {
        await writeFile(entryPath, original);
        await rm(parent, { recursive: true, force: true });
      }
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 30000);

test("nested aliases to pinned SDK sources and unrelated local modules remain valid", async () => {
  const home = await realpath(await mkdtemp(resolve(tmpdir(), "bunaway-pinned-alias-")));
  try {
    const project = await createProject(resolve(home, "app"));
    await command(project, ["install"]);
    const nested = resolve(project, "src/web/nested");
    await Bun.write(resolve(nested, "message.ts"), 'export const message = "LOCAL_ALIAS_OK";\n');
    await Bun.write(
      resolve(nested, "mapped.ts"),
      'import * as sdk from "@bunaway/client"; import { message } from "local-message"; console.log(sdk, message);\n',
    );
    await writeJson(resolve(nested, "tsconfig.json"), {
      compilerOptions: {
        paths: {
          "@bunaway/client": ["../../../vendor/bunaway/packages/client-sdk/src/index.ts"],
          "local-message": ["./message.ts"],
        },
      },
    });
    const assets = resolve(home, "assets");
    await bundleAssets(await validateProject(project), assets);
    expect(await Bun.file(resolve(assets, "web/nested/mapped.js")).text()).toContain(
      "LOCAL_ALIAS_OK",
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 30000);

test("bundling after reinstall does not reuse the calling process's foreign SDK cache", async () => {
  const home = await realpath(await mkdtemp(resolve(tmpdir(), "bunaway-bundle-cache-")));
  try {
    const project = await createProject(resolve(home, "app"));
    await command(project, ["install"]);
    const foreign = resolve(project, "foreign-client");
    await cp(resolve(project, "vendor/bunaway/packages/client-sdk"), foreign, {
      recursive: true,
    });
    const foreignPackage = (await json(resolve(foreign, "package.json"))) as Record<
      string,
      unknown
    >;
    await writeJson(resolve(foreign, "package.json"), { ...foreignPackage, version: "99.0.0" });
    const foreignIndex = resolve(foreign, "src/index.ts");
    await Bun.write(
      foreignIndex,
      `${await readFile(foreignIndex, "utf8")}\nconsole.log("FOREIGN_SDK_99_0_0");\n`,
    );
    const packagePath = resolve(project, "package.json");
    const original = await readFile(packagePath, "utf8");
    await writeJson(packagePath, {
      ...JSON.parse(original),
      overrides: { "@bunaway/client": "file:./foreign-client" },
    });
    await command(project, ["install"]);
    expect(Bun.resolveSync("@bunaway/client", project)).toContain("foreign-client");
    const cached = await Bun.build({
      entrypoints: [resolve(project, "src/web/main.ts")],
      target: "browser",
    });
    expect(cached.success).toBe(true);
    expect(await cached.outputs[0]?.text()).toContain("FOREIGN_SDK_99_0_0");
    await writeFile(packagePath, original);
    await command(project, ["install"]);
    const valid = await validateProject(project);
    expect(Bun.resolveSync("@bunaway/client", project)).toContain("foreign-client");
    for (const name of ["first-assets", "second-assets"]) {
      const assets = resolve(home, name);
      await bundleAssets(valid, assets);
      expect(await Bun.file(resolve(assets, "web/main.js")).text()).not.toContain(
        "FOREIGN_SDK_99_0_0",
      );
      await rm(foreign, { recursive: true, force: true });
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 30000);

test("artifact audit rejects omitted schemas, declarations and Git attributes with a regenerated inventory", async () => {
  const home = await realpath(await mkdtemp(resolve(tmpdir(), "bunaway-audit-")));
  try {
    const artifact = await packFramework(home);
    const extract = Bun.spawn(["tar", "-xzf", artifact, "-C", home], {
      stdout: "ignore",
      stderr: "pipe",
    });
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
      "native/host-api/generated/process.schema.json",
      "packages/cli/dist/types/cli/src/index.d.ts",
      "packages/cli/templates/vanilla/gitattributes",
      "packages/cli/src/assets.ts",
      "packages/cli/src/sdk.ts",
    ]) {
      const path = resolve(root, name);
      const original = await readFile(path);
      await rm(path);
      await expect(checkArtifact(root)).rejects.toThrow("inventory mismatch");
      const hashes = await snapshotHashes(root);
      delete hashes["artifact.files.json"];
      await writeJson(inventoryPath, hashes);
      await expect(checkArtifact(root)).rejects.toThrow("missing required input");
      await writeFile(path, original);
      await writeFile(inventoryPath, inventory);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 30000);
