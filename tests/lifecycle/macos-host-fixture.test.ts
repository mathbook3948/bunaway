import { afterEach, expect, test } from "bun:test";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function makeFixture(appName = "Signed.app") {
  const root = await mkdtemp(join(tmpdir(), "bunaway-host-fixture-"));
  roots.push(root);
  const app = join(root, appName);
  await mkdir(join(app, "Contents", "Resources"), { recursive: true });
  await writeFile(join(app, "Contents", "Resources", "sealed.txt"), "sealed resource");
  const original = join(root, "package");
  await mkdir(original);
  const host = join(root, "host");
  await writeFile(host, "not executable; setup must fail before spawn");
  return { root, app, original, host };
}

async function rejectsSetup(
  fixture: Awaited<ReturnType<typeof makeFixture>>,
  env: Record<string, string>,
  message: string,
) {
  const entries = await readdir(fixture.root);
  const child = Bun.spawn(
    [process.execPath, resolve(import.meta.dir, "macos-host.ts"), "--package", fixture.original],
    {
      env: {
        ...process.env,
        BUNAWAY_PACKAGE_IN_PLACE: "1",
        BUNAWAY_HOST_EXEC: fixture.host,
        BUNAWAY_NATIVE_TEST_EXEC: fixture.host,
        BUNAWAY_TEST_WORKSPACE: join(fixture.root, "workspace"),
        BUNAWAY_DATA_ROOT: join(fixture.root, "data"),
        BUNAWAY_TEST_SIGN_IDENTITY: "",
        ...env,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const errors = new Response(child.stderr).text();
  expect(await child.exited).not.toBe(0);
  expect(await errors).toContain(message);
  expect(await readdir(fixture.root)).toEqual(entries);
  expect(await readdir(join(fixture.app, "Contents"))).toEqual(["Resources"]);
  expect(await readdir(join(fixture.app, "Contents", "Resources"))).toEqual(["sealed.txt"]);
  expect(await readFile(join(fixture.app, "Contents", "Resources", "sealed.txt"), "utf8")).toBe(
    "sealed resource",
  );
}

test("in-place runner rejects a workspace inside an app before creating scratch or results", async () => {
  const f = await makeFixture();
  await rejectsSetup(
    f,
    { BUNAWAY_TEST_WORKSPACE: join(f.app, "Contents") },
    "test output must be outside .app",
  );
});

test("in-place runner rejects a workspace symlink into an app", async () => {
  const f = await makeFixture();
  const link = join(f.root, "workspace-link");
  await symlink(f.app, link, process.platform === "win32" ? "junction" : "dir");
  await rejectsSetup(
    f,
    { BUNAWAY_TEST_WORKSPACE: join(link, "scratch") },
    "test output resolves inside .app",
  );
});

test("in-place runner rejects a data root inside an app before resetData", async () => {
  const f = await makeFixture();
  await rejectsSetup(
    f,
    { BUNAWAY_DATA_ROOT: join(f.app, "Contents", "data") },
    "test output must be outside .app",
  );
});

test("in-place app resources cannot be mutated by an outside-bundle host", async () => {
  const f = await makeFixture();
  f.original = join(f.app, "Contents", "Resources");
  await rejectsSetup(f, {}, "in-place package and host must be in the same .app");
});

test("signed in-place fixtures require an explicit signing identity before writes", async () => {
  const f = await makeFixture();
  f.original = join(f.app, "Contents", "Resources");
  f.host = join(f.original, "sealed.txt");
  await rejectsSetup(f, {}, "BUNAWAY_TEST_SIGN_IDENTITY is required");
});

for (const output of ["BUNAWAY_TEST_WORKSPACE", "BUNAWAY_DATA_ROOT"]) {
  test(`in-place runner rejects ${output} with a parent component after a symlink`, async () => {
    const f = await makeFixture();
    const link = join(f.root, "output-link");
    await symlink(
      join(f.app, "Contents", "Resources"),
      link,
      process.platform === "win32" ? "junction" : "dir",
    );
    await rejectsSetup(
      f,
      { [output]: `${link}${sep}..${sep}Resources` },
      "test output must not contain parent-directory components",
    );
  });
}

for (const appName of ["Signed.APP", "Signed.App"]) {
  for (const output of ["BUNAWAY_TEST_WORKSPACE", "BUNAWAY_DATA_ROOT"]) {
    test(`in-place runner rejects ${output} inside ${appName}`, async () => {
      const f = await makeFixture(appName);
      await rejectsSetup(
        f,
        { [output]: join(f.app, "Contents", "scratch") },
        "test output must be outside .app",
      );
    });
  }

  test(`in-place runner rejects a workspace symlink into ${appName}`, async () => {
    const f = await makeFixture(appName);
    const link = join(f.root, "workspace-link");
    await symlink(f.app, link, process.platform === "win32" ? "junction" : "dir");
    await rejectsSetup(
      f,
      { BUNAWAY_TEST_WORKSPACE: join(link, "scratch") },
      "test output resolves inside .app",
    );
  });

  test(`${appName} resources cannot be mutated by an outside-bundle host`, async () => {
    const f = await makeFixture(appName);
    f.original = join(f.app, "Contents", "Resources");
    await rejectsSetup(f, {}, "in-place package and host must be in the same .app");
  });

  test(`${appName} fixtures require a signing identity before writes`, async () => {
    const f = await makeFixture(appName);
    f.original = join(f.app, "Contents", "Resources");
    f.host = join(f.original, "sealed.txt");
    await rejectsSetup(f, {}, "BUNAWAY_TEST_SIGN_IDENTITY is required");
  });
}

for (const alias of [false, true]) {
  test(`in-place runner rejects a data root containing the signed fixture${alias ? " via an alias" : ""}`, async () => {
    const f = await makeFixture();
    f.original = join(f.app, "Contents", "Resources");
    f.host = join(f.original, "sealed.txt");
    let dataRoot = f.root;
    if (alias) {
      dataRoot = join(f.root, "parent-alias");
      await symlink(f.root, dataRoot, process.platform === "win32" ? "junction" : "dir");
    }
    await rejectsSetup(
      f,
      { BUNAWAY_DATA_ROOT: dataRoot },
      "test deletion root contains protected path",
    );
  });
}

for (const target of ["workspace", "hostile-host-cwd", "host-home", "macos-host-diagnostics"]) {
  test(`in-place runner rejects a data root containing ${target}`, async () => {
    const f = await makeFixture();
    const workspace = join(f.root, "workspace");
    await rejectsSetup(
      f,
      { BUNAWAY_DATA_ROOT: target === "workspace" ? workspace : join(workspace, target) },
      "test deletion root contains protected path",
    );
  });
}

test("in-place runner rejects diagnostics that contain the fixture", async () => {
  const f = await makeFixture();
  const workspace = join(f.root, "workspace");
  const diagnostics = join(workspace, "macos-host-diagnostics");
  await mkdir(diagnostics, { recursive: true });
  f.original = diagnostics;
  await rejectsSetup(f, {}, "test deletion root contains protected path");
});

for (const output of ["macos-host-results.json", "hostile-host-cwd/.env"]) {
  for (const dangling of [false, true]) {
    test(`in-place runner rejects ${output} symlinks${dangling ? " with a missing target" : " into a sealed resource"}`, async () => {
      const f = await makeFixture();
      const workspace = join(f.root, "workspace");
      const leaf = join(workspace, output);
      await mkdir(resolve(leaf, ".."), { recursive: true });
      const target = dangling
        ? join(f.root, "missing-output.txt")
        : join(f.app, "Contents", "Resources", "sealed.txt");
      await symlink(target, leaf);
      await rejectsSetup(
        f,
        {},
        dangling ? "test output must be a regular file" : "test output resolves inside .app",
      );
      expect(await readdir(resolve(leaf, ".."))).toEqual([output.split("/").at(-1) as string]);
    });
  }
}

test("in-place runner rejects result directories before writing scratch files", async () => {
  const f = await makeFixture();
  await mkdir(join(f.root, "workspace", "macos-host-results.json"), { recursive: true });
  await rejectsSetup(f, {}, "test output must be a regular file");
  expect(await readdir(join(f.root, "workspace"))).toEqual(["macos-host-results.json"]);
});

test.skipIf(process.platform !== "darwin")(
  "failed in-place runner preserves signed tmp symlinks after moving the app",
  async () => {
    const f = await makeFixture();
    const resources = join(f.app, "Contents", "Resources");
    const assets = join(resources, "assets");
    const tmp = join(assets, "tmp");
    await mkdir(join(f.app, "Contents", "MacOS"));
    f.host = join(f.app, "Contents", "MacOS", "host");
    await copyFile("/usr/bin/true", f.host);
    await writeFile(
      join(f.app, "Contents", "Info.plist"),
      `<?xml version="1.0"?><plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>tests.bunaway.fixture</string>
<key>CFBundleExecutable</key><string>host</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>`,
    );
    for (const path of ["assets/app.json", "assets/policy.json", "manifest.json"]) {
      await mkdir(resolve(resources, path, ".."), { recursive: true });
      await writeFile(join(resources, path), "{}\n");
    }
    await mkdir(join(tmp, "nested"), { recursive: true });
    await writeFile(join(tmp, "sentinel.txt"), "original tmp bytes");
    await writeFile(join(tmp, "nested", "sentinel.txt"), "nested tmp bytes");
    await symlink("sentinel.txt", join(tmp, "relative-file"));
    await symlink("nested", join(tmp, "relative-directory"));
    const codesign = (...args: string[]) => {
      const result = Bun.spawnSync(["/usr/bin/codesign", ...args]);
      expect(result.stderr.toString()).not.toContain("invalid destination");
      expect(result.exitCode).toBe(0);
    };
    codesign("--force", "--sign", "-", f.app);
    codesign("--verify", "--deep", "--strict", f.app);

    const workspace = join(f.root, "workspace");
    const child = Bun.spawn(
      [process.execPath, resolve(import.meta.dir, "macos-host.ts"), "--package", resources],
      {
        env: {
          ...process.env,
          BUNAWAY_PACKAGE_IN_PLACE: "1",
          BUNAWAY_HOST_EXEC: f.host,
          BUNAWAY_NATIVE_TEST_EXEC: "/usr/bin/false",
          BUNAWAY_TEST_WORKSPACE: workspace,
          BUNAWAY_DATA_ROOT: join(f.root, "data"),
          BUNAWAY_TEST_SIGN_IDENTITY: "-",
        },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10000,
      },
    );
    const output = new Response(child.stdout).text();
    const errors = new Response(child.stderr).text();
    expect(await child.exited).toBe(1);
    await output;
    for (const directory of [
      tmp,
      join(workspace, "macos-host-diagnostics", "original-assets-tmp"),
    ]) {
      expect(await readlink(join(directory, "relative-file"))).toBe("sentinel.txt");
      expect(await readlink(join(directory, "relative-directory"))).toBe("nested");
    }
    expect(await errors).toContain(
      "native Bun integrity, FIFO, scheme handler and resource-filter regressions failed",
    );
    const summary = JSON.parse(await readFile(join(workspace, "macos-host-results.json"), "utf8"));
    expect(summary.results).toHaveLength(1);
    expect(summary.results[0].ok).toBe(false);
    codesign("--verify", "--deep", "--strict", f.app);

    const moved = join(f.root, "Moved.app");
    await rename(f.app, moved);
    const movedTmp = join(moved, "Contents", "Resources", "assets", "tmp");
    expect(await readFile(join(movedTmp, "relative-file"), "utf8")).toBe("original tmp bytes");
    expect(await readFile(join(movedTmp, "relative-directory", "sentinel.txt"), "utf8")).toBe(
      "nested tmp bytes",
    );
    codesign("--verify", "--deep", "--strict", moved);
  },
);
