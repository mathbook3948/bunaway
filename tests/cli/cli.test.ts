import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, realpath, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { buildProject, bundleAssets } from "../../packages/cli/src/build.ts";
import { readProjectMetadata, validateProject } from "../../packages/cli/src/config.ts";
import { RestartController, shouldRestartHost } from "../../packages/cli/src/dev.ts";
import { hash, writeJson } from "../../packages/cli/src/files.ts";
import { createProject } from "./project.ts";

let home: string;
let project: string;
let originals: Record<string, string>;

async function stopWebBuilder(pidFile: string): Promise<void> {
  if (process.platform === "win32" || !(await Bun.file(pidFile).exists())) return;
  try {
    process.kill(-Number(await Bun.file(pidFile).text()), "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

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
  const installedCli = resolve(project, "node_modules/@bunaway/cli");
  for (const name of ["docs/development-server.md", "docs/decisions/0009-development-server.md"]) {
    const text = await Bun.file(resolve(installedCli, name)).text();
    expect(text).toContain("0012-integrated-app-build.md");
  }
  expect(
    await Bun.file(resolve(installedCli, "docs/decisions/0012-integrated-app-build.md")).text(),
  ).toContain("build.command");
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
    const insertion = "  await client.listen(";
    expect(original).toContain(insertion);
    for (const suffix of [
      'void client.invoke("message.typo", null);',
      'void client.invoke("message.save", 123);',
      'void client.invoke("message.read", "invalid");',
      'void client.listen("message.typo", () => {}, { onError() {} });',
      'void client.listen("message.saved", (event) => { const value: number = event.payload; void value; }, { onError() {} });',
      'void client.invoke("message.read", null).then((value) => { const number: number = value; void number; });',
    ]) {
      await Bun.write(path, original.replace(insertion, `  ${suffix}\n${insertion}`));
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

test("vanilla UI displays a missing WebView bridge error and keeps saving disabled", async () => {
  const assets = resolve(home, "no-bridge-assets");
  await bundleAssets(await validateProject(project), assets);
  const elements = {
    "#message": { value: "" },
    "#saved": { textContent: "" },
    "#status": { textContent: "Connecting…" },
    "#save": { disabled: true },
  };
  const document = {
    querySelector: (selector: keyof typeof elements) => elements[selector],
  };
  runInNewContext(await Bun.file(resolve(assets, "web/main.js")).text(), {
    window: { document },
    document,
  });
  await new Promise((resolve) => setImmediate(resolve));
  expect(elements["#status"].textContent).toBe(
    "Connection failed: Bunaway bridge is unavailable. Open this page through bunaway dev or the desktop app.",
  );
  expect(elements["#save"].disabled).toBe(true);
});

test("development adds inline maps to local UI and backend bundles on both targets", async () => {
  const valid = await validateProject(project);
  for (const windows of [false, true]) {
    for (const development of [false, true]) {
      const assets = resolve(home, `source-map-assets-${windows}-${development}`);
      await bundleAssets(valid, assets, windows, false, development);
      for (const name of ["web/main.js", windows ? "app.js" : "backend.js"]) {
        const text = await Bun.file(resolve(assets, name)).text();
        const encoded = text.match(/sourceMappingURL=data:application\/json;base64,([^\s]+)/)?.[1];
        expect(encoded !== undefined, name).toBe(development);
        if (encoded) {
          const map = JSON.parse(Buffer.from(encoded, "base64").toString());
          const original = originals[name === "web/main.js" ? "src/main.ts" : "src-bunaway/app.ts"];
          expect(map.sourcesContent).toContain(original);
          expect(map.sources).toContain(
            resolve(
              project,
              name === "web/main.js" ? "src/main.ts" : "src-bunaway/app.ts",
            ).replaceAll("\\", "/"),
          );
        }
      }
    }
  }
});

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
      "tsconfig.json",
    ]);
    await writeJson(path, withoutBundle);
    expect((await validateProject(project)).bundle).toBeUndefined();
    const { packageProject } = await import("../../packages/cli/src/package.ts");
    await expect(packageProject(project, "win-direct")).rejects.toThrow("bunaway.json.bundle");
  } finally {
    await Bun.write(path, originals["src-bunaway/bunaway.json"] ?? "");
  }
});

