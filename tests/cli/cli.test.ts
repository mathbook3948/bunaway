import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, realpath, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildProject, bundleAssets } from "../../packages/cli/src/build.ts";
import { validateProject } from "../../packages/cli/src/config.ts";
import { RestartController, shouldRestartHost } from "../../packages/cli/src/dev.ts";
import { writeJson } from "../../packages/cli/src/files.ts";
import { createProject } from "./project.ts";

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
    "src-bunaway/app.ts",
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
    await Bun.file(
      resolve(project, "node_modules/@bunaway/cli/native/windows/bun/boot.ts"),
    ).exists(),
  ).toBe(true);
  const projectPackage = await Bun.file(resolve(project, "package.json")).json();
  expect(projectPackage.dependencies["@bunaway/client"]).toEndWith(".tgz");
  expect(projectPackage.workspaces).toBeUndefined();
  expect(await Bun.file(resolve(project, "bunaway.lock.json")).exists()).toBe(false);
  const packagingManifest = await Bun.file(
    resolve(project, "node_modules/@bunaway/packaging/package.json"),
  ).json();
  expect(packagingManifest.name).toBe("@bunaway/packaging");
  expect(
    await Bun.file(
      resolve(
        project,
        "node_modules/@bunaway/cli/docs/decisions/0010-windows-first-platform-model.md",
      ),
    ).exists(),
  ).toBe(true);
  expect(originals["src-bunaway/app.ts"]).not.toContain("examples/memo");
  const process = Bun.spawn([globalThis.process.execPath, "run", "validate"], {
    cwd: project,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await process.exited).toBe(0);
});

