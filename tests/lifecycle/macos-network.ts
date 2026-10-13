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
const directory = await mkdtemp(resolve(tmpdir(), "bunaway-macos-network-"));
const dataRoot = resolve(
  directory,
  "Library/Application Support/bunaway/tests.macos.network",
);
const reportFile = Bun.file(resolve(dataRoot, "temp/report.json"));
let child: ReturnType<typeof Bun.spawn> | undefined;
const waits: Record<string, number> = {};
const sockets: Record<string, number> = {};
const cancelledReads = new Set<string>();
const closedSockets = new Set<string>();
let redirectedRequests = 0;
let deniedRequests = 0;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request, server) {
    const path = new URL(request.url).pathname;
    if (path === "/stats") {
      return Response.json({
        waits,
        sockets,
        cancelledReads: [
          ...cancelledReads,
        ],
        closedSockets: [
          ...closedSockets,
        ],
      });
    }
    if (path === "/denied") {
      deniedRequests++;
    }
    if (path === "/redirect") {
      return new Response(null, {
        status: 302,
        headers: {
          location: `http://127.0.0.1:${server.port}/target`,
        },
      });
    }
    if (path === "/target") {
      redirectedRequests++;
    }
    if (path === "/echo") {
      return new Response(request.body, {
        status: 201,
      });
    }
    if (path === "/large") {
      return new Response("a".repeat(65537));
    }
    if (path === "/compressed-large") {
      return new Response(Bun.gzipSync("a".repeat(65537)), {
        headers: {
          "content-encoding": "gzip",
        },
      });
    }
    if (path.startsWith("/wait-")) {
      waits[path] = (waits[path] ?? 0) + 1;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new Uint8Array([
                1,
              ]),
            );
          },
          cancel() {
            cancelledReads.add(path);
          },
        }),
      );
    }
    if (path.startsWith("/socket") || path === "/binary") {
      if (
        server.upgrade(request, {
          data: {
            path,
          },
        })
      ) {
        return;
      }
    }
    if (path === "/bad-handshake") {
      return new Response("Not a WebSocket", {
        status: 200,
      });
    }
    return new Response("한글 😀");
  },
  websocket: {
    data: {} as {
      path: string;
    },
    open(socket) {
      const path = socket.data.path;
      sockets[path] = (sockets[path] ?? 0) + 1;
      if (path === "/binary") {
        socket.sendBinary(
          new Uint8Array([
            0,
            255,
            1,
          ]),
        );
      }
      if (path === "/socket-large") {
        socket.send("a".repeat(65537));
      }
    },
    close(socket) {
      closedSockets.add(socket.data.path);
    },
    message(socket, message) {
      socket.send(message);
    },
  },
});

/** Wait for observable transport progress while surfacing early host exit. */
async function waitFor(
  condition: () => boolean | Promise<boolean>,
  message: string,
) {
  const deadline = Date.now() + 20_000;
  while (!(await condition())) {
    assert(child?.exitCode === null, `Host exited before ${message}`);
    assert(Date.now() < deadline, `Timed out: ${message}`);
    await Bun.sleep(10);
  }
}

