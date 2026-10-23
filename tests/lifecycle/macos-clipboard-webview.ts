import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";
import { bundleMacosHost } from "#cli/assets";
import { files, hash, writeJson } from "#cli/files";
import { compileMacosApp } from "#cli/macos-compile";
import { installedPlugins } from "#cli/plugins";
import { run } from "#cli/processes";
import { MAX_IMAGE_BYTES } from "#plugins/clipboard/src/contract";
import { macosOperations as clipboardOperations } from "#plugins/clipboard/src/operations";
import { createPasteboard } from "#plugins/clipboard/src/platforms/macos-pasteboard";
import pin from "../../runtime/build-manifests/darwin-aarch64.json";

// The general pasteboard is shared with the desktop. Run this fixture only on
// an explicitly opted-in CI desktop, and clear its test data on every exit.
assert.equal(process.platform, "darwin");
assert.equal(process.arch, "arm64");
assert.equal(process.env.BUNAWAY_CLIPBOARD_NATIVE, "1");
assert.equal(await hash(process.execPath), pin.bun.executableSha256);
const root = resolve(import.meta.dir, "../..");
const directory = await mkdtemp(resolve(tmpdir(), "bunaway-macos-clipboard-"));
const native = createPasteboard();
let child: ReturnType<typeof Bun.spawn> | undefined;
try {
  const assets = resolve(directory, "assets");
  await mkdir(resolve(assets, "web"), {
    recursive: true,
  });
  const plugin = Bun.resolveSync("@bunaway/plugin-clipboard", root);
  const windows = Bun.resolveSync("@bunaway/plugin-windows", root);
  const backend = Bun.resolveSync("@bunaway/backend", root);
  const client = Bun.resolveSync("@bunaway/client", root);
  const appEntry = resolve(directory, "app.ts");
  await Bun.write(
    appEntry,
    `
    import {defineApp} from ${JSON.stringify(backend)};
    import clipboard from ${JSON.stringify(plugin)};
    import windows from ${JSON.stringify(windows)};
    export default defineApp({modules:[], plugins:[clipboard, windows, {
      name:"clipboard-fixture", version:"1",
      async setup() {
        await clipboard.clear(null);
        await clipboard.writeText({text:"backend setup 한글 😀"});
        if (await clipboard.readText(null) !== "backend setup 한글 😀") throw new Error("Backend clipboard dispatch failed");
      }
    }], events:{}, commands:{
      "test.clear": {input:{const:null},output:{const:null},run:()=>clipboard.clear(null)},
      "test.read": {input:{const:null},output:{type:["string","null"]},run:()=>clipboard.readText(null)},
      "test.report": {input:{},output:{const:null},run:async(input)=>{
        await Bun.write(process.env.TMPDIR + "/clipboard-report.json", JSON.stringify(input)); return null;
      }}
    }});
  `,
  );
  const permissions = Object.keys(clipboardOperations).map(
    (operation) => `clipboard.${operation}`,
  );
  await writeJson(resolve(assets, "manifest.json"), {
    format: 1,
    app: {
      appId: "tests.macos.clipboard",
      title: "Clipboard regression",
      windows: [
        {
          view: "main",
          title: "Clipboard regression",
          home: "https://app.bunaway.local/",
          window: {
            width: 500,
            height: 400,
          },
        },
      ],
    },
    policy: {
      version: 1,
      backend: {
        permissions,
      },
      views: [
        {
          id: "main",
          origins: [
            "https://app.bunaway.local",
          ],
          commands: [
            "test.read",
            "test.clear",
            "test.report",
            "plugin.windows.close",
            ...Object.keys(clipboardOperations).map(
              (operation) => `plugin.clipboard.${operation}`,
            ),
          ],
          events: [],
          host: {
            permissions: [
              ...permissions.filter((name) => name !== "clipboard.clear"),
              "windows.close",
            ],
          },
        },
      ],
    },
    plugins: [],
    developmentSdk: {},
  });
  const source = resolve(directory, "web.ts");
  await Bun.write(
    source,
    `
    import {createClient} from ${JSON.stringify(client)};
    import clipboard from ${JSON.stringify(plugin)};
    import windows from ${JSON.stringify(windows)};
    const client = createClient();
    const check = (ok, message) => {if (!ok) throw new Error(message);};
    const same = (left, right, message) => check(JSON.stringify(left) === JSON.stringify(right), message);
    const fails = async (work, code) => {
      try {await work(); throw new Error("Expected " + code);}
      catch (error) {check(error.code === code, "Expected " + code + ": " + error.message);}
    };
    try {
      same(await clipboard.readText(null), "backend setup 한글 😀", "backend setup result");
      await fails(() => clipboard.clear(null), "PERMISSION_DENIED");
      await fails(() => client.invoke("test.clear", null), "PERMISSION_DENIED");
      same(await clipboard.readText(null), "backend setup 한글 😀", "permission before mutation");
      for (const text of ["", "한글 😀\\n\\r\\n", "😀".repeat(16384)]) {
        await clipboard.writeText({text});
        same(await clipboard.readText(null), text, "Unicode round trip");
        same(await client.invoke("test.read", null), text, "command context routing");
      }
      const image = {width:2,height:2,rgba:"/wAAgAD/AP8FBwsAAAAAAQ=="};
      const items = [{format:"text/plain",data:"fallback 한글 😀"},{format:"text/html",data:"<p>한글 😀</p>"},{format:"text/rtf",data:"{\\\\rtf1 \\\\u54620?}"},{format:"image/bmp",data:image}];
      await clipboard.writeFormats({items});
      same(await clipboard.readFormats({formats:items.map(item=>item.format)}), items, "multi-format round trip");
      same(await clipboard.getFormats(null), items.map(item=>item.format), "honest discovery");
      await fails(()=>clipboard.writeFormats({items:[{format:"application/x-bunaway-file-list",data:["C:\\\\memo.txt"]}]}), "INVALID_ARGUMENT");
      same(await clipboard.readText(null), items[0].data, "invalid file path before mutation");
      await fails(()=>clipboard.writeText({text:"x".repeat(16385)}), "INVALID_ARGUMENT");
      same(await clipboard.readText(null), items[0].data, "invalid input before mutation");
      await clipboard.writeImage(image);
      same(await clipboard.readImage(null), image, "RGBA round trip");
      same(await clipboard.readText(null), null, "missing text");
      same(await clipboard.readFormats({formats:["text/html","application/x-bunaway-file-list"]}), [{format:"text/html",data:null},{format:"application/x-bunaway-file-list",data:null}], "missing formats");
      same(await clipboard.hasFormat({format:"application/x-bunaway-file-list"}), false, "no file list on the board");
      const files = ["/tmp/bunaway clipboard/한글 😀.txt", "/tmp/second"];
      await clipboard.writeFormats({items:[{format:"application/x-bunaway-file-list",data:files}]});
      same(await clipboard.readFormats({formats:["application/x-bunaway-file-list"]}), [{format:"application/x-bunaway-file-list",data:files}], "file list round trip");
      same(await clipboard.hasFormat({format:"application/x-bunaway-file-list"}), true, "file list discovery");
      const maximum = {width:512,height:256,rgba:btoa(String.fromCharCode(17).repeat(${MAX_IMAGE_BYTES}))};
      await clipboard.writeImage(maximum);
      same(await clipboard.readImage(null), maximum, "maximum RGBA across WKWebView");
      const oversized = {width:513,height:256,rgba:btoa(String.fromCharCode(17).repeat(513 * 256 * 4))};
      await fails(() => clipboard.writeImage(oversized), "INVALID_ARGUMENT");
      same(await clipboard.readImage(null), maximum, "image limit before mutation");
      const waiting = clipboard.waitForChange(null);
      await new Promise((resolve) => setTimeout(resolve, 50));
      await clipboard.writeText({text:"change probe"});
      const change = await waiting;
      check(Number.isInteger(change.sequence) && change.sequence >= 0 && change.sequence <= 4294967295, "change sequence");
      check(Number.isInteger(change.changedAt) && change.changedAt > 0, "change time");
      same(await clipboard.readText(null), "change probe", "write behind the change");
      // The host-side check after exit expects native image data on the board.
      await clipboard.writeImage(maximum);
      await client.invoke("test.report", {ok:true, unicode:true, formats:true, rgba:true, grants:true, limits:true, change:true});
    } catch(error) {
      await client.invoke("test.report", {ok:false,message:error.message,code:error.code ?? null});
    } finally {try {await windows.close({view:"main"});} catch(error) {if(error.code !== "CANCELLED") throw error;}}
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
    resolve(assets, "web/index.html"),
    '<!doctype html><title>Clipboard regression</title><script type="module" src="web.js"></script>',
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
  await run(
    [
      "/usr/bin/codesign",
      "--force",
      "--sign",
      "-",
      "--entitlements",
      resolve(root, "native/macos/bun/entitlements.plist"),
      executable,
    ],
    root,
  );
  const inventory: Record<string, string> = {};
  for (const file of await files(assets)) {
    inventory[relative(directory, file)] = await hash(file);
  }
  await writeJson(resolve(directory, "manifest.json"), {
    bun: pin.bun,
    assets: inventory,
    host: {
      kind: "bun-compiled",
      target: "macos-arm64",
    },
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
    "Library/Application Support/bunaway/tests.macos.clipboard",
  );
  const report = await Bun.file(
    resolve(dataRoot, "temp/clipboard-report.json"),
  ).json();
  assert.deepEqual(report, {
    ok: true,
    unicode: true,
    formats: true,
    rgba: true,
    grants: true,
    limits: true,
    change: true,
  });
  const records = (await Bun.file(resolve(dataRoot, "logs/host.log")).text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(
    records.filter((record) => record.event === "host-stopped").length,
    1,
  );
  assert.equal(records.at(-1).failed, false);
  assert(
    native.read("image/bmp").data !== null,
    "Native image data must survive the compiled host's exit.",
  );
  await mkdir(resolve(root, "build"), {
    recursive: true,
  });
  await writeJson(resolve(root, "build/macos-clipboard-results.json"), {
    ...report,
    native: "NSPasteboard",
    renderer: "WKWebView",
    bun: Bun.version,
    arch: process.arch,
    cleanup: true,
  });
  console.log(
    "PASS compiled macOS clipboard SDK, WKWebView, backend setup, command context, policy, image limits and cleanup",
  );
} catch (error) {
  console.error(
    await Bun.file(
      resolve(
        directory,
        "Library/Application Support/bunaway/tests.macos.clipboard/logs/host.log",
      ),
    )
      .text()
      .catch(() => "No host log."),
  );
  throw error;
} finally {
  if (child?.exitCode === null) {
    child.kill("SIGKILL");
  }
  await child?.exited;
  native.clear();
  native.dispose();
  await rm(directory, {
    recursive: true,
    force: true,
  });
}
