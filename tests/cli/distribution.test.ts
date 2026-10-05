import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { packFramework } from "../../packages/cli/scripts/pack.ts";
import { checkArtifact, snapshotHashes } from "../../packages/cli/src/distribution.ts";
import { json, verifyHash, writeJson } from "../../packages/cli/src/files.ts";

async function command(cwd: string, args: string[]): Promise<string> {
  const child = Bun.spawn([process.execPath, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
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
    await writeJson(resolve(consumer, "package.json"), { name: "local-consumer", private: true });
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
    await command(consumer, ["run", "bunaway", "create", "../created app"]);
    const project = resolve(home, "moved app");
    await rename(resolve(home, "created app"), project);
    // Removing the installer proves the app only uses its own vendor snapshot.
    await rm(consumer, { recursive: true, force: true });
    await rm(resolve(home, "artifacts"), { recursive: true, force: true });
    await command(project, ["install"]);
    expect(await command(project, ["run", "validate"])).toContain("valid");
    await command(project, ["run", "typecheck"]);
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

test("artifact audit rejects omitted schemas even if someone regenerates the inventory", async () => {
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
    await rm(resolve(root, "native/host-api/generated/process.schema.json"));
    await expect(checkArtifact(root)).rejects.toThrow("inventory mismatch");
    const hashes = await snapshotHashes(root);
    delete hashes["artifact.files.json"];
    await writeJson(resolve(root, "artifact.files.json"), hashes);
    await expect(checkArtifact(root)).rejects.toThrow("missing required input");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 30000);
