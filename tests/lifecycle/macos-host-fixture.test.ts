import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
