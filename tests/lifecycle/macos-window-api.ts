import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";
import { bundleMacosHost } from "#cli/assets";
import { files, hash, writeJson } from "#cli/files";
import { compileMacosApp } from "#cli/macos-compile";
import { installedPlugins } from "#cli/plugins";
import pin from "../../runtime/build-manifests/darwin-aarch64.json";

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
    import {windowsPlugin, windows} from ${JSON.stringify(plugin)};
    let phase = 0;
    let failure;
    const documents = new Map();
    export default defineApp({modules: [], plugins: [windowsPlugin, {name:"startup-check",version:"1",async setup(){
      const list = await windows.list();
      if (list.length !== 1 || list[0].view !== "main" || !list[0].open) throw new Error("Setup host routing or grants failed.");
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
  const control = (view: string) => ({
    identifier: "windows:control",
    allow: [
      {
        view,
      },
    ],
  });
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
    },
    startup: view !== "lazy",
  }));
  const policy = {
    version: 1,
    backend: {
      permissions: [
        "windows:list",
        control("main"),
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
        ].map((name) => `plugin.windows.${name}`),
      ],
      events: [],
      host: {
        permissions: [
          "windows:list",
          ...(view === "main"
            ? specs.map(({ view }) => control(view))
            : [
                control(view),
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
    import {windows} from ${JSON.stringify(plugin)};
    const client = createClient();
    const name = location.pathname.split(".")[0].slice(1);
    const check = (ok, message) => {if (!ok) throw new Error(message);};
    const error = async (work, code) => {try {await work(); throw new Error("Expected " + code);} catch (error) {check(error.code === code, "Expected " + code + ": " + error.message);}};
    try {
      check(await client.invoke("test.echo", name) === name, "view routing");
      if (name !== "main") {
        const list = await windows.list();
        check(list.length === 1 && list[0].view === name, "filtered catalog");
        await error(() => windows.hide({view:"main"}), "PERMISSION_DENIED");
        await error(() => client.invoke("test.phase", null), "PERMISSION_DENIED");
        await client.invoke("test.ready", name);
      } else {
        const phase = await client.invoke("test.phase", null);
        if (phase === 1) {
          await client.invoke("test.wait", {view:"reader",count:1});
          const list = await windows.list();
          check(list.length === 3 && list.find(item => item.view === "lazy").open === false, "startup false");
          await error(() => windows.hide({view:"unknown"}), "PERMISSION_DENIED");
          await windows.hide({view:"reader"});
          check(await windows.isVisible({view:"reader"}) === false, "hide");
          await windows.show({view:"reader"});
          check(await windows.isVisible({view:"reader"}) === true, "show");
          try {await windows.focus({view:"reader"}); check(await windows.isFocused({view:"reader"}), "focus");} catch (error) {check(error.code === "BUSY", "focus error");}
          await error(() => windows.setSize({view:"reader",width:400,height:400}), "UNSUPPORTED");
          for (let index = 0; index < 3; index++) {
            await windows.create({view:"lazy"});
            await client.invoke("test.wait", {view:"lazy",count:index*2+1});
            await error(() => windows.create({view:"lazy"}), "BUSY");
            await windows.recreate({view:"lazy"});
            await client.invoke("test.wait", {view:"lazy",count:index*2+2});
            check(await windows.close({view:"lazy"}) === true, "close lazy");
            await error(() => windows.isVisible({view:"lazy"}), "INVALID_ARGUMENT");
          }
          check(await windows.close({view:"reader"}) === true, "close reader");
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
      timeout: 30_000,
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
    "PASS compiled macOS multi-window API, scoped policy, repeated creation, fresh sessions and last-window self recreation",
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
