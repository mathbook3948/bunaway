import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";
import { bundleMacosHost } from "#cli/assets";
import { files, hash, writeJson } from "#cli/files";
import { compileMacosApp } from "#cli/macos-compile";
import { installedPlugins } from "#cli/plugins";
import pin from "../../runtime/build-manifests/darwin-aarch64.json";
import { windowPermissions } from "../fixtures/window-permissions.ts";

assert.equal(process.platform, "darwin");
assert.equal(process.arch, "arm64");
const root = resolve(import.meta.dir, "../..");
/** Documents the app runs through: each phase ends by recreating the window, which revokes its document. */
const FINAL_PHASE = 6;
const directory = await mkdtemp(resolve(tmpdir(), "bunaway-macos-windows-"));
let child: ReturnType<typeof Bun.spawn> | undefined;
try {
  const assets = resolve(directory, "assets");
  await mkdir(resolve(assets, "web"), {
    recursive: true,
  });
  const plugin = Bun.resolveSync("@bunaway/plugin-windows", root);
  const backend = Bun.resolveSync("@bunaway/backend", root);
  const client = Bun.resolveSync("@bunaway/client", root);
  const appEntry = resolve(directory, "app.ts");
  await Bun.write(
    appEntry,
    `
    import {defineApp} from ${JSON.stringify(backend)};
    import windows from ${JSON.stringify(plugin)};
    const FINAL_PHASE = ${FINAL_PHASE};
    let phase = 0;
    let failure;
    export default defineApp({modules: [], plugins: [windows, {name:"startup-check",version:"1",async setup(){
      if (await windows.isOpen() !== true) throw new Error("Setup host routing or grants failed.");
      await windows.recreate();
    }}], events: {}, commands: {
      "test.phase": {input: {const:null}, output: {type:"integer"}, run: async () => ++phase},
      "test.echo": {input: {type:"string"}, output: {type:"string"}, run: async (input) => input},
      "test.report": {input: {}, output: {const:null}, run: async (input) => {
        if (input.ok === false) failure = input;
        if (failure || input.phase === FINAL_PHASE) await Bun.write(process.env.TMPDIR + "/report.json", JSON.stringify(failure ?? input)); return null;
      }}
    }});
  `,
  );
  const spec = {
    view: "main",
    home: "https://app.bunaway.local/main.html",
    title: "macOS API main",
    window: {
      width: 500,
      height: 400,
    },
  };
  const policy = {
    version: 1,
    backend: {
      permissions: [
        ...windowPermissions(),
      ],
    },
    views: [
      {
        id: "main",
        origins: [
          "https://app.bunaway.local",
        ],
        commands: [
          "test.echo",
          "test.report",
          "test.phase",
          ...[
            "isOpen",
            "create",
            "recreate",
            "close",
            "show",
            "hide",
            "focus",
            "isVisible",
            "isFocused",
            "setSize",
            "getOuterBounds",
            "toLogical",
            "getReadiness",
            "showInactive",
            "setContentProtection",
            "isContentProtected",
            "minimize",
            "maximize",
            "unmaximize",
            "restore",
            "toggleMaximize",
            "isMinimized",
            "isMaximized",
            "isFullscreen",
          ].map((name) => `plugin.windows.${name}`),
        ],
        events: [],
        host: {
          permissions: [
            ...windowPermissions(),
          ],
        },
      },
    ],
  };
  await writeJson(resolve(assets, "manifest.json"), {
    format: 1,
    app: {
      appId: "tests.macos.windows",
      ...spec,
    },
    policy,
    plugins: [],
    developmentSdk: {},
  });
  const source = resolve(directory, "web.ts");
  await Bun.write(
    source,
    `
    import {createClient} from ${JSON.stringify(client)};
    import windows from ${JSON.stringify(plugin)};
    const client = createClient();
    const check = (ok, message) => {if (!ok) throw new Error(message);};
    const error = async (work, code) => {try {await work(); throw new Error("Expected " + code);} catch (error) {check(error.code === code, "Expected " + code + ": " + error.message);}};
    const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
    const until = async (work, message) => {
      for (let attempt = 0; attempt < 600; attempt++) {
        if (await work()) return;
        await sleep(10);
      }
      throw new Error("Timed out: " + message);
    };
    const prepared = async () => {
      const state = await windows.getReadiness();
      return state.document === "ready" && state.sdk === "ready";
    };
    const FINAL_PHASE = ${FINAL_PHASE};
    try {
      check(await client.invoke("test.echo", "main") === "main", "view routing");
      const identity = await windows.getReadiness();
      check(identity.viewId === "main" && typeof identity.windowId === "string", "window identity");
      check(await windows.isOpen() === true, "open window");
      const phase = await client.invoke("test.phase", null);
      if (phase === 1) {
        await error(() => windows.create(), "BUSY");
        await windows.hide();
        check(await windows.isVisible() === false, "hide");
        await windows.show();
        check(await windows.isVisible() === true, "show");
        try {await windows.focus(); check(await windows.isFocused(), "focus");} catch (error) {check(error.code === "BUSY", "focus error");}
        // Runtime round trip: protection is off by default and follows each toggle.
        check(await windows.isContentProtected() === false, "content protection default");
        await windows.setContentProtection({contentProtection:true});
        check(await windows.isContentProtected() === true, "content protection enabled");
        await windows.setContentProtection({contentProtection:false});
        check(await windows.isContentProtected() === false, "content protection disabled");
        // State changes: Dock and zoom transitions finish after the call, so each state is polled.
        const state = (minimized, maximized) => async () => await windows.isMinimized() === minimized && await windows.isMaximized() === maximized;
        check(await windows.isMinimized() === false && await windows.isMaximized() === false, "state default");
        check(await windows.isFullscreen() === false, "not fullscreen by default");
        await windows.maximize();
        await until(state(false, true), "maximize");
        await windows.maximize();
        check(await windows.isMaximized() === true, "maximize is idempotent");
        await windows.unmaximize();
        await until(state(false, false), "unmaximize");
        await windows.unmaximize();
        await windows.toggleMaximize();
        await until(state(false, true), "toggleMaximize on");
        await windows.toggleMaximize();
        await until(state(false, false), "toggleMaximize off");
        await windows.minimize();
        await until(state(true, false), "minimize");
        await windows.minimize();
        await windows.restore();
        await until(state(false, false), "restore from minimized");
        await windows.maximize();
        await until(state(false, true), "maximize before restore");
        await windows.restore();
        await until(state(false, false), "restore from maximized");
        await windows.minimize();
        await until(state(true, false), "minimize before maximize");
        await windows.maximize();
        try {await until(state(false, true), "maximize from minimized");} catch (failure) {throw new Error(failure.message + " " + JSON.stringify({minimized: await windows.isMinimized(), maximized: await windows.isMaximized()}));}
        await windows.unmaximize();
        await until(state(false, false), "unmaximize");
        await error(() => windows.setSize({width:400,height:400}), "UNSUPPORTED");
        await error(() => windows.getOuterBounds(), "UNSUPPORTED");
        await error(() => windows.toLogical({value:{width:400,height:400}}), "UNSUPPORTED");
        // Hidden recreation: no visibility, key window change or app activation until showInactive.
        await error(() => windows.recreate({options:{window:{alwaysOnTop:true}}}), "UNSUPPORTED");
        check((await windows.getReadiness()).windowId === identity.windowId, "unsupported option left window open");
        await windows.recreate({options:{visible:false}});
      } else if (phase === 2) {
        check(identity.nativeCreated === true, "hidden readiness identity");
        check(await windows.isVisible() === false, "hidden create");
        await until(prepared, "hidden readiness");
        check(await windows.isVisible() === false, "hidden after ready");
        const focusedBefore = await windows.isFocused();
        await windows.showInactive();
        check(await windows.isVisible() === true, "showInactive visible");
        check(await windows.isFocused() === focusedBefore, "showInactive kept focus");
        // Show once the SDK session is acknowledged.
        await windows.recreate({options:{showWhenReady:"sdk"}});
      } else if (phase === 3) {
        // Read readiness, then visibility, then readiness again, with nothing in between: if the SDK is still not ready after the visibility read, the window was observed hidden before ready.
        const early = await windows.isVisible();
        const after = await windows.getReadiness();
        check(after.windowId === identity.windowId, "same window while checking early visibility");
        if (after.sdk !== "ready") check(early === false, "hidden before sdk ready");
        await until(() => windows.isVisible(), "showWhenReady visibility");
        check((await windows.getReadiness()).sdk === "ready", "visible after sdk ready");
        await windows.recreate();
      } else if (phase < FINAL_PHASE) {
        // A new native lifetime has a new windowId and a fresh document session.
        check(identity.windowId !== undefined, "fresh window");
        await error(() => windows.create(), "BUSY");
        await windows.recreate();
      } else {
        check(phase === FINAL_PHASE, "backend state survives self recreation");
        check(await windows.isOpen() === true, "last-window reservation");
        await client.invoke("test.report", {ok:true, phase});
        await windows.close();
      }
    } catch (error) {
      // A committed self-close/recreation revokes the old document's request.
      if (error.code !== "CANCELLED") await client.invoke("test.report", {ok:false, message:error.message});
    }
  `,
  );
  const web = await Bun.build({
    entrypoints: [
      source,
    ],
    target: "browser",
    outdir: resolve(assets, "web"),
  });
  assert(web.success, web.logs.map(String).join("\n"));
  for (const output of web.outputs) {
    await Bun.write(output.path, await output.arrayBuffer());
  }
  await Bun.write(
    resolve(assets, "web", `${spec.view}.html`),
    '<!doctype html><title>Window API</title><script type="module" src="web.js"></script>',
  );
  const installed = await installedPlugins(root, "0.0.0");
  const bundled = await bundleMacosHost(
    resolve(root, "native/macos/bun"),
    assets,
    appEntry,
    undefined,
    false,
    installed,
  );
  const executable = resolve(directory, "bunaway-host");
  await compileMacosApp(assets, process.execPath, executable, bundled);
  const inventory: Record<string, string> = {};
  for (const file of await files(assets)) {
    inventory[relative(directory, file)] = await hash(file);
  }
  await writeJson(resolve(directory, "manifest.json"), {
    bun: pin.bun,
    assets: inventory,
  });
  const launched = Bun.spawn(
    [
      executable,
      "--package",
      directory,
    ],
    {
      env: {
        ...process.env,
        HOME: directory,
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 45_000,
    },
  );
  child = launched;
  const output = new Response(launched.stdout).text();
  const errors = new Response(launched.stderr).text();
  assert.equal(await launched.exited, 0, await errors);
  await output;
  const dataRoot = resolve(
    directory,
    "Library/Application Support/bunaway/tests.macos.windows",
  );
  const report = await Bun.file(resolve(dataRoot, "temp/report.json")).json();
  assert.deepEqual(report, {
    ok: true,
    phase: FINAL_PHASE,
  });
  const records = (await Bun.file(resolve(dataRoot, "logs/host.log")).text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const sessions = records.filter((record) => record.event === "session-open");
  assert.equal(
    sessions.filter((record) => record.view === "main").length,
    FINAL_PHASE,
  );
  assert.equal(
    new Set(sessions.map((record) => record.context)).size,
    sessions.length,
  );
  assert.equal(
    records.filter((record) => record.event === "host-stopped").length,
    1,
  );
  assert.equal(records.at(-1).failed, false);
  console.log(
    "PASS compiled macOS window API: operation grants, hidden creation, readiness, showInactive, content protection, window state, repeated recreation, fresh sessions and last-window self recreation",
  );
} catch (error) {
  const log = resolve(
    directory,
    "Library/Application Support/bunaway/tests.macos.windows/logs/host.log",
  );
  console.error(
    await Bun.file(log)
      .text()
      .catch(() => "No host log."),
  );
  throw error;
} finally {
  if (child?.exitCode === null) {
    child.kill("SIGKILL");
  }
  await child?.exited;
  await rm(directory, {
    recursive: true,
    force: true,
  });
}
