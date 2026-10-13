import { dlopen } from "bun:ffi";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineApp } from "@bunaway/backend";
import { windows, windowsPlugin } from "@bunaway/plugin-windows";
import type { HostContext, Policy } from "@bunaway/protocol";
import { runWindowsApp } from "#native/windows/bun/entry";
import { kernel } from "#native/windows/bun/win32-bindings";
import { bundleNativeWorker } from "../fixtures/native-worker.ts";
import { windowPermissions } from "../fixtures/window-permissions.ts";

assert.equal(process.platform, "win32");
const root =
  process.env.BUNAWAY_DOWNLOAD_TEST_ROOT ?? resolve(import.meta.dir, "../..");
const output = resolve(root, "build/windows-webview-downloads");
const assets = resolve(output, "assets");
const reportPath = resolve(
  root,
  "build/windows-webview-downloads-results.json",
);

if (!process.argv.includes("--child")) {
  await mkdir(resolve(assets, "web"), {
    recursive: true,
  });
  const web = await Bun.build({
    entrypoints: [
      resolve(root, "tests/lifecycle/windows-bun/webview-downloads.js"),
    ],
    target: "browser",
  });
  assert(web.success, web.logs.map(String).join("\n"));
  assert(web.outputs[0]);
  await writeFile(resolve(assets, "downloads.js"), await web.outputs[0].text());
  const entry = await bundleNativeWorker(
    "windows-webview-downloads",
    assets,
    fileURLToPath(import.meta.url),
    resolve(root, "tests/fixtures/windows-download-cleanup/ui.ts"),
  );
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      fileURLToPath(entry),
      "--child",
    ],
    {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        BUNAWAY_DOWNLOAD_TEST_ROOT: root,
      },
    },
  );
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  const timer = setTimeout(() => child.kill(), 120_000);
  try {
    assert.equal(await child.exited, 0, `${await stderr}\n${await stdout}`);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    assert.equal(report.pass, true);
    console.log(
      "PASS actual WebView2 downloads: default denial, backend-only authority, per-item approval/rejection, saved bytes, progress, pause/resume/cancel, expiry, navigation revocation and close cleanup",
      report,
    );
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) {
      child.kill();
    }
    await child.exited;
  }
} else {
  const nonce = crypto.randomUUID();
  const dataRoot = resolve(output, `data-${nonce}`);
  const script = await readFile(resolve(assets, "downloads.js"), "utf8");
  const content = Buffer.alloc(1024 * 1024, 0x5a);
  const paths = new Set<string>();
  let releaseCrashBody: () => void = () => {};
  const crashBody = new Promise<void>((done) => {
    releaseCrashBody = done;
  });
  const actions = new Map<
    string,
    {
      kind: "download" | "navigate" | "ping";
      url: string;
    }
  >();
  const arrivals = new Map<string, number>();
  const heartbeats = new Set<string>();
  let completed = false;
  let failure: unknown;
  let exerciseTask: Promise<void> | undefined;
  const responses = new Set<Promise<void>>();
  const sockets = new Set<Socket>();
  // Bun's streaming Response replaces Content-Length with chunked encoding. Use HTTP's
  // actual fixed-length framing so native total-byte and Range assertions test known metadata.
  const server = createServer((request, response) => {
    const respond = async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/driver") {
        const id = url.searchParams.get("windowId") ?? "";
        const next = actions.get(id) ?? null;
        actions.delete(id);
        response.writeHead(200, {
          "Content-Type": "application/json",
        });
        response.end(JSON.stringify(next));
        return;
      }
      if (url.pathname === "/downloads.js") {
        response.writeHead(200, {
          "Content-Type": "text/javascript",
        });
        response.end(script);
        return;
      }
      if (url.pathname.endsWith(".bin")) {
        const offset = Number(
          request.headers.range?.match(/^bytes=(\d+)-$/)?.[1] ?? 0,
        );
        let position = offset;
        let cancelled = false;
        response.on("close", () => {
          cancelled = true;
        });
        response.writeHead(offset ? 206 : 200, {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename="bunaway-download-${nonce}-${url.pathname.slice(1)}"`,
          "Content-Length": String(content.length - offset),
          "Accept-Ranges": "bytes",
          ...(offset
            ? {
                "Content-Range": `bytes ${offset}-${content.length - 1}/${content.length}`,
              }
            : {}),
        });
        while (position < content.length && !cancelled) {
          await Bun.sleep(50);
          if (
            [
              "/crashing.bin",
              "/cleanup-failure.bin",
            ].includes(url.pathname) &&
            position > 0
          ) {
            await crashBody;
          }
          if (cancelled) {
            return;
          }
          const end = Math.min(position + 64 * 1024, content.length);
          response.write(content.subarray(position, end));
          position = end;
        }
        response.end();
        return;
      }
      response.writeHead(200, {
        "Content-Type": "text/html",
      });
      response.end(
        '<!doctype html><body><script type="module" src="/downloads.js"></script>',
      );
    };
    const task = respond()
      .catch((error) => {
        failure ??= error;
        response.destroy();
      })
      .finally(() => responses.delete(task));
    responses.add(task);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      done();
    });
  });
  const address = server.address();
  assert(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const main = {
    view: "main",
    windowId: "",
  };
  const waitFor = async (
    check: () => boolean | Promise<boolean>,
    message: string,
    timeoutMs = 15_000,
  ) => {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
      assert(Date.now() < deadline, message);
      await Bun.sleep(10);
    }
  };
  const item = async (id: string, target = main) => {
    const found = (await windows.getDownloads(target)).find(
      (download) => download.id === id,
    );
    assert(found, "Missing retained download");
    return found;
  };
  const freshView = async () => {
    const replacement = await windows.recreateInstance(main);
    main.windowId = replacement.windowId;
    await waitFor(
      () => arrivals.has(main.windowId),
      "Replacement document did not reconnect",
    );
    await windows.setDownloadRequestsEnabled({
      ...main,
      enabled: true,
    });
  };
  const request = async (name: string, target = main) => {
    actions.set(target.windowId, {
      kind: "download",
      url: `${origin}/${name}.bin`,
    });
    await waitFor(
      async () =>
        (await windows.getDownloads(target)).some(
          (download) =>
            download.state === "pending" &&
            download.url.endsWith(`/${name}.bin`),
        ),
      `Missing download request ${name}`,
    );
    const found = (await windows.getDownloads(target)).find(
      (download) =>
        download.state === "pending" && download.url.endsWith(`/${name}.bin`),
    );
    assert(found);
    assert(
      basename(found.path).startsWith(`bunaway-download-${nonce}-`),
      "Unexpected browser destination",
    );
    paths.add(found.path);
    return found;
  };
  async function exercise() {
    await waitFor(
      () => arrivals.size >= 1,
      "Renderer did not verify backend-only authority",
    );
    const initialId = arrivals.keys().next().value;
    assert(initialId);
    main.windowId = initialId;
    actions.set(main.windowId, {
      kind: "download",
      url: `${origin}/disabled.bin`,
    });
    await waitFor(async () => {
      const log = await readFile(resolve(dataRoot, "logs/host.log"), "utf8");
      return (
        log.includes('"event":"download-rejected"') &&
        log.includes("/disabled.bin")
      );
    }, "Default-denied download was not observed");
    assert.deepEqual(await windows.getDownloads(main), []);
    // The unchanged multiple-automatic-downloads permission stays denied.
    // A new WebView supplies one fresh browser request for each control scenario.
    await freshView();
    const denied = await request("denied");
    assert.equal(
      await Bun.file(denied.path).exists(),
      false,
      "Pending download created its destination before approval",
    );
    await windows.cancelDownload({
      ...main,
      id: denied.id,
    });
    assert.equal((await item(denied.id)).state, "cancelled");
    assert.equal(await Bun.file(denied.path).exists(), false);
    await assert.rejects(
      windows.approveDownload({
        ...main,
        id: denied.id,
      }),
      {
        code: "INVALID_ARGUMENT",
      },
    );
    await windows.forgetDownload({
      ...main,
      id: denied.id,
    });

    await freshView();
    const accepted = await request("approved");
    assert.equal(accepted.mimeType, "application/octet-stream");
    await windows.approveDownload({
      ...main,
      id: accepted.id,
    });
    await waitFor(async () => {
      const state = await item(accepted.id);
      return state.state === "inProgress" && (state.receivedBytes ?? 0) > 0;
    }, "Approved download did not report progress");
    // The deferred DownloadStarting snapshot can precede the runtime's final size metadata.
    assert.equal((await item(accepted.id)).totalBytes, content.length);
    await windows.pauseDownload({
      ...main,
      id: accepted.id,
    });
    await waitFor(
      async () => (await item(accepted.id)).canResume,
      "Paused download was not resumable",
    );
    assert.equal((await item(accepted.id)).paused, true);
    await windows.resumeDownload({
      ...main,
      id: accepted.id,
    });
    await waitFor(
      async () => (await item(accepted.id)).state === "completed",
      "Resumed download did not complete",
    );
    const saved = await item(accepted.id);
    assert(
      basename(saved.path).startsWith(`bunaway-download-${nonce}-`),
      "Browser changed the destination to an unowned filename",
    );
    paths.add(saved.path);
    assert.equal(saved.receivedBytes, content.length);
    assert.deepEqual(await readFile(saved.path), content);
    await windows.forgetDownload({
      ...main,
      id: accepted.id,
    });

    await freshView();
    const interrupted = await request("cancelled");
    await windows.approveDownload({
      ...main,
      id: interrupted.id,
    });
    await waitFor(
      async () => (await item(interrupted.id)).state === "inProgress",
      "Cancellation item did not start",
    );
    await windows.cancelDownload({
      ...main,
      id: interrupted.id,
    });
    await windows.cancelDownload({
      ...main,
      id: interrupted.id,
    });
    assert.equal((await item(interrupted.id)).state, "cancelled");
    await windows.forgetDownload({
      ...main,
      id: interrupted.id,
    });

    await freshView();
    const expired = await request("expired");
    await waitFor(
      async () => (await item(expired.id)).state === "cancelled",
      "Pending approval did not expire",
      35_000,
    );
    assert.equal(await Bun.file(expired.path).exists(), false);
    await assert.rejects(
      windows.approveDownload({
        ...main,
        id: expired.id,
      }),
      {
        code: "INVALID_ARGUMENT",
      },
    );
    await windows.forgetDownload({
      ...main,
      id: expired.id,
    });

    await freshView();
    const navigated = await request("navigated");
    const beforeNavigation = arrivals.get(main.windowId) ?? 0;
    actions.set(main.windowId, {
      kind: "navigate",
      url: `${origin}/next.html`,
    });
    await waitFor(
      async () => (await item(navigated.id)).state === "cancelled",
      "Navigation retained an undecided download",
    );
    assert.equal(await Bun.file(navigated.path).exists(), false);
    await waitFor(
      () => (arrivals.get(main.windowId) ?? 0) > beforeNavigation,
      "New document did not reconnect",
    );
    await freshView();
    const cleanupOwner = {
      ...main,
    };
    const faulted = await request("cleanup-failure");
    await windows.approveDownload({
      ...cleanupOwner,
      id: faulted.id,
    });
    await waitFor(async () => {
      const state = await item(faulted.id, cleanupOwner);
      return state.state === "inProgress" && (state.receivedBytes ?? 0) > 0;
    }, "Cleanup fault transfer did not start");
    const healthy = await windows.createInstance({
      view: "main",
    });
    const closingPeer = await windows.createInstance({
      view: "main",
    });
    await waitFor(
      () =>
        arrivals.has(healthy.windowId) && arrivals.has(closingPeer.windowId),
      "Peer documents did not connect",
    );
    const readCleanupDiagnostics = async (): Promise<
      Record<string, unknown>[]
    > =>
      (await readFile(resolve(dataRoot, "logs/host.log"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    await windows.close({
      ...cleanupOwner,
    });
    await waitFor(
      async () =>
        (await readCleanupDiagnostics()).some(
          (entry) =>
            entry.event === "download-cleanup-retry" &&
            entry.windowId === cleanupOwner.windowId,
        ),
      "Closing owner did not retain and retry its failed cancellation",
    );
    await windows.close({
      view: "main",
      windowId: closingPeer.windowId,
    });
    actions.set(healthy.windowId, {
      kind: "ping",
      url: "",
    });
    await waitFor(
      () => heartbeats.has(healthy.windowId),
      "Healthy peer lost its live SDK session after another owner's cleanup failure",
    );
    await waitFor(
      async () =>
        (await readCleanupDiagnostics()).some(
          (entry) =>
            entry.event === "view-cleaned" &&
            entry.windowId === closingPeer.windowId,
        ),
      "Peer cleanup was blocked by the closing owner's retry",
    );
    await waitFor(
      async () =>
        (await readCleanupDiagnostics()).some(
          (entry) =>
            entry.event === "download-cleanup-recovered" &&
            entry.windowId === cleanupOwner.windowId,
        ),
      "Transient cancellation did not recover",
    );
    const cleanupRecords = await readCleanupDiagnostics();
    const peerCleaned = cleanupRecords.findIndex(
      (entry) =>
        entry.event === "view-cleaned" &&
        entry.windowId === closingPeer.windowId,
    );
    const ownerRecovered = cleanupRecords.findIndex(
      (entry) =>
        entry.event === "download-cleanup-recovered" &&
        entry.windowId === cleanupOwner.windowId,
    );
    assert(
      peerCleaned >= 0 && ownerRecovered > peerCleaned,
      "Peer cleanup did not progress while owner cancellation was still failing",
    );
    assert.equal(
      cleanupRecords.some((entry) => entry.event === "ui-failed"),
      false,
    );
    main.windowId = healthy.windowId;
    await freshView();
    const crashing = await request("crashing");
    await windows.approveDownload({
      ...main,
      id: crashing.id,
    });
    await waitFor(async () => {
      const state = await item(crashing.id);
      return state.state === "inProgress" && (state.receivedBytes ?? 0) > 0;
    }, "Crash item did not start");
    const pendingWindow = await windows.createInstance({
      view: "main",
    });
    const pendingTarget = {
      view: "main",
      windowId: pendingWindow.windowId,
    };
    await waitFor(
      () => arrivals.has(pendingTarget.windowId),
      "Second shared-profile document did not connect",
    );
    await windows.setDownloadRequestsEnabled({
      ...pendingTarget,
      enabled: true,
    });
    const closing = await request("closing", pendingTarget);
    assert.equal(await Bun.file(closing.path).exists(), false);
    assert.equal((await item(crashing.id)).state, "inProgress");
    const diagnostics: unknown[] = (
      await readFile(resolve(dataRoot, "logs/host.log"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const browser = diagnostics.reverse().find(
      (
        entry,
      ): entry is {
        browserPid: number;
      } =>
        typeof entry === "object" &&
        entry !== null &&
        "event" in entry &&
        entry.event === "webview-ready" &&
        "browserPid" in entry &&
        typeof entry.browserPid === "number" &&
        Number.isInteger(entry.browserPid) &&
        entry.browserPid > 0 &&
        entry.browserPid <= 0xffffffff,
    );
    assert(browser, "Owned browser process identity was not recorded");
    const driver = dlopen("kernel32.dll", {
      TerminateProcess: {
        args: [
          "u64",
          "u32",
        ],
        returns: "i32",
      },
    });
    try {
      const processHandle = kernel.symbols.OpenProcess(
        1,
        0,
        browser.browserPid,
      );
      assert(processHandle, "Owned browser process was unavailable");
      completed = true;
      try {
        assert(driver.symbols.TerminateProcess(processHandle, 77));
      } finally {
        assert(kernel.symbols.CloseHandle(processHandle));
      }
    } finally {
      driver.close();
    }
  }
  const grants = windowPermissions();
  const policy: Policy = {
    version: 1,
    backend: {
      permissions: grants,
    },
    views: [
      {
        id: "main",
        origins: [
          origin,
        ],
        events: [],
        commands: [
          "test.arrived",
          "test.heartbeat",
          "plugin.windows.setDownloadRequestsEnabled",
          "plugin.windows.getDownloads",
        ],
        host: {
          permissions: grants,
        },
      },
    ],
  };
  const app = defineApp({
    modules: [],
    events: {},
    plugins: [
      windowsPlugin,
      {
        name: "download-test",
        version: "1.0.0",
        setup() {
          exerciseTask = exercise().catch(async (error) => {
            if (completed && error?.code === "CANCELLED") {
              return;
            }
            failure = error;
            console.error(error);
            for (const identity of await windows.listInstances()) {
              await windows
                .close({
                  view: identity.viewId,
                  windowId: identity.windowId,
                })
                .catch(() => {});
            }
          });
        },
      },
    ],
    commands: {
      "test.heartbeat": {
        input: {
          const: null,
        },
        output: {
          const: null,
        },
        async run() {
          const identity = await windows.getCurrent();
          assert(identity);
          heartbeats.add(identity.windowId);
          return null;
        },
      },
      "test.arrived": {
        input: {
          const: null,
        },
        output: {
          type: "object",
          properties: {
            windowId: {
              type: "string",
            },
          },
          required: [
            "windowId",
          ],
          additionalProperties: false,
        },
        async run() {
          const identity = await windows.getCurrent();
          assert(identity && identity.viewId === "main");
          arrivals.set(
            identity.windowId,
            (arrivals.get(identity.windowId) ?? 0) + 1,
          );
          return {
            windowId: identity.windowId,
          };
        },
      },
    },
  });
  try {
    await runWindowsApp(app, {
      runtime: {
        id: "webview-downloads",
        generation: crypto.randomUUID(),
      },
      backendContext: `backend-${nonce}` as HostContext,
      assets,
      dataRoot,
      policy,
      loader: resolve(
        root,
        "build/cache/webview2/sdk/build/native/x64/WebView2Loader.dll",
      ),
      windows: [
        {
          view: "main",
          instances: "multiple",
          maxInstances: 3,
          title: "Downloads",
          home: `${origin}/index.html`,
          visible: false,
          window: {
            width: 640,
            height: 480,
          },
        },
      ],
    });
    await exerciseTask;
    if (failure) {
      throw failure;
    }
    assert(completed);
    await writeFile(
      reportPath,
      JSON.stringify(
        {
          pass: true,
          bytes: content.length,
          arrivals: Object.fromEntries(arrivals),
          approvalExpiry: true,
          nativeCleanup: true,
          browserCrashCleanup: true,
          cancelFailureContained: true,
          peerCleanupContinued: true,
        },
        null,
        2,
      ),
    );
  } finally {
    releaseCrashBody();
    // Bun's closeAllConnections also stops the listener. Close once and drain owned sockets.
    const stopped = new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done())),
    );
    for (const socket of sockets) {
      socket.destroy();
    }
    await stopped;
    await Promise.all(responses);
    // Only delete unique files whose browser-selected path was recorded by this test's own item.
    for (const path of paths) {
      await rm(path, {
        force: true,
      });
    }
  }
}