test("build commands are explicit argv arrays and metadata does not require generated assets", async () => {
  const path = resolve(project, "src-bunaway/bunaway.json");
  const valid = JSON.parse(originals["src-bunaway/bunaway.json"] ?? "");
  try {
    for (const command of [null, "vite build", [], [""], ["bun", 1], ["bun", "bad\0arg"]]) {
      await writeJson(path, { ...valid, build: { ...valid.build, command } });
      await expect(readProjectMetadata(project)).rejects.toThrow("build.command");
    }
    const args = [process.execPath, "run", "build:web", "argument with spaces"];
    await writeJson(path, {
      ...valid,
      build: { ...valid.build, frontend: "not-built", command: args },
    });
    expect((await readProjectMetadata(project)).buildCommand).toEqual(args);
    await expect(validateProject(project)).rejects.toThrow();
    expect(await Bun.file(resolve(project, "not-built/index.html")).exists()).toBe(false);
    const marker = resolve(project, "unexpected-web-build.txt");
    await writeJson(path, {
      ...valid,
      build: {
        ...valid.build,
        command: [process.execPath, "-e", `await Bun.write(${JSON.stringify(marker)}, "built")`],
      },
    });
    await validateProject(project);
    expect(await Bun.file(marker).exists()).toBe(false);
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

test("backend imports outside the app directory are watched and refreshed after validation", async () => {
  const entry = resolve(project, "src-bunaway/app.ts");
  const configPath = resolve(project, "src-bunaway/bunaway.json");
  const config = JSON.parse(originals["src-bunaway/bunaway.json"] ?? "");
  const shared = resolve(project, "shared/watch-value.ts");
  const service = resolve(project, "services/watch-value.ts");
  try {
    await writeJson(configPath, {
      ...config,
      dev: { command: ["bun", "run", "dev"], url: "http://127.0.0.1:5173/" },
    });
    await Bun.write(shared, 'import "../services/watch-value.ts"; console.error("shared");');
    await Bun.write(service, 'console.error("service");');
    await Bun.write(
      entry,
      `import "../shared/watch-value.ts";\n${originals["src-bunaway/app.ts"]}`,
    );
    const first = await validateProject(project, { development: true });
    expect(shouldRestartHost(first, "shared/watch-value.ts")).toBe(true);
    expect(shouldRestartHost(first, "services/watch-value.ts")).toBe(true);
    expect(shouldRestartHost(first, "services")).toBe(true);
    expect(shouldRestartHost(first, "shared/unrelated.ts")).toBe(false);
    expect(shouldRestartHost(first, "src/main.ts")).toBe(false);
    await Bun.write(entry, originals["src-bunaway/app.ts"] ?? "");
    const next = await validateProject(project, { development: true });
    expect(shouldRestartHost(next, "shared/watch-value.ts")).toBe(false);
  } finally {
    await Bun.write(entry, originals["src-bunaway/app.ts"] ?? "");
    await Bun.write(configPath, originals["src-bunaway/bunaway.json"] ?? "");
    await rm(shared, { force: true });
    await rm(service, { force: true });
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
        permissions: [
          "log:write",
          {
            identifier: "storage:write-text",
            allow: [{ scope: "appData", pathPrefix: "../escape" }],
          },
        ],
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

test("Windows development artifacts enable DevTools only with their launch flag", async () => {
  const configPath = resolve(project, "src-bunaway/bunaway.json");
  const settings = JSON.parse(originals["src-bunaway/bunaway.json"] ?? "");
  async function buildFixture(development: boolean) {
    const child = Bun.spawn(
      [
        process.execPath,
        resolve(import.meta.dir, "build.fixture.ts"),
        project,
        ...(development ? ["--development-artifact"] : []),
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const output = new Response(child.stdout).text();
    const errors = new Response(child.stderr).text();
    expect(await child.exited, await errors).toBe(0);
    return output;
  }
  try {
    await buildFixture(false);
    const production = resolve(project, "dist/windows-x64");
    expect(
      (await Bun.file(resolve(production, "assets/app.json")).json()).developmentTools,
    ).toBeUndefined();
    expect(await Bun.file(resolve(production, "assets/app.js")).text()).not.toContain(
      "sourceMappingURL=data:",
    );
    for (const url of [undefined, "http://127.0.0.1:5173/"]) {
      await writeJson(configPath, {
        ...settings,
        ...(url ? { dev: { command: ["bun", "run", "dev:web"], url } } : {}),
      });
      const built = JSON.parse(await buildFixture(true)) as {
        package: string;
        arguments: string[];
      };
      const config = await Bun.file(resolve(built.package, "assets/app.json")).json();
      const manifest = await Bun.file(resolve(built.package, "manifest.json")).json();
      expect(config.developmentTools).toBe(true);
      expect(built.arguments).toContain("--devtools");
      expect(built.arguments.includes("--dev-url")).toBe(url !== undefined);
      expect(config.development?.url).toBe(url);
      expect(manifest.assets["assets/app.json"]).toBe(
        await hash(resolve(built.package, "assets/app.json")),
      );
      expect(await Bun.file(resolve(built.package, "assets/app.js")).text()).toContain(
        "sourceMappingURL=data:",
      );
    }
  } finally {
    await Bun.write(configPath, originals["src-bunaway/bunaway.json"] ?? "");
  }
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

test.each(["SIGINT", "SIGTERM"] as const)(
  "%s during a web build reaps descendants, releases the lock and allows retry",
  async (signal) => {
    const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
    const port = listener.port;
    listener.stop(true);
    if (!port) throw new Error("No test port.");
    const configPath = resolve(project, "src-bunaway/bunaway.json");
    const source = resolve(project, "frontend-signal.ts");
    const ready = resolve(project, "web-descendant-ready.txt");
    const interrupt = resolve(project, "build-interrupt.txt");
    const pid = resolve(project, "web-builder-pid.txt");
    const manifestPath = resolve(project, "dist/windows-x64/manifest.json");
    const manifest = await Bun.file(manifestPath).text();
    const settings = JSON.parse(originals["src-bunaway/bunaway.json"] ?? "");
    await Bun.write(
      source,
      `
    await Bun.write('web-builder-pid.txt', String(process.pid));
    Bun.spawn([process.execPath, '-e', ${JSON.stringify(`
      Bun.serve({hostname:'127.0.0.1', port:${port}, fetch:()=>new Response('descendant')});
      await Bun.write('web-descendant-ready.txt', 'ready');
    `)}], {stdin:'ignore', stdout:'inherit', stderr:'inherit'});
    await Bun.sleep(600000);
  `,
    );
    await writeJson(configPath, {
      ...settings,
      build: { ...settings.build, command: [process.execPath, "frontend-signal.ts"] },
    });
    const child = Bun.spawn(
      [process.execPath, resolve(import.meta.dir, "build-signal.fixture.ts"), project, signal],
      { stdout: "pipe", stderr: "pipe" },
    );
    const output = new Response(child.stdout).text();
    const errors = new Response(child.stderr).text();
    try {
      const deadline = Date.now() + 10000;
      while (!(await Bun.file(ready).exists())) {
        if (child.exitCode !== null || Date.now() >= deadline)
          throw new Error("Web build did not start.");
        await Bun.sleep(20);
      }
      expect((await fetch(`http://127.0.0.1:${port}/`)).ok).toBe(true);
      expect(
        await Bun.file(resolve(project, "dist/.bunaway-locks/windows-x64/build.lock")).exists(),
      ).toBe(true);
      if (process.platform === "win32") await Bun.write(interrupt, signal);
      else child.kill(signal);
      const timeout = setTimeout(() => child.kill(), 10000);
      try {
        expect(await child.exited).not.toBe(0);
      } finally {
        clearTimeout(timeout);
      }
      expect(await output).toContain("PASS build signal handler cleanup");
      expect(await errors).toContain(`cancelled (${signal})`);
      expect(await readdir(resolve(project, "dist/.bunaway-locks/windows-x64"))).toEqual([]);
      expect(await Bun.file(manifestPath).text()).toBe(manifest);
      await expect(
        fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(200) }),
      ).rejects.toThrow();
      await Bun.write(configPath, originals["src-bunaway/bunaway.json"] ?? "");
      const retry = Bun.spawn(
        [process.execPath, resolve(import.meta.dir, "build.fixture.ts"), project],
        {
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const retryOutput = new Response(retry.stdout).text();
      const retryErrors = new Response(retry.stderr).text();
      expect(await retry.exited, `${await retryOutput}\n${await retryErrors}`).toBe(0);
    } finally {
      if (child.exitCode === null) child.kill();
      await child.exited;
      await stopWebBuilder(pid);
      await Promise.all([output, errors]);
      await Bun.write(configPath, originals["src-bunaway/bunaway.json"] ?? "");
      for (const path of [source, ready, interrupt, pid]) await rm(path, { force: true });
    }
  },
  30000,
);

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

for (const failureMode of ["broken-start", "broken-shared", "missing-shared"])
  test(`dev recovers from initial source failure: ${failureMode}`, async () => {
    const child = Bun.spawn(
      [process.execPath, resolve(import.meta.dir, "dev.fixture.ts"), project, failureMode],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const output = new Response(child.stdout).text();
    const errors = new Response(child.stderr).text();
    const timer = setTimeout(() => child.kill(), 25000);
    try {
      const code = await child.exited;
      const stderr = await errors;
      expect(code, stderr).toBe(0);
      expect(stderr).toContain("Dev build failed; fix sources and save to retry");
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