try {
  const assets = resolve(directory, "assets");
  await mkdir(resolve(assets, "web"), {
    recursive: true,
  });
  const http = `http://127.0.0.1:${server.port}`;
  const ws = `ws://127.0.0.1:${server.port}`;
  const appEntry = resolve(directory, "app.ts");
  await Bun.write(
    appEntry,
    `import {defineNetworkFixture} from ${JSON.stringify(resolve(import.meta.dir, "fixtures/macos-network-app.ts"))};
export default defineNetworkFixture(${JSON.stringify(http)}, ${JSON.stringify(ws)});`,
  );
  const views = [
    "main",
    "request-only",
    "denied",
  ];
  const commands = [
    "test.config",
    "test.ready",
    "test.peers",
    "test.stats",
    "test.echo",
    "test.report",
    "test.inheritedHttp",
    "test.inheritedWs",
    "plugin.network.request",
    "plugin.network.exchange",
  ];
  await writeJson(resolve(assets, "manifest.json"), {
    format: 1,
    app: {
      appId: "tests.macos.network",
      title: "macOS network",
      windows: views.map((view) => ({
        view,
        home: `https://app.bunaway.local/${view}.html`,
        title: `Network ${view}`,
        window: {
          width: 400,
          height: 300,
        },
      })),
    },
    policy: {
      version: 1,
      backend: {
        permissions: [
          "network.request",
        ],
      },
      views: views.map((id) => ({
        id,
        origins: [
          "https://app.bunaway.local",
        ],
        commands,
        events: [],
        host: {
          permissions:
            id === "main"
              ? [
                  "network.request",
                  "network.exchange",
                ]
              : id === "request-only"
                ? [
                    "network.request",
                  ]
                : [],
        },
      })),
    },
    plugins: [],
    developmentSdk: {},
  });
  const web = await Bun.build({
    entrypoints: [
      resolve(import.meta.dir, "fixtures/macos-network-web.js"),
    ],
    target: "browser",
    outdir: resolve(assets, "web"),
  });
  assert(web.success, web.logs.map(String).join("\n"));
  for (const output of web.outputs) {
    await Bun.write(output.path, await output.arrayBuffer());
  }
  for (const view of views) {
    await Bun.write(
      resolve(assets, "web", `${view}.html`),
      '<!doctype html><title>Network</title><script type="module" src="macos-network-web.js"></script>',
    );
  }
  // Bundle only the installed network plugin. No unrelated native adapters enter this fixture.
  const installed = (await installedPlugins(root, "0.0.0")).filter(
    (plugin) => plugin.name === "network",
  );
  assert.equal(installed.length, 1);
  assert.equal(installed[0]?.targets.macos?.execution, "ui");
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
  await waitFor(() => reportFile.exists(), "WKWebView report");
  assert.deepEqual(await reportFile.json(), {
    ok: true,
  });
  assert.equal(
    redirectedRequests,
    0,
    "HTTP and WebSocket redirects must never be followed",
  );
  assert.equal(deniedRequests, 0, "denied view must not reach the server");
  assert.equal(waits["/wait-shutdown"], 1);
  assert.equal(sockets["/socket-shutdown"], 1);
  await waitFor(
    () =>
      cancelledReads.has("/wait-cancel") && cancelledReads.has("/wait-timeout"),
    "HTTP abort cleanup",
  );
  child.kill("SIGTERM");
  assert.equal(await child.exited, 0, await errors);
  await output;
  // Wait after process exit without relying on a pending host: TCP close arrives asynchronously.
  const cleanupDeadline = Date.now() + 2000;
  while (
    server.pendingWebSockets !== 0 ||
    !cancelledReads.has("/wait-shutdown")
  ) {
    assert(
      Date.now() < cleanupDeadline,
      "Shutdown left network transports open",
    );
    await Bun.sleep(10);
  }
  const records = (await Bun.file(resolve(dataRoot, "logs/host.log")).text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(
    records.filter((record) => record.event === "session-open").length,
    3,
  );
  assert.equal(
    records.filter((record) => record.event === "host-stopped").length,
    1,
  );
  assert.equal(records.at(-1).failed, false);
  assert.equal(records.at(-1).forced, false);
  assert.equal(records.at(-1).activeProcesses, 0);
  await mkdir(resolve(root, "build/macos-native-logs"), {
    recursive: true,
  });
  await writeJson(
    resolve(root, "build/macos-native-logs/network-results.json"),
    {
      ok: true,
      platform: process.platform,
      architecture: process.arch,
      bunVersion: Bun.version,
      bun: pin.bun,
      redirectedRequests,
      deniedRequests,
      cancelledReads: [
        ...cancelledReads,
      ].sort(),
      pendingWebSockets: server.pendingWebSockets,
      shutdown: records.at(-1),
    },
  );
  console.log(
    "PASS compiled macOS WKWebView network SDK, Core, host grants, binary/text, bounds, redirects, handshakes, cancellation, deadlines and in-flight shutdown",
  );
} catch (error) {
  console.error(
    await Bun.file(resolve(dataRoot, "logs/host.log"))
      .text()
      .catch(() => "No host log."),
  );
  throw error;
} finally {
  if (child?.exitCode === null) {
    child.kill("SIGKILL");
  }
  await child?.exited;
  server.stop(true);
  await rm(directory, {
    recursive: true,
    force: true,
  });
}