test("vanilla UI checks command and event contracts without bundling backend implementation", async () => {
  const path = resolve(project, "src/main.ts");
  const appPath = resolve(project, "src-bunaway/app.ts");
  const original = originals["src/main.ts"] ?? "";
  async function typecheck() {
    const child = Bun.spawn([process.execPath, "run", "typecheck"], {
      cwd: project,
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = new Response(child.stdout).text();
    const errors = new Response(child.stderr).text();
    const code = await child.exited;
    return { code, output: `${await output}\n${await errors}` };
  }
  try {
    expect((await typecheck()).code).toBe(0);
    for (const suffix of [
      'void client.invoke("message.typo", null);',
      'void client.invoke("message.save", 123);',
      'void client.invoke("message.read", "invalid");',
      'void client.listen("message.typo", () => {}, { onError() {} });',
      'void client.listen("message.saved", (event) => { const value: number = event.payload; void value; }, { onError() {} });',
      'void client.invoke("message.read", null).then((value) => { const number: number = value; void number; });',
    ]) {
      await Bun.write(path, `${original}\n${suffix}\n`);
      const checked = await typecheck();
      expect(checked.code, suffix).not.toBe(0);
      expect(checked.output).toContain("src/main.ts");
    }
    await Bun.write(path, original);
    await Bun.write(
      appPath,
      `console.error("backend-only-type-import-marker");\n${originals["src-bunaway/app.ts"]}`,
    );
    const assets = resolve(home, "typed-ui-assets");
    await bundleAssets(await validateProject(project), assets);
    expect(await Bun.file(resolve(assets, "web/main.js")).text()).not.toContain(
      "backend-only-type-import-marker",
    );
  } finally {
    await Bun.write(path, original);
    await Bun.write(appPath, originals["src-bunaway/app.ts"] ?? "");
  }
}, 30000);

test("create refuses existing paths and missing parents without modifying them", async () => {
  await expect(createProject(project)).rejects.toThrow("exists");
  expect(await Bun.file(resolve(project, "src-bunaway/bunaway.json")).text()).toBe(
    originals["src-bunaway/bunaway.json"] ?? "",
  );
  await expect(createProject(resolve(home, "missing/child"))).rejects.toThrow();
  expect((await readdir(home)).some((name) => name.includes(".creating-"))).toBe(false);
});

test("legacy platform entry settings require an explicit migration to build.app", async () => {
  const path = resolve(project, "src-bunaway/bunaway.json");
  const valid = JSON.parse(originals["src-bunaway/bunaway.json"] ?? "");
  try {
    for (const field of ["backend", "windowsApp"]) {
      await writeJson(path, { ...valid, build: { ...valid.build, [field]: valid.build.app } });
      await expect(validateProject(project)).rejects.toThrow("Use build.app");
    }
  } finally {
    await Bun.write(path, originals["src-bunaway/bunaway.json"] ?? "");
  }
});

test("a single app definition bundles for Windows without executing app source during validation", async () => {
  const entry = resolve(project, "src-bunaway/app.ts");
  const marker = resolve(home, "app-imported.txt");
  const assets = resolve(home, "windows-assets");
  try {
    await Bun.write(
      entry,
      `await Bun.write(${JSON.stringify(marker)}, "imported");\n${originals["src-bunaway/app.ts"]}`,
    );
    const valid = await validateProject(project);
    expect(valid.appEntry).toBe(entry);
    await bundleAssets(valid, assets, true);
    expect(await Bun.file(marker).exists()).toBe(false);
    expect(await Bun.file(resolve(assets, "backend.js")).exists()).toBe(false);
    const app = (await import(pathToFileURL(resolve(assets, "app.js")).href)).default;
    expect(Object.keys(app.commands).sort()).toEqual(["message.read", "message.save"]);
    expect(Object.keys(app.events)).toEqual(["message.saved"]);
    expect(await Bun.file(marker).text()).toBe("imported");
  } finally {
    await Bun.write(entry, originals["src-bunaway/app.ts"] ?? "");
  }
});

test("app definitions must default-export for validation and both platform bundles", async () => {
  const entry = resolve(project, "src-bunaway/app.ts");
  const valid = await validateProject(project);
  try {
    await Bun.write(entry, "export const app = { commands: {}, events: {} };\n");
    await expect(validateProject(project)).rejects.toThrow(/default/i);
    for (const windows of [false, true]) {
      await expect(
        bundleAssets(valid, resolve(home, `missing-default-${windows}`), windows),
      ).rejects.toThrow(/default/i);
    }
  } finally {
    await Bun.write(entry, originals["src-bunaway/app.ts"] ?? "");
  }
});

test("unified v1 configuration rejects malformed sections and old flat settings", async () => {
  const path = resolve(project, "src-bunaway/bunaway.json");
  const valid = JSON.parse(originals["src-bunaway/bunaway.json"] ?? "");
  for (const value of [
    { ...valid, version: 2 },
    { version: 1, ...valid.build },
    { ...valid, injected: true },
    { ...valid, build: { ...valid.build, app: "../outside.ts" } },
    { ...valid, build: { ...valid.build, injected: true } },
    { ...valid, app: { ...valid.app, appId: "../escape" } },
    { ...valid, app: { ...valid.app, home: "https://app.bunaway.local/missing.html" } },
    { ...valid, app: { ...valid.app, injected: true } },
    { ...valid, bundle: { channels: { unknown: {} } } },
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

test("bundle is optional until packaging and generated settings stay beside app modules", async () => {
  const path = resolve(project, "src-bunaway/bunaway.json");
  const valid = JSON.parse(originals["src-bunaway/bunaway.json"] ?? "");
  const { bundle: _bundle, ...withoutBundle } = valid;
  try {
    expect((await readdir(resolve(project, "src-bunaway"))).sort()).toEqual([
      "app.ts",
      "bunaway.json",
      "message",
      "policy.json",
    ]);
    await writeJson(path, withoutBundle);
    expect((await validateProject(project)).bundle).toBeUndefined();
    const { packageProject } = await import("../../packages/cli/src/package.ts");
    await expect(packageProject(project, "win-direct")).rejects.toThrow("bunaway.json.bundle");
  } finally {
    await Bun.write(path, originals["src-bunaway/bunaway.json"] ?? "");
  }
});

test("external development delegates frontend compilation and missing build output to the server", async () => {
  const path = resolve(project, "src-bunaway/bunaway.json");
  const valid = JSON.parse(originals["src-bunaway/bunaway.json"] ?? "");
  const frontend = resolve(project, "src/main.ts");
  try {
    await writeJson(path, {
      ...valid,
      build: { ...valid.build, frontend: "web-output" },
      dev: { command: ["bun", "run", "web:dev"], url: "http://127.0.0.1:5173" },
    });
    await Bun.write(frontend, "this is intentionally not valid JavaScript;");
    const development = await validateProject(project, { development: true });
    expect(development.dev?.url).toBe("http://127.0.0.1:5173/");
    expect(development.policy.views[0]?.origins).toEqual(["https://app.bunaway.local"]);
    expect(shouldRestartHost(development, "src/main.ts")).toBe(false);
    expect(shouldRestartHost(development, "public/icon.png")).toBe(false);
    expect(shouldRestartHost(development, ".next/cache/changed")).toBe(false);
    expect(shouldRestartHost(development, "src-bunaway/app.ts")).toBe(true);
    expect(shouldRestartHost(development, "src-bunaway/bunaway.json")).toBe(true);
    const rootBackend = { ...development, appEntry: resolve(project, "app.ts") };
    expect(shouldRestartHost(rootBackend, "src/main.ts")).toBe(false);
    expect(shouldRestartHost(rootBackend, "public/icon.png")).toBe(false);
    expect(shouldRestartHost(rootBackend, "app.ts")).toBe(true);
    await expect(validateProject(project)).rejects.toThrow();
    const assets = resolve(home, "external-development-assets");
    await mkdir(assets, { recursive: true });
    await bundleAssets(development, assets, false, true);
    expect(await Bun.file(resolve(assets, "backend.js")).exists()).toBe(true);
    expect(await Bun.file(resolve(assets, "web/main.js")).exists()).toBe(false);
  } finally {
    await Bun.write(path, originals["src-bunaway/bunaway.json"] ?? "");
    await Bun.write(frontend, originals["src/main.ts"] ?? "");
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
  for (const name of ["src-bunaway/app.ts", "src/main.ts"]) {
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

test("external development orchestrates UI updates, backend restarts and server replacement", async () => {
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "dev.fixture.ts"), project], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = new Response(child.stdout).text();
  const errors = new Response(child.stderr).text();
  const timer = setTimeout(() => child.kill(), 25000);
  try {
    expect(await child.exited, await errors).toBe(0);
    expect(await output).toContain("PASS frontend HMR ownership");
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
}, 30000);

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
