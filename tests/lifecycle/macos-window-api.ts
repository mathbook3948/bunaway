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
    let phase = 0;
    let failure;
    const documents = new Map();
    export default defineApp({modules: [], plugins: [windows, {name:"startup-check",version:"1",async setup(){
      const list = await windows.list();
      if (list.length !== 3 || !list.some(item => item.view === "main" && item.open) || !list.some(item => item.view === "reader" && item.open) || !list.some(item => item.view === "lazy" && !item.open)) throw new Error("Setup host routing or grants failed.");
      await windows.recreate({view:"main"});
    }}], events: {}, commands: {
      "test.ready": {input:{type:"string"},output:{const:null},run:async(input)=>{documents.set(input,(documents.get(input) ?? 0)+1);return null;}},
      "test.wait": {input:{type:"object"},output:{const:true},run:async(input, context)=>{while((documents.get(input.view) ?? 0)<input.count) {if(context.signal.aborted) throw new Error("Cancelled wait"); await Bun.sleep(5);}return true;}},
      "test.phase": {input: {const:null}, output: {type:"integer"}, run: async () => ++phase},
      "test.echo": {input: {type:"string"}, output: {type:"string"}, run: async (input) => input},
      "test.report": {input: {}, output: {const:null}, run: async (input) => {
        if (input.ok === false) failure = input;
        if (failure || input.phase === 2) await Bun.write(process.env.TMPDIR + "/report.json", JSON.stringify(failure ?? input)); return null;
      }}
    }});
  `,
  );
  const specs = [
    "main",
    "reader",
    "lazy",
  ].map((view) => ({
    view,
    home: `https://app.bunaway.local/${view}.html`,
    title: `macOS API ${view}`,
    window: {
      width: 500,
      height: 400,
      // Declared protection reaches the NSWindow when the hidden lazy window is created.
      ...(view === "lazy"
        ? {
            contentProtection: true,
          }
        : {}),
    },
    startup: view !== "lazy",
  }));
  const policy = {
    version: 1,
    backend: {
      permissions: [
        ...windowPermissions(),
      ],
    },
    views: specs.map(({ view }) => ({
      id: view,
      origins: [
        "https://app.bunaway.local",
      ],
      commands: [
        "test.echo",
        "test.ready",
        "test.wait",
        "test.report",
        ...(view === "main"
          ? [
              "test.phase",
            ]
          : []),
        ...[
          "list",
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
          "getById",
          "getCurrent",
          "getFocused",
          "getLastActive",
          "listInstances",
          "getReadiness",
          "showInactive",
          "isDestroyed",
          "setContentProtection",
          "isContentProtected",
          "minimize",
          "maximize",
          "unmaximize",
          "restore",
          "toggleMaximize",
          "isMinimized",
          "isMaximized",
        ].map((name) => `plugin.windows.${name}`),
      ],
      events:
        view === "main"
          ? [
              "windows.readiness",
            ]
          : [],
      host: {
        permissions: [
          ...(view === "main"
            ? windowPermissions()
            : [
                "windows.list",
                "windows.getCurrent",
              ]),
        ],
      },
    })),
  };
  await writeJson(resolve(assets, "manifest.json"), {
    format: 1,
    app: {
      appId: "tests.macos.windows",
      title: "Window API",
      windows: specs,
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
    const name = location.pathname.split(".")[0].slice(1);
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
    const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
    const prepared = async (view) => {
      const state = await windows.getReadiness({view});
      return state.document === "ready" && state.sdk === "ready";
    };
    try {
      check(await client.invoke("test.echo", name) === name, "view routing");
      const current = await windows.getCurrent();
      check(current?.viewId === name && typeof current.windowId === "string", "current identity");
      if (name !== "main") {
        const list = await windows.list();
        check(list.length === 3 && list.some(item => item.view === name), "declared catalog");
        await error(() => windows.hide({view:"main"}), "PERMISSION_DENIED");
        await error(() => client.invoke("test.phase", null), "PERMISSION_DENIED");
        await client.invoke("test.ready", name);
      } else {
        const phase = await client.invoke("test.phase", null);
        if (phase === 1) {
          // Subscribe before the hidden window exists so no lazy transition is missed.
          const lazyReadiness = [];
          await client.listen("windows.readiness", (event) => {
            if (event.payload.viewId === "lazy") lazyReadiness.push(event.payload);
          }, {onError: console.error});
          await client.invoke("test.wait", {view:"reader",count:1});
          const list = await windows.list();
          check(list.length === 3 && list.find(item => item.view === "lazy").open === false, "startup false");
          await error(() => windows.hide({view:"unknown"}), "INVALID_ARGUMENT");
          await windows.hide({view:"reader"});
          check(await windows.isVisible({view:"reader"}) === false, "hide");
          await windows.show({view:"reader"});
          check(await windows.isVisible({view:"reader"}) === true, "show");
          let readerFocused = false;
          try {await windows.focus({view:"reader"}); readerFocused = await windows.isFocused({view:"reader"}); check(readerFocused, "focus");} catch (error) {check(error.code === "BUSY", "focus error");}
          // Runtime round trip: protection is off by default and follows each toggle.
          check(await windows.isContentProtected({view:"reader"}) === false, "content protection default");
          await windows.setContentProtection({view:"reader", contentProtection:true});
          check(await windows.isContentProtected({view:"reader"}) === true, "content protection enabled");
          await windows.setContentProtection({view:"reader", contentProtection:false});
          check(await windows.isContentProtected({view:"reader"}) === false, "content protection disabled");
          const instances = await windows.listInstances();
          const mainIdentity = instances.find(item => item.viewId === "main");
          const readerIdentity = instances.find(item => item.viewId === "reader");
          check(mainIdentity && readerIdentity && same(mainIdentity, current), "listInstances");
          check(same(await windows.getById({windowId: current.windowId}), current), "getById");
          check(await windows.getById({windowId: crypto.randomUUID()}) === null, "getById unknown");
          const declared = (identity) => identity === null || instances.some(item => same(item, identity));
          const focused = await windows.getFocused();
          const lastActive = await windows.getLastActive();
          if (readerFocused) {
            check(same(focused, readerIdentity), "focused identity");
            check(same(lastActive, readerIdentity), "last active identity");
          } else {
            check(declared(focused) && declared(lastActive), "focus lookup identity");
          }
          // Hidden creation: no visibility, key window change or app activation until showInactive.
          await windows.create({view:"lazy", options:{visible:false}});
          check(await windows.isVisible({view:"lazy"}) === false, "hidden create");
          const hidden = await windows.getReadiness({view:"lazy"});
          check(hidden.nativeCreated === true && hidden.viewId === "lazy", "hidden readiness identity");
          check(await windows.isContentProtected({view:"lazy"}) === true, "declared content protection");
          await error(() => windows.recreate({view:"lazy", options:{window:{alwaysOnTop:true}}}), "UNSUPPORTED");
          check((await windows.getReadiness({view:"lazy"})).windowId === hidden.windowId, "unsupported option left window open");
          await until(() => prepared("lazy"), "hidden lazy readiness");
          await until(() => lazyReadiness.some((state) => state.windowId === hidden.windowId && state.sdk === "ready"), "hidden lazy readiness event");
          await client.invoke("test.wait", {view:"lazy",count:1});
          check(await windows.isVisible({view:"lazy"}) === false, "hidden after ready");
          const mainFocusedBefore = await windows.isFocused({view:"main"});
          const readerFocusedBefore = await windows.isFocused({view:"reader"});
          await windows.showInactive({view:"lazy"});
          check(await windows.isVisible({view:"lazy"}) === true, "showInactive visible");
          check(await windows.isFocused({view:"lazy"}) === false, "showInactive not focused");
          check(await windows.isFocused({view:"main"}) === mainFocusedBefore, "showInactive kept main focus");
          check(await windows.isFocused({view:"reader"}) === readerFocusedBefore, "showInactive kept reader focus");
          if (readerFocused) check(same(await windows.getLastActive(), readerIdentity), "showInactive kept last active");
          check(await windows.close({view:"lazy"}) === true, "close hidden lazy");
          await until(() => lazyReadiness.some((state) => state.windowId === hidden.windowId && state.document === "cancelled"), "cancelled readiness event");
          const retained = await windows.getReadiness({view:"lazy"});
          check(retained.windowId === hidden.windowId && retained.document === "cancelled" && retained.sdk === "cancelled" && retained.error?.code === "CANCELLED", "retained readiness");
          // A closed lifetime's windowId no longer targets anything.
          check(await windows.getById({windowId: hidden.windowId}) === null, "getById closed");
          check(await windows.isDestroyed({view:"lazy", windowId: hidden.windowId}) === true, "isDestroyed closed");
          await error(() => windows.show({view:"lazy", windowId: hidden.windowId}), "INVALID_ARGUMENT");
          // Show once the SDK session is acknowledged; a new native lifetime has a new ID.
          await windows.create({view:"lazy", options:{showWhenReady:"sdk"}});
          // Read readiness, then visibility, then readiness again, with nothing in between: if the SDK is still not ready after the visibility read, the window was observed hidden before ready.
          const automatic = await windows.getReadiness({view:"lazy"});
          const earlyVisible = await windows.isVisible({view:"lazy"});
          const afterVisibility = await windows.getReadiness({view:"lazy"});
          check(automatic.windowId !== hidden.windowId, "recreated windowId");
          check(await windows.isDestroyed({view:"lazy", windowId: automatic.windowId}) === false, "isDestroyed live");
          check(await windows.isDestroyed({view:"lazy", windowId: hidden.windowId}) === true, "isDestroyed stale");
          await error(() => windows.showInactive({view:"lazy", windowId: hidden.windowId}), "INVALID_ARGUMENT");
          check(afterVisibility.windowId === automatic.windowId, "same window while checking early visibility");
          if (afterVisibility.sdk !== "ready") check(earlyVisible === false, "hidden before sdk ready");
          await until(() => windows.isVisible({view:"lazy"}), "showWhenReady visibility");
          check(lazyReadiness.some((state) => state.windowId === automatic.windowId && state.sdk !== "ready"), "pre-ready state published");
          check((await windows.getReadiness({view:"lazy"})).sdk === "ready", "visible after sdk ready");
          await client.invoke("test.wait", {view:"lazy",count:2});
          await windows.showInactive({view:"lazy", windowId: automatic.windowId});
          check(await windows.isVisible({view:"lazy"}) === true, "showInactive by live windowId");
          check(await windows.close({view:"lazy"}) === true, "close automatic lazy");
          // State changes: Dock and zoom transitions finish after the call, so each state is polled.
          const state = (minimized, maximized) => async () => await windows.isMinimized({view:"reader"}) === minimized && await windows.isMaximized({view:"reader"}) === maximized;
          check(await windows.isMinimized({view:"reader"}) === false && await windows.isMaximized({view:"reader"}) === false, "state default");
          await windows.maximize({view:"reader"});
          await until(state(false, true), "maximize");
          await windows.maximize({view:"reader"});
          check(await windows.isMaximized({view:"reader"}) === true, "maximize is idempotent");
          await windows.unmaximize({view:"reader"});
          await until(state(false, false), "unmaximize");
          await windows.unmaximize({view:"reader"});
          await windows.toggleMaximize({view:"reader"});
          await until(state(false, true), "toggleMaximize on");
          await windows.toggleMaximize({view:"reader"});
          await until(state(false, false), "toggleMaximize off");
          await windows.minimize({view:"reader"});
          await until(state(true, false), "minimize");
          await windows.minimize({view:"reader"});
          check(await windows.isVisible({view:"reader"}) === true, "minimized window stays visible");
          await windows.restore({view:"reader"});
          await until(state(false, false), "restore from minimized");
          await windows.maximize({view:"reader"});
          await until(state(false, true), "maximize before restore");
          await windows.restore({view:"reader"});
          await until(state(false, false), "restore from maximized");
          await windows.minimize({view:"reader"});
          await until(state(true, false), "minimize before maximize");
          await windows.maximize({view:"reader"});
          await until(state(false, true), "maximize from minimized");
          await windows.unmaximize({view:"reader"});
          await until(state(false, false), "unmaximize");
          await error(() => windows.setSize({view:"reader",width:400,height:400}), "UNSUPPORTED");
          await error(() => windows.getOuterBounds({view:"reader"}), "UNSUPPORTED");
          await error(() => windows.toLogical({view:"reader",value:{width:400,height:400}}), "UNSUPPORTED");
          for (let index = 0; index < 3; index++) {
            await windows.create({view:"lazy"});
            await client.invoke("test.wait", {view:"lazy",count:index*2+3});
            await error(() => windows.create({view:"lazy"}), "BUSY");
            await windows.recreate({view:"lazy"});
            await client.invoke("test.wait", {view:"lazy",count:index*2+4});
            check(await windows.close({view:"lazy"}) === true, "close lazy");
            await error(() => windows.isVisible({view:"lazy"}), "INVALID_ARGUMENT");
          }
          check(await windows.close({view:"reader"}) === true, "close reader");
          const afterReaderClose = await windows.getLastActive();
          check(afterReaderClose === null || afterReaderClose.viewId !== "reader", "closed window is not last active");
          await windows.create({view:"reader"});
          check(await windows.close({view:"reader"}) === true, "close recreated reader");
          await windows.recreate({view:"main"});
        } else {
          check(phase === 2, "backend state survives self recreation");
          const list = await windows.list();
          check(list.filter(item => item.open).length === 1, "last-window reservation");
          await client.invoke("test.report", {ok:true, phase});
          await windows.close({view:"main"});
        }
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
  for (const spec of specs) {
    await Bun.write(
      resolve(assets, "web", `${spec.view}.html`),
      '<!doctype html><title>Window API</title><script type="module" src="web.js"></script>',
    );
  }
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
    phase: 2,
  });
  const records = (await Bun.file(resolve(dataRoot, "logs/host.log")).text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const sessions = records.filter((record) => record.event === "session-open");
  assert.equal(sessions.filter((record) => record.view === "main").length, 2);
  assert.equal(
    new Set(sessions.map((record) => record.context)).size,
    sessions.length,
  );
  assert(
    records.some(
      (record) => record.event === "window-created" && record.view === "lazy",
    ),
  );
  assert.equal(
    records.filter((record) => record.event === "host-stopped").length,
    1,
  );
  assert.equal(records.at(-1).failed, false);
  console.log(
    "PASS compiled macOS multi-window API, operation grants, window identity lookup, hidden creation, readiness, showInactive, content protection, repeated creation, fresh sessions and last-window self recreation",
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
