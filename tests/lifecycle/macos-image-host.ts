import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";
import { bundleMacosHost } from "#cli/assets";
import { files, hash, writeJson } from "#cli/files";
import { compileMacosApp } from "#cli/macos-compile";
import { installedPlugins } from "#cli/plugins";
import { run } from "#cli/processes";
import pin from "../../runtime/build-manifests/darwin-aarch64.json";

// Verify the packaged WKWebView -> backend SDK -> contextual I/O worker path.
// Native adapter probes remain separate from this public host-routing regression.
assert.equal(process.platform, "darwin");
assert.equal(process.arch, "arm64");
const root = resolve(import.meta.dir, "../..");
const directory = await mkdtemp(resolve(tmpdir(), "bunaway-macos-image-host-"));
const appId = "tests.macos.image";
const markerPath = resolve(directory, "image-created.json");
let child: ReturnType<typeof Bun.spawn> | undefined;
try {
  const assets = resolve(directory, "assets");
  await mkdir(resolve(assets, "web"), {
    recursive: true,
  });
  const image = Bun.resolveSync("@bunaway/plugin-image", root);
  const backend = Bun.resolveSync("@bunaway/backend", root);
  const windows = Bun.resolveSync("@bunaway/plugin-windows", root);
  const client = Bun.resolveSync("@bunaway/client", root);
  const appEntry = resolve(directory, "app.ts");
  await Bun.write(
    appEntry,
    `
import assert from "node:assert/strict";
import { defineApp } from ${JSON.stringify(backend)};
import image from ${JSON.stringify(image)};
import windows from ${JSON.stringify(windows)};
let setupId;
let sharedId;
let deniedResult;
export default defineApp({ modules: [], plugins: [image, windows, {
  name: "image-setup", version: "1", async setup() {
    setupId = (await image.createRGBA({ width: 0, height: 0, rgba: "" })).id;
  }
}], commands: {
  "test.created": { input: { const: null }, output: { type: "string" }, async run(_input, context) {
    const markerPath = ${JSON.stringify(markerPath)};
    const deadline = Date.now() + 10000;
    // A BunFile caches a missing file, so each poll must observe a fresh handle.
    while (!await Bun.file(markerPath).exists()) {
      if (context.signal.aborted) throw new Error("Cancelled creation probe.");
      if (Date.now() > deadline) throw new Error("Image creation did not reach the held result boundary.");
      await Bun.sleep(5);
    }
    return (await Bun.file(markerPath).json()).id;
  } },
  "test.complete": { input: { const: null }, output: { const: null }, async run() {
    await Bun.write(process.env.TMPDIR + "/report.json", JSON.stringify({ ok: true, permissionDenied: true, setup: true, cancellation: true }));
    return null;
  } },
  "test.failure": { input: { type: "string" }, output: { const: null }, async run(error) {
    await Bun.write(process.env.TMPDIR + "/report.json", JSON.stringify({ ok: false, error }));
    return null;
  } },
  "test.id": { input: { const: null }, output: { type: "string" }, async run(_input, context) {
    const deadline = Date.now() + 10000;
    while (!sharedId) {
      if (context.signal.aborted) throw new Error("Image caller was cancelled.");
      if (Date.now() > deadline) throw new Error("Image creation did not reach the I/O worker.");
      await Bun.sleep(5);
    }
    return sharedId;
  } },
  "test.denial": { input: { type: "boolean" }, output: { const: null }, run(value) { deniedResult = value; return null; } },
  "test.image": { input: { const: null }, output: { const: true }, async run() {
    try {
      assert(setupId, "Backend setup must create resources through the I/O worker.");
      assert.deepEqual({ ...await image.getInfo({ id: setupId }) }, { width: 0, height: 0, empty: true });
      assert.equal(await image.dispose({ id: setupId }), true);
      await assert.rejects(image.createBytes({ mime: "image/png", data: "AA==" }), { code: "INVALID_ARGUMENT" });
      const pixels = { width: 2, height: 1, rgba: Buffer.from([255,0,0,128,17,31,63,0]).toString("base64") };
      const source = await image.createRGBA(pixels);
      sharedId = source.id;
      assert.deepEqual({ ...await image.getPixels({ id: source.id }) }, pixels);
      const png = await image.exportBytes({ id: source.id, format: "image/png" });
      const restored = await image.createBytes(png);
      assert.deepEqual({ ...await image.getPixels({ id: restored.id }) }, pixels);
      const cropped = await image.crop({ id: source.id, x: 1, y: 0, width: 1, height: 1 });
      assert.equal((await image.getPixels({ id: cropped.id })).rgba, Buffer.from([17,31,63,0]).toString("base64"));
      const nearest = await image.resize({ id: source.id, width: 1, height: 1, interpolation: "nearest" });
      assert.equal((await image.getPixels({ id: nearest.id })).rgba, Buffer.from([17,31,63,0]).toString("base64"));
      const solid = await image.createRGBA({ width: 1, height: 1, rgba: "/wAAgA==" });
      const linear = await image.resize({ id: solid.id, width: 2, height: 2 });
      assert.deepEqual({ ...await image.getInfo({ id: linear.id }) }, { width: 2, height: 2, empty: false });
      const opaque = await image.createRGBA({ width: 1, height: 1, rgba: "FVGN/w==" });
      for (const format of ["image/jpeg", "image/bmp"]) {
        const bytes = await image.exportBytes({ id: opaque.id, format });
        const decoded = await image.createBytes(bytes);
        assert.deepEqual({ ...await image.getInfo({ id: decoded.id }) }, { width: 1, height: 1, empty: false });
        await image.dispose({ id: decoded.id });
      }
      const deniedDeadline = Date.now() + 10000;
      while (deniedResult === undefined) {
        if (Date.now() > deniedDeadline) throw new Error("Read-only view did not complete its permission checks.");
        await Bun.sleep(5);
      }
      assert.equal(deniedResult, true, "Read-only view must allow getInfo and deny getPixels for the same app-owned ID.");
      for (const resource of [source, restored, cropped, nearest, solid, linear, opaque]) {
        assert.equal(await image.dispose({ id: resource.id }), true);
        assert.equal(await image.dispose({ id: resource.id }), false);
      }
      console.log("PASS real host image setup, codecs, transforms, independent view grants and disposal");
      return true;
    } catch (error) {
      await Bun.write(process.env.TMPDIR + "/report.json", JSON.stringify({ ok: false, error: String(error), code: error?.code }));
      throw error;
    }
  } }
} });
`,
  );
  const operations = [
    "createRGBA",
    "createBytes",
    "createDataURL",
    "getInfo",
    "getPixels",
    "exportBytes",
    "exportDataURL",
    "dispose",
    "crop",
    "resize",
  ];
  const specs = [
    {
      view: "main",
      home: "https://app.bunaway.local/main.html",
      title: "Image host fixture",
      window: {
        width: 400,
        height: 300,
      },
    },
    {
      view: "reader",
      home: "https://app.bunaway.local/reader.html",
      title: "Read-only image view",
      window: {
        width: 300,
        height: 200,
      },
    },
  ];
  await writeJson(resolve(assets, "manifest.json"), {
    format: 1,
    app: {
      appId,
      title: "Image host fixture",
      windows: specs,
    },
    policy: {
      version: 1,
      backend: {
        permissions: operations.map((name) => `image.${name}`),
      },
      views: [
        {
          id: "main",
          origins: [
            "https://app.bunaway.local",
          ],
          commands: [
            "test.image",
            "test.created",
            "test.failure",
            "test.complete",
            "plugin.image.createRGBA",
            "plugin.image.getInfo",
            "plugin.windows.close",
          ],
          events: [],
          host: {
            permissions: [
              ...operations.map((name) => `image.${name}`),
              "windows.close",
            ],
          },
        },
        {
          id: "reader",
          origins: [
            "https://app.bunaway.local",
          ],
          commands: [
            "test.id",
            "test.denial",
            "plugin.image.getInfo",
            "plugin.image.getPixels",
            "plugin.windows.close",
          ],
          events: [],
          host: {
            permissions: [
              "image.getInfo",
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
    `import { createClient } from ${JSON.stringify(client)};
import image from ${JSON.stringify(image)};
import windows from ${JSON.stringify(windows)};
const close = async (view) => {
  try { await windows.close({ view }); } catch (error) {
    if (error?.code !== "CANCELLED") throw error;
  }
};
const client = createClient();
if (location.pathname === "/reader.html") {
  let ok = false;
  try {
    const id = await client.invoke("test.id", null);
    let denied = false;
    try { await image.getPixels({ id }); } catch (error) { denied = error?.code === "PERMISSION_DENIED"; }
    if (!denied) throw new Error("Read-only getPixels permission was not enforced.");
    const info = await image.getInfo({ id });
    if (info.width !== 2 || info.height !== 1 || info.empty) throw new Error("Read-only getInfo cannot see the app-owned ID.");
    ok = true;
  } finally { await client.invoke("test.denial", ok); await close("reader"); }
} else {
  try {
    await client.invoke("test.image", null);
    const controller = new AbortController();
    const pending = image.createRGBA({ width: 1, height: 1, rgba: "CAcGBQ==" }, { signal: controller.signal }).then(
      () => false, (error) => error?.code === "CANCELLED"
    );
    const id = await client.invoke("test.created", null);
    controller.abort();
    if (!await pending) throw new Error("Held image creation was not cancelled.");
    let discarded = false;
    try { await image.getInfo({ id }); } catch (error) { discarded = error?.code === "INVALID_ARGUMENT"; }
    if (!discarded) throw new Error("Undelivered image resource survived cancellation during synchronous I/O.");
    await client.invoke("test.complete", null);
  } catch (error) { await client.invoke("test.failure", String(error)); }
  finally { await close("main"); }
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
      '<!doctype html><title>Image host fixture</title><script type="module" src="web.js"></script>',
    );
  }
  const installed = await installedPlugins(root, "0.0.0");
  const imageEntry = installed.find((plugin) => plugin.name === "image");
  assert(imageEntry?.targets.macos, "Installed image I/O adapter must exist.");
  const imageTarget = imageEntry.targets.macos;
  const heldEntry = resolve(directory, "held-image.ts");
  await Bun.write(
    heldEntry,
    `
import plugin from ${JSON.stringify(resolve(root, "plugins/image/dist/native/macos.js"))};
const definition = plugin._definition;
import { writeFileSync } from "node:fs";
export default { _definition: { ...definition, nativePlatforms: { ...definition.nativePlatforms,
  macos: { thread: "worker", create(environment) {
    const adapter = definition.nativePlatforms.macos.create(environment);
    const prepare = adapter.prepare.bind(adapter);
    return { ...adapter, async prepare(name, input, source, context) {
      const execute = await prepare(name, input, source, context);
      return async () => {
        const result = await execute();
        if (name === "image.createRGBA" && input.rgba === "CAcGBQ==") {
          // The actual image adapter has allocated an ID. Keep the worker synchronously busy
          // while the actual WebView sends cancellation, as a native codec call can do.
          writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify(result));
          console.log("Held image resource allocated before synchronous result delay");
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
        }
        return result;
      };
    } };
  } }
} } };
`,
  );
  const fixturePlugins = installed.map((plugin) =>
    plugin === imageEntry
      ? {
          ...plugin,
          targets: {
            ...plugin.targets,
            macos: {
              ...imageTarget,
              operations: heldEntry,
            },
          },
        }
      : plugin,
  );
  const bundled = await bundleMacosHost(
    resolve(root, "native/macos/bun"),
    assets,
    appEntry,
    undefined,
    false,
    fixturePlugins,
  );
  const executable = resolve(directory, "bunaway-host");
  await compileMacosApp(assets, process.execPath, executable, bundled);
  await run(
    [
      "codesign",
      "--force",
      "--sign",
      "-",
      "--entitlements",
      resolve(root, "native/macos/bun/entitlements.plist"),
      executable,
    ],
    root,
  );
  await run(
    [
      "codesign",
      "--verify",
      "--strict",
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
  });
  const startedAt = performance.now();
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
      timeout: 30000,
    },
  );
  child = launched;
  const output = new Response(launched.stdout).text();
  const errors = new Response(launched.stderr).text();
  assert.equal(await launched.exited, 0, await errors);
  const elapsedMs = performance.now() - startedAt;
  assert(
    elapsedMs < 25000,
    "Native windows must close and stop the host before the subprocess timeout sends SIGTERM.",
  );
  const stdout = await output;
  if (stdout.trim()) {
    console.log(stdout);
  }
  const dataRoot = resolve(
    directory,
    `Library/Application Support/bunaway/${appId}`,
  );
  const report = await Bun.file(resolve(dataRoot, "temp/report.json")).json();
  // Retain failed phase evidence as well as successful results in the CI artifact.
  await mkdir(resolve(root, "build"), {
    recursive: true,
  });
  await writeJson(resolve(root, "build/macos-image-host-results.json"), {
    ...report,
    elapsedMs,
    platform: process.platform,
    architecture: process.arch,
    bun: Bun.version,
    revision: Bun.revision,
  });
  assert.deepEqual(report, {
    ok: true,
    permissionDenied: true,
    setup: true,
    cancellation: true,
  });
  const log = await Bun.file(resolve(dataRoot, "logs/host.log")).text();
  const records = log
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    records
      .filter((record) => record.event === "window-closed")
      .map((record) => record.view)
      .sort(),
    [
      "main",
      "reader",
    ],
  );
  assert.equal(
    records.filter((record) => record.event === "host-stopped").length,
    1,
  );
  assert.equal(records.at(-1).failed, false);
  console.log(
    "PASS compiled macOS host, WKWebView command, backend SDK, image I/O routing, codecs, transforms and shutdown",
  );
} catch (error) {
  console.error(
    await Bun.file(
      resolve(
        directory,
        `Library/Application Support/bunaway/${appId}/logs/host.log`,
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
  await rm(directory, {
    recursive: true,
    force: true,
  });
}
