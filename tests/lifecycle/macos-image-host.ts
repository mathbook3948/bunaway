import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";
import { bundleMacosHost } from "#cli/assets";
import { files, hash, writeJson } from "#cli/files";
import { compileMacosApp } from "#cli/macos-compile";
import { installedPlugins } from "#cli/plugins";
import pin from "../../runtime/build-manifests/darwin-aarch64.json";

// The host owner wires this success-only fixture into run-native.ts after contextual I/O dispatch.
// It intentionally fails on the UI-only host rather than treating unsupported execution as success.
assert.equal(process.platform, "darwin");
assert.equal(process.arch, "arm64");
const root = resolve(import.meta.dir, "../..");
const directory = await mkdtemp(resolve(tmpdir(), "bunaway-macos-image-host-"));
const appID = "tests.macos.image";
let child: ReturnType<typeof Bun.spawn> | undefined;
try {
  const assets = resolve(directory, "assets");
  await mkdir(resolve(assets, "web"), {
    recursive: true,
  });
  const image = Bun.resolveSync("@bunaway/plugin-image", root);
  const backend = Bun.resolveSync("@bunaway/backend", root);
  const client = Bun.resolveSync("@bunaway/client", root);
  const appEntry = resolve(directory, "app.ts");
  await Bun.write(
    appEntry,
    `
import assert from "node:assert/strict";
import { defineApp } from ${JSON.stringify(backend)};
import { image, imagePlugin } from ${JSON.stringify(image)};
export default defineApp({ modules: [], plugins: [imagePlugin], commands: {
  "test.image": { input: { const: null }, output: { const: true }, async run() {
    try {
      const pixels = { width: 2, height: 1, rgba: Buffer.from([255,0,0,128,17,31,63,0]).toString("base64") };
      const source = await image.createRGBA(pixels);
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
      for (const resource of [source, restored, cropped, nearest, solid, linear, opaque]) {
        assert.equal(await image.dispose({ id: resource.id }), true);
        assert.equal(await image.dispose({ id: resource.id }), false);
      }
      await Bun.write(process.env.TMPDIR + "/report.json", JSON.stringify({ ok: true }));
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
  ];
  await writeJson(resolve(assets, "manifest.json"), {
    format: 1,
    app: {
      appId: appID,
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
          ],
          events: [],
          host: {
            permissions: operations.map((name) => `image.${name}`),
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
const client = createClient();
try { await client.invoke("test.image", null); } finally { window.close(); }
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
    resolve(assets, "web/main.html"),
    '<!doctype html><title>Image host fixture</title><script type="module" src="web.js"></script>',
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
      timeout: 30000,
    },
  );
  child = launched;
  const output = new Response(launched.stdout).text();
  const errors = new Response(launched.stderr).text();
  assert.equal(await launched.exited, 0, await errors);
  await output;
  const dataRoot = resolve(
    directory,
    `Library/Application Support/bunaway/${appID}`,
  );
  const report = await Bun.file(resolve(dataRoot, "temp/report.json")).json();
  assert.deepEqual(report, {
    ok: true,
  });
  const log = await Bun.file(resolve(dataRoot, "logs/host.log")).text();
  const records = log
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(
    records.filter((record) => record.event === "host-stopped").length,
    1,
  );
  assert.equal(records.at(-1).failed, false);
  const evidence = {
    ...report,
    platform: process.platform,
    architecture: process.arch,
    bun: Bun.version,
    revision: Bun.revision,
  };
  await mkdir(resolve(root, "build"), {
    recursive: true,
  });
  await writeJson(
    resolve(root, "build/macos-image-host-results.json"),
    evidence,
  );
  console.log(
    "PASS compiled macOS host, WKWebView command, backend SDK, image I/O routing, codecs, transforms and shutdown",
  );
} catch (error) {
  console.error(
    await Bun.file(
      resolve(
        directory,
        `Library/Application Support/bunaway/${appID}/logs/host.log`,
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
