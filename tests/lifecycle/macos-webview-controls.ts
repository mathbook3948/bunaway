import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";
import { bundleMacosHost } from "#cli/assets";
import { files, hash, writeJson } from "#cli/files";
import { compileMacosApp } from "#cli/macos-compile";
import { installedPlugins } from "#cli/plugins";
import pin from "../../runtime/build-manifests/darwin-aarch64.json";
import { captureMacosNativeChild } from "../fixtures/macos-startup-diagnostics.ts";
import { printNativeChildDiagnostics } from "../fixtures/native-child-diagnostics.ts";

assert.equal(process.platform, "darwin");
assert.equal(process.arch, "arm64");
const root = resolve(import.meta.dir, "../..");
const directory = await mkdtemp(
  resolve(tmpdir(), "bunaway-macos-webview-controls-"),
);
const result = resolve(root, "build/macos-webview-controls-results.json");
const diagnostics = resolve(root, "build/macos-webview-controls-diagnostics");
const dataRoot = resolve(
  directory,
  "home/Library/Application Support/bunaway/tests.macos.webview-controls",
);
let child: ReturnType<typeof Bun.spawn> | undefined;
let outsideRequests = 0;
let redirectRequests = 0;
let slowRequests = 0;
let cacheProbeDocuments = 0;
const pageLifecycle: {
  type: "pageshow" | "pagehide";
  path: string;
  persisted: boolean;
  trusted: boolean;
  historyLength: number;
}[] = [];
const slow = Promise.withResolvers<void>();
const outside = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch() {
    outsideRequests++;
    return new Response("Disallowed origin");
  },
});
const assets = resolve(directory, "assets");
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/lifecycle") {
      const type = url.searchParams.get("type");
      const persisted = url.searchParams.get("persisted");
      const trusted = url.searchParams.get("trusted");
      const historyLength = Number(url.searchParams.get("historyLength"));
      assert(type === "pageshow" || type === "pagehide");
      assert(persisted === "true" || persisted === "false");
      assert(trusted === "true" || trusted === "false");
      assert(Number.isInteger(historyLength) && historyLength > 0);
      pageLifecycle.push({
        type,
        path: url.searchParams.get("path") ?? "",
        persisted: persisted === "true",
        trusted: trusted === "true",
        historyLength,
      });
      return new Response(null, {
        status: 204,
      });
    }
    if (path === "/stats") {
      return Response.json({
        slow: slowRequests,
        redirects: redirectRequests,
        syntheticRestores: pageLifecycle.filter(
          (event) =>
            event.type === "pageshow" && event.persisted && !event.trusted,
        ).length,
        probeLoads: pageLifecycle.filter(
          (event) =>
            event.type === "pageshow" &&
            event.trusted &&
            !event.persisted &&
            event.path === "/cache-probe.html",
        ).length,
      });
    }
    if (path === "/redirect.html") {
      redirectRequests++;
      return Response.redirect(`${outside.url.origin}/outside.html`);
    }
    if (path === "/slow.html") {
      slowRequests++;
      await slow.promise;
    }
    if (path.endsWith(".js")) {
      return new Response(Bun.file(resolve(assets, `web${path}`)), {
        headers: {
          "Content-Type": "text/javascript",
        },
      });
    }
    const closedClientProbe =
      path === "/cache-probe.html" && ++cacheProbeDocuments === 1;
    return new Response(html(path, closedClientProbe), {
      headers: {
        "Content-Type": "text/html",
        ...(path === "/cache-probe.html"
          ? {
              "Cache-Control": "no-store",
            }
          : {}),
      },
    });
  },
});
function html(path: string, closedClientProbe = false): string {
  // Keep lifecycle evidence independent of the SDK, which pagehide closes before a cached restore.
  return `<!doctype html><title>${path}</title><meta name="closed-client-probe" content="${closedClientProbe}"><script>
    for (const type of ['pageshow', 'pagehide']) addEventListener(type, event => {
      if (window !== window.top) return;
      const target = new URL(${JSON.stringify(`${server.url.origin}/lifecycle`)});
      target.search = new URLSearchParams({type, path: location.pathname, persisted: String(event.persisted), trusted: String(event.isTrusted), historyLength: String(history.length)});
      navigator.sendBeacon(target.href);
    });
  </script><script type="module" src="/${path === "/frame.html" ? "frame" : "web"}.js"></script>${path === "/index.html" ? '<iframe src="/frame.html"></iframe>' : ""}`;
}
try {
  await mkdir(resolve(assets, "web"), {
    recursive: true,
  });
  const operations = [
    "getWebViewState",
    "navigateWebView",
    "reloadWebView",
    "stopWebView",
    "goBack",
    "goForward",
    "setZoomFactor",
  ];
  const specs = [
    "main",
  ].map((view) => ({
    view,
    home: "https://app.bunaway.local/index.html",
    title: view,
    window: {
      width: 600,
      height: 400,
    },
  }));
  await writeJson(resolve(assets, "manifest.json"), {
    format: 1,
    app: {
      appId: "tests.macos.webview-controls",
      title: "WebView controls",
      windows: specs,
    },
    policy: {
      version: 1,
      backend: {
        permissions: [
          ...operations,
          "openDevTools",
          "close",
        ].map((name) => `windows.${name}`),
      },
      views: specs.map(({ view }) => ({
        id: view,
        origins: [
          "https://app.bunaway.local",
          server.url.origin,
        ],
        events: [],
        commands: [
          "test.arrived",
          "test.hold",
          "test.fragment",
          "test.spoof",
          "test.failure",
          "plugin.windows.getWebViewState",
          "plugin.windows.reloadWebView",
        ],
        host: {
          permissions: [
            "windows.getWebViewState",
          ],
        },
      })),
    },
    plugins: [],
    developmentSdk: {},
  });
  const entry = resolve(directory, "app.ts");
  await Bun.write(
    entry,
    `import {controlsApp} from ${JSON.stringify(resolve(root, "tests/fixtures/macos-webview-controls/app.ts"))}; export default controlsApp(${JSON.stringify(server.url.origin)}, ${JSON.stringify(outside.url.origin)});`,
  );
  const installed = (await installedPlugins(root, "0.0.0")).filter(
    (plugin) => plugin.name === "windows",
  );
  const bundled = await bundleMacosHost(
    resolve(root, "native/macos/bun"),
    assets,
    entry,
    undefined,
    false,
    installed,
  );
  const web = await Bun.build({
    entrypoints: [
      "web.js",
      "frame.js",
    ].map((name) =>
      resolve(root, "tests/fixtures/macos-webview-controls", name),
    ),
    target: "browser",
    outdir: resolve(assets, "web"),
  });
  assert(web.success, web.logs.map(String).join("\n"));
  for (const output of web.outputs) {
    await Bun.write(output.path, await output.arrayBuffer());
  }
  for (const path of [
    "/index.html",
    "/frame.html",
    "/upper-scheme.html",
    "/upper-host.html",
  ]) {
    await Bun.write(resolve(assets, `web${path}`), html(path));
  }
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
        HOME: resolve(directory, "home"),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  child = launched;
  const { exitCode, stdout, stderr } = await captureMacosNativeChild(
    launched,
    diagnostics,
    "webview controls",
    120_000,
    dataRoot,
  );
  assert.equal(exitCode, 0, `${stdout}\n${stderr}`);
  const report = await Bun.file(resolve(dataRoot, "temp/report.json")).json();
  assert.equal(report.pass, true, JSON.stringify(report));
  assert(
    pageLifecycle.some(
      (event) =>
        event.type === "pageshow" &&
        event.trusted &&
        !event.persisted &&
        event.path === "/index.html",
    ),
  );
  const cachedRestores = pageLifecycle.filter(
    (event) => event.type === "pageshow" && event.persisted && event.trusted,
  );
  const syntheticRestores = pageLifecycle.filter(
    (event) => event.type === "pageshow" && event.persisted && !event.trusted,
  );
  assert.equal(syntheticRestores.length, 1);
  const probeLoads = pageLifecycle.filter(
    (event) =>
      event.type === "pageshow" &&
      event.trusted &&
      !event.persisted &&
      event.path === "/cache-probe.html",
  );
  assert.equal(
    probeLoads.length,
    2,
    "Both probe documents must complete a trusted pageshow",
  );
  assert.equal(
    probeLoads[0]?.historyLength,
    probeLoads[1]?.historyLength,
    "Persisted recovery added a history entry",
  );
  assert.equal(
    cacheProbeDocuments,
    2,
    "Persisted pageshow did not reload the closed SDK document",
  );
  assert.equal(outsideRequests, 0, "Denied redirect contacted its destination");
  const records = (await Bun.file(resolve(dataRoot, "logs/host.log")).text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert(records.some((record) => record.event === "frame-message-ignored"));
  assert.equal(
    records.filter((record) => record.event === "host-stopped").length,
    1,
  );
  assert.equal(records.at(-1).failed, false);
  await writeJson(result, {
    platform: process.platform,
    arch: process.arch,
    bun: Bun.version,
    revision: Bun.revision,
    report,
    outsideRequests,
    redirectRequests,
    slowRequests,
    pageLifecycle,
    cachedRestores,
    syntheticRestores,
    cacheProbeDocuments,
  });
  console.log(
    "PASS real compiled WKWebView controls: public SDK, state, allowed navigation, origin/redirect/main-frame denial, history, reload, stop, fragment/session revocation, zoom and isolated close/recreate",
    report,
    {
      cachedRestores,
      syntheticRestores,
      cacheProbeDocuments,
    },
  );
} catch (error) {
  console.error({
    pageLifecycle,
    cacheProbeDocuments,
  });
  await printNativeChildDiagnostics(diagnostics, dataRoot);
  await mkdir(diagnostics, {
    recursive: true,
  });
  const progress = Bun.file(resolve(dataRoot, "temp/controls-progress.json"));
  if (await progress.exists()) {
    const contents = await progress.text();
    await Bun.write(resolve(diagnostics, "controls-progress.json"), contents);
    console.error(`Backend controls progress: ${contents}`);
  }
  if (await Bun.file(resolve(dataRoot, "logs/host.log")).exists()) {
    await cp(resolve(dataRoot, "logs"), diagnostics, {
      recursive: true,
    });
  }
  await writeJson(result, {
    pass: false,
    error: String(error),
    outsideRequests,
    redirectRequests,
    slowRequests,
    pageLifecycle,
    cacheProbeDocuments,
  });
  throw error;
} finally {
  if (child?.exitCode === null) {
    child.kill("SIGKILL");
  }
  await child?.exited;
  slow.resolve();
  await server.stop(true);
  await outside.stop(true);
  await rm(directory, {
    recursive: true,
    force: true,
  });
}
