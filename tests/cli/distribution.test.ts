import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { packFramework } from "../../packages/cli/scripts/pack.ts";
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
      "native/windows/vendor",
      "native/windows/host/vendor",
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
    await writeFile(
      resolve(project, "vendor/bunaway/native/windows/host/host.cpp"),
      "changed host",
    );
    await expect(command(project, ["run", "validate"])).rejects.toThrow("Hash mismatch");
    await rm(resolve(project, "bunaway.lock.json"));
    await expect(command(project, ["run", "validate"])).rejects.toThrow("legacy project");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 180000);

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
    const extra = resolve(root, "native/windows/host/unexpected.txt");
    await writeFile(extra, "not a native cache");
    await expect(checkArtifact(root)).rejects.toThrow("inventory mismatch");
    await rm(extra);
    const source = resolve(root, "native/windows/host/host.cpp");
    const sourceOriginal = await readFile(source);
    await writeFile(source, "modified host");
    await expect(checkArtifact(root)).rejects.toThrow("inventory mismatch");
    await writeFile(source, sourceOriginal);
    for (const name of [
      "native/host-api/generated/process.schema.json",
      "packages/cli/dist/types/cli/src/index.d.ts",
      "packages/cli/templates/vanilla/gitattributes",
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
