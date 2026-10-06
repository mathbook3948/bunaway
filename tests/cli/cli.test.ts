import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, realpath, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { buildProject, bundleAssets } from "../../packages/cli/src/build.ts";
import { validateProject } from "../../packages/cli/src/config.ts";
import { createProject } from "../../packages/cli/src/create.ts";
import { RestartController } from "../../packages/cli/src/dev.ts";
import { writeJson } from "../../packages/cli/src/files.ts";

let home: string;
let project: string;
let originals: Record<string, string>;

beforeAll(async () => {
  home = await realpath(await mkdtemp(resolve(tmpdir(), "bunaway-cli-")));
  const first = resolve(home, "created app");
  await createProject(first);
  project = resolve(home, "relocated app");
  await rename(first, project);
  const child = Bun.spawn([process.execPath, "install"], {
    cwd: project,
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = new Response(child.stdout).text();
  const errors = new Response(child.stderr).text();
  expect(await child.exited, `${await output}\n${await errors}`).toBe(0);
  originals = {};
  for (const name of [
    "src-bunaway/policy.json",
    "src-bunaway/bunaway.json",
    "src-bunaway/src/index.ts",
    "src/main.ts",
  ]) {
    originals[name] = await Bun.file(resolve(project, name)).text();
  }
}, 30000);

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

test("create produces a relocatable project with real SDK dependencies and no repository/sample paths", async () => {
  expect((await validateProject(project)).app.appId).toBe("app.created-app");
  expect(
    await Bun.file(resolve(project, "vendor/bunaway/native/windows/bun/boot.ts")).exists(),
  ).toBe(true);
  const projectPackage = await Bun.file(resolve(project, "package.json")).json();
  expect(projectPackage.dependencies["@bunaway/client"]).toBe("workspace:*");
  const packagingManifest = await Bun.file(
    resolve(project, "vendor/bunaway/packages/packaging/package.json"),
  ).json();
  expect(packagingManifest.name).toBe("@bunaway/packaging");
  const lock = await Bun.file(resolve(project, "bunaway.lock.json")).json();
  expect(lock.release.packages.packaging).toBe("@bunaway/packaging");
  expect(lock.files["packages/packaging/src/index.ts"]).toMatch(/^[a-f0-9]{64}$/);
  expect(
    await Bun.file(
      resolve(project, "vendor/bunaway/docs/decisions/0007-project-settings.md"),
    ).exists(),
  ).toBe(true);
  expect(originals["src-bunaway/src/index.ts"]).not.toContain("examples/memo");
  const process = Bun.spawn(
    [globalThis.process.execPath, "vendor/bunaway/packages/cli/src/main.ts", "validate"],
    {
      cwd: project,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expect(await process.exited).toBe(0);
});

test("create refuses existing paths and missing parents without modifying them", async () => {
  await expect(createProject(project)).rejects.toThrow("exists");
  expect(await Bun.file(resolve(project, "src-bunaway/bunaway.json")).text()).toBe(
    originals["src-bunaway/bunaway.json"] ?? "",
  );
  await expect(createProject(resolve(home, "missing/child"))).rejects.toThrow();
  expect((await readdir(home)).some((name) => name.includes(".creating-"))).toBe(false);
});

test("root configuration remains compatible and duplicate layouts are rejected", async () => {
  const names = ["bunaway.json", "app.json", "policy.json", "packaging.json"];
  const moved: string[] = [];
  const unified = JSON.parse(originals["src-bunaway/bunaway.json"] ?? "");
  try {
    await writeJson(resolve(project, "src-bunaway/bunaway.json"), { version: 1, ...unified.build });
    await writeJson(resolve(project, "src-bunaway/app.json"), unified.app);
    await writeJson(resolve(project, "src-bunaway/packaging.json"), {
      version: 1,
      ...unified.bundle,
    });
    expect((await validateProject(project)).app.appId).toBe(unified.app.appId);
    for (const name of names) {
      await rename(resolve(project, "src-bunaway", name), resolve(project, name));
      moved.push(name);
    }
    expect((await validateProject(project)).frontend).toBe(resolve(project, "src"));
    const child = Bun.spawn(
      [globalThis.process.execPath, "vendor/bunaway/packages/cli/src/main.ts", "validate"],
      { cwd: project, stdout: "pipe", stderr: "pipe" },
    );
    expect(await child.exited).toBe(0);
    await Bun.write(
      resolve(project, "src-bunaway/bunaway.json"),
      originals["src-bunaway/bunaway.json"] ?? "",
    );
    await expect(validateProject(project)).rejects.toThrow("Ambiguous project");
  } finally {
    await rm(resolve(project, "src-bunaway/bunaway.json"), { force: true });
    for (const name of moved) {
      await rename(resolve(project, name), resolve(project, "src-bunaway", name));
    }
    await Bun.write(
      resolve(project, "src-bunaway/bunaway.json"),
      originals["src-bunaway/bunaway.json"] ?? "",
    );
    await rm(resolve(project, "src-bunaway/app.json"), { force: true });
    await rm(resolve(project, "src-bunaway/packaging.json"), { force: true });
  }
});

test("unified settings reject malformed build, app and bundle sections", async () => {
  const path = resolve(project, "src-bunaway/bunaway.json");
  const valid = JSON.parse(originals["src-bunaway/bunaway.json"] ?? "");
  for (const value of [
    { ...valid, version: 99 },
    { ...valid, injected: true },
    { ...valid, build: { ...valid.build, backend: "../outside.ts" } },
    { ...valid, build: { ...valid.build, injected: true } },
    { ...valid, app: { ...valid.app, appId: "../escape" } },
    { ...valid, app: { ...valid.app, home: "https://app.bunaway.local/missing.html" } },
    { ...valid, app: { ...valid.app, injected: true } },
    { ...valid, bundle: { channels: { "unknown-channel": {} } } },
    { ...valid, bundle: { version: 1 } },
    { ...valid, bundle: null },
  ]) {
    try {
      await writeJson(path, value);
      await expect(validateProject(project)).rejects.toThrow();
    } finally {
      await Bun.write(path, originals["src-bunaway/bunaway.json"] ?? "");
    }
  }
});

test("unified settings allow omitted bundle and refuse conflicting split files", async () => {
  const path = resolve(project, "src-bunaway/bunaway.json");
  const valid = JSON.parse(originals["src-bunaway/bunaway.json"] ?? "");
  const { bundle: _bundle, ...withoutBundle } = valid;
  try {
    expect((await readdir(resolve(project, "src-bunaway"))).sort()).toEqual([
      "bunaway.json",
      "policy.json",
      "src",
    ]);
    await writeJson(path, withoutBundle);
    expect((await validateProject(project)).bundle).toBeUndefined();
    const { packageProject } = await import("../../packages/cli/src/package.ts");
    await expect(packageProject(project, "win-direct")).rejects.toThrow("bunaway.json.bundle");
    for (const name of ["app.json", "packaging.json"]) {
      const extra = resolve(project, "src-bunaway", name);
      await writeJson(extra, {});
      try {
        await expect(validateProject(project)).rejects.toThrow(`replaces ${name}`);
      } finally {
        await rm(extra);
      }
    }
  } finally {
    await Bun.write(path, originals["src-bunaway/bunaway.json"] ?? "");
  }
});

test("policy rejects duplicate views, unsafe scope prefixes, unknown permissions and HTTP origins", async () => {
  const policy = JSON.parse(originals["src-bunaway/policy.json"] ?? "");
  for (const invalid of [
    { ...policy, views: [policy.views[0], policy.views[0]] },
    { ...policy, views: [{ ...policy.views[0], origins: ["http://app.bunaway.local"] }] },
    {
      ...policy,
      backend: {
        log: true,
        storage: [{ scope: "appData", pathPrefix: "../escape", access: ["write"] }],
      },
    },
    { ...policy, backend: { log: false, storage: [], arbitraryNativeCall: true } },
  ]) {
    try {
      await writeJson(resolve(project, "src-bunaway/policy.json"), invalid);
      await expect(validateProject(project)).rejects.toThrow();
    } finally {
      await Bun.write(
        resolve(project, "src-bunaway/policy.json"),
        originals["src-bunaway/policy.json"] ?? "",
      );
    }
  }
});

test("generated UI and backend bundle independently; source failures propagate", async () => {
  const assets = resolve(home, "assets");
  await mkdir(resolve(assets, "web"), { recursive: true });
  const valid = await validateProject(project);
  await bundleAssets(valid, assets);
  expect(await Bun.file(resolve(assets, "web/main.js")).text()).toContain("message.saved");
  expect(await Bun.file(resolve(assets, "backend.js")).text()).toContain("messages/current.txt");
  for (const name of ["src-bunaway/src/index.ts", "src/main.ts"]) {
    try {
      await Bun.write(resolve(project, name), "export const broken = ;\n");
      await expect(validateProject(project)).rejects.toThrow(/bundle failed/i);
      await expect(bundleAssets(valid, assets)).rejects.toThrow(/bundle failed/i);
    } finally {
      await Bun.write(resolve(project, name), originals[name] ?? "");
    }
  }
}, 15000);

test("frontend bundles retain nested entry paths and emit imported CSS when there is no collision", async () => {
  const assets = resolve(home, "nested-assets");
  const entry = resolve(project, "src/nested/widget.ts");
  const stylesheet = resolve(project, "src/nested/theme.css");
  try {
    await Bun.write(entry, 'import "./theme.css"; export const widget = 1;\n');
    await Bun.write(stylesheet, ".widget { color: red; }\n");
    await bundleAssets(await validateProject(project), assets);
    expect(await Bun.file(resolve(assets, "web/nested/widget.js")).text()).toContain("widget");
    expect(await Bun.file(resolve(assets, "web/nested/widget.css")).text()).toContain(".widget");
    expect(await Bun.file(resolve(assets, "web/nested/theme.css")).text()).toContain(".widget");
  } finally {
    await rm(resolve(project, "src/nested"), { recursive: true, force: true });
  }
});

test("frontend rejects secondary CSS collisions before writing any assets", async () => {
  const assets = resolve(home, "css-collision-assets");
  const stylesheet = resolve(project, "src/main.css");
  const imported = resolve(project, "src/imported.css");
  const output = resolve(assets, "web/main.css");
  await Bun.write(output, "previous successful output");
  try {
    await Bun.write(stylesheet, ".original { color: blue; }\n");
    await Bun.write(imported, ".imported { color: red; }\n");
    await Bun.write(
      resolve(project, "src/main.ts"),
      `import "./imported.css";\n${originals["src/main.ts"]}`,
    );
    await expect(bundleAssets(await validateProject(project), assets)).rejects.toThrow(
      "Frontend output collision: main.css",
    );
    expect(await Bun.file(output).text()).toBe("previous successful output");
    expect(await readdir(resolve(assets, "web"))).toEqual(["main.css"]);
    expect(await Bun.file(resolve(assets, "backend.js")).exists()).toBe(false);
  } finally {
    await Bun.write(resolve(project, "src/main.ts"), originals["src/main.ts"] ?? "");
    await rm(stylesheet, { force: true });
    await rm(imported, { force: true });
  }
});

test("frontend rejects case-insensitive entry output collisions before writing any assets", async () => {
  const assets = resolve(home, "case-collision-assets");
  const upper = resolve(project, "src/Foo.ts");
  const lower = resolve(project, "src/foo.js");
  const output = resolve(assets, "web/keep.txt");
  await Bun.write(output, "previous successful output");
  try {
    await Bun.write(upper, "export const upper = 1;\n");
    await Bun.write(lower, "export const lower = 2;\n");
    await expect(bundleAssets(await validateProject(project), assets)).rejects.toThrow(
      /Frontend output collision: foo.js/i,
    );
    expect(await Bun.file(output).text()).toBe("previous successful output");
    expect(await readdir(resolve(assets, "web"))).toEqual(["keep.txt"]);
    expect(await Bun.file(resolve(assets, "backend.js")).exists()).toBe(false);
  } finally {
    await rm(upper, { force: true });
    await rm(lower, { force: true });
  }
});

test("frontend rejects case-insensitive collisions between static assets and secondary CSS", async () => {
  const assets = resolve(home, "case-css-collision-assets");
  const stylesheet = resolve(project, "src/MAIN.css");
  const imported = resolve(project, "src/imported.css");
  try {
    await Bun.write(stylesheet, ".original { color: blue; }\n");
    await Bun.write(imported, ".imported { color: red; }\n");
    await Bun.write(
      resolve(project, "src/main.ts"),
      `import "./imported.css";\n${originals["src/main.ts"]}`,
    );
    await expect(bundleAssets(await validateProject(project), assets)).rejects.toThrow(
      /Frontend output collision: main.css/i,
    );
    expect(await Bun.file(resolve(assets, "web/index.html")).exists()).toBe(false);
  } finally {
    await Bun.write(resolve(project, "src/main.ts"), originals["src/main.ts"] ?? "");
    await rm(stylesheet, { force: true });
    await rm(imported, { force: true });
  }
});

test("build rejects corrupted bundled Bun and leaves the last production package intact", async () => {
  const old = resolve(project, "dist/windows-x64/keep.txt");
  await Bun.write(old, "previous successful build");
  const corrupt = resolve(home, "corrupt-bun");
  await Bun.write(corrupt, "not the pinned runtime");
  await expect(
    buildProject(project, {
      native: { target: "windows-x64", bun: corrupt, host: corrupt, licenses: {} },
    }),
  ).rejects.toThrow("Hash mismatch");
  expect(await Bun.file(old).text()).toBe("previous successful build");
  expect((await readdir(resolve(project, "dist"))).some((name) => name.includes("building"))).toBe(
    false,
  );
});

test("package checks platforms and adapters before building and preserves outputs on failure", async () => {
  const child = Bun.spawn(
    [process.execPath, resolve(import.meta.dir, "packaging.fixture.ts"), project],
    { stdout: "pipe", stderr: "pipe" },
  );
  const output = new Response(child.stdout).text();
  const errors = new Response(child.stderr).text();
  expect(await child.exited, `${await output}\n${await errors}`).toBe(0);
}, 60000);

function gate() {
  let release: (() => void) | undefined;
  const promise = new Promise<void>((resolveDone) => {
    release = resolveDone;
  });
  return { promise, release: () => release?.() };
}

test("dev stops the previous host before rebuilding and never starts a stale revision", async () => {
  const calls: string[] = [];
  const started = gate();
  const finish = gate();
  let generation = 0;
  const controller = new RestartController<number>({
    async stop() {
      calls.push("stop");
    },
    async build() {
      const value = ++generation;
      calls.push(`build:${value}`);
      if (value === 1) {
        started.release();
        await finish.promise;
      }
      return value;
    },
    async start(value) {
      calls.push(`start:${value}`);
    },
    error(error) {
      throw error;
    },
  });
  const first = controller.change();
  await started.promise;
  const next = controller.change();
  finish.release();
  await Promise.all([first, next]);
  expect(calls).toEqual(["stop", "build:1", "stop", "build:2", "start:2"]);
  await controller.close();
  expect(calls.at(-1)).toBe("stop");
});

test("dev build failure does not launch old assets; the next edit recovers, close invalidates work", async () => {
  const calls: string[] = [];
  let fails = true;
  const controller = new RestartController<string>({
    async stop() {
      calls.push("stop");
    },
    async build() {
      if (fails) throw new Error("broken source");
      return "fresh";
    },
    async start(value) {
      calls.push(value);
    },
    error() {
      calls.push("error");
    },
  });
  await controller.change();
  expect(calls).toEqual(["stop", "error"]);
  fails = false;
  await controller.change();
  expect(calls).toEqual(["stop", "error", "stop", "fresh"]);
  await controller.close();
  const before = [...calls];
  await controller.change();
  expect(calls).toEqual(before);
});
