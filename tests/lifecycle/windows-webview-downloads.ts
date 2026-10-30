import { dlopen } from "bun:ffi";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { Socket } from "node:net";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineApp } from "@bunaway/backend";
import windows from "@bunaway/plugin-windows";
import type { HostContext, Policy } from "@bunaway/protocol";
import { runWindowsApp } from "#native/windows/bun/entry";
import { kernel } from "#native/windows/bun/win32-bindings";
import { testAppMetadata } from "../fixtures/app-info.ts";
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
  /** Streams the fixture body in 64 KiB steps, honoring Range, and stops when the client disconnects. */
  const serveDownload = async (
    url: URL,
    request: IncomingMessage,
    response: ServerResponse,
  ) => {
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
  };
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
        await serveDownload(url, request, response);
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
  const item = async (id: string) => {
    const found = (await windows.getDownloads()).find(
      (download) => download.id === id,
    );
    assert(found, "Missing retained download");
    return found;
  };
  const freshView = async () => {
    const previous = main.windowId;
    await windows.recreate();
    await waitFor(async () => {
      const { windowId } = await windows.getReadiness();
      if (windowId === previous) {
        return false;
      }
      main.windowId = windowId;
      return true;
    }, "Replacement window did not open");
    await waitFor(
      () => arrivals.has(main.windowId),
      "Replacement document did not reconnect",
    );
    await windows.setDownloadRequestsEnabled({
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
        (await windows.getDownloads()).some(
          (download) =>
            download.state === "pending" &&
            download.url.endsWith(`/${name}.bin`),
        ),
      `Missing download request ${name}`,
    );
    const found = (await windows.getDownloads()).find(
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
  /** Every `windows.waitForDownloadChange` result in publication order. */
  const changes: Awaited<ReturnType<typeof windows.waitForDownloadChange>>[] =
    [];
  const changesFor = (id: string) =>
    changes.filter((change) => change.download.id === id);
  async function collectChanges() {
    let after = 0;
    // The loop ends when the window closes at the end of the run and the wait is cancelled.
    for (;;) {
      const change = await windows.waitForDownloadChange({
        after,
      });
      assert(change.sequence > after, "Download changes repeated a sequence");
      after = change.sequence;
      changes.push(change);
    }
  }
  async function exercise() {
    void collectChanges().catch((error: unknown) => {
      if (!completed) {
        failure = error;
      }
    });
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
    assert.deepEqual(await windows.getDownloads(), []);
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
      id: denied.id,
    });
    assert.equal((await item(denied.id)).state, "cancelled");
    assert.equal(await Bun.file(denied.path).exists(), false);
    await waitFor(
      () => changesFor(denied.id).some((c) => c.download.state === "cancelled"),
      "Rejected request did not report cancellation",
    );
    // The rejected request ends cancelled and never reports a transfer state.
    const rejected = changesFor(denied.id).map((c) => c.download.state);
    assert.equal(rejected.at(-1), "cancelled");
    assert(
      rejected.every((state) => state === "pending" || state === "cancelled"),
      "A rejected request reported a transfer state",
    );
    await assert.rejects(
      windows.approveDownload({
        id: denied.id,
      }),
      {
        code: "INVALID_ARGUMENT",
      },
    );
    await windows.forgetDownload({
      id: denied.id,
    });

    await freshView();
    const accepted = await request("approved");
    assert.equal(accepted.mimeType, "application/octet-stream");
    await windows.approveDownload({
      id: accepted.id,
    });
    await waitFor(async () => {
      const state = await item(accepted.id);
      return state.state === "inProgress" && (state.receivedBytes ?? 0) > 0;
    }, "Approved download did not report progress");
    // The deferred DownloadStarting snapshot can precede the runtime's final size metadata.
    assert.equal((await item(accepted.id)).totalBytes, content.length);
    await windows.pauseDownload({
      id: accepted.id,
    });
    await waitFor(
      async () => (await item(accepted.id)).canResume,
      "Paused download was not resumable",
    );
    assert.equal((await item(accepted.id)).paused, true);
    // The paused state persists until resume, so its report cannot be merged away.
    await waitFor(
      () => changesFor(accepted.id).some((c) => c.download.paused),
      "Pause was not reported",
    );
    await windows.resumeDownload({
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
    // The same transitions arrive as events, ending in one completed report with the full count.
    await waitFor(
      () =>
        changesFor(accepted.id).some((c) => c.download.state === "completed"),
      "Completion was not reported",
    );
    const reported = changesFor(accepted.id);
    // A request and its approval can merge into one report, so the first is never a later state.
    assert(
      [
        "pending",
        "inProgress",
      ].includes(reported[0]?.download.state ?? ""),
      "The first report was not the request or its approval",
    );
    assert.equal(reported.at(-1)?.download.state, "completed");
    assert.equal(reported.at(-1)?.download.receivedBytes, content.length);
    assert.equal(
      reported.filter((c) => c.download.state === "completed").length,
      1,
    );
    await windows.forgetDownload({
      id: accepted.id,
    });
    const reportedCount = reported.length;

    await freshView();
    assert.equal(
      changesFor(accepted.id).length,
      reportedCount,
      "A forgotten download reported again",
    );
    const interrupted = await request("cancelled");
    await windows.approveDownload({
      id: interrupted.id,
    });
    await waitFor(
      async () => (await item(interrupted.id)).state === "inProgress",
      "Cancellation item did not start",
    );
    await windows.cancelDownload({
      id: interrupted.id,
    });
    await windows.cancelDownload({
      id: interrupted.id,
    });
    assert.equal((await item(interrupted.id)).state, "cancelled");
    await windows.forgetDownload({
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
        id: expired.id,
      }),
      {
        code: "INVALID_ARGUMENT",
      },
    );
    await windows.forgetDownload({
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
      windowId: main.windowId,
    };
    const faulted = await request("cleanup-failure");
    await windows.approveDownload({
      id: faulted.id,
    });
    await waitFor(async () => {
      const state = await item(faulted.id);
      return state.state === "inProgress" && (state.receivedBytes ?? 0) > 0;
    }, "Cleanup fault transfer did not start");
    const readCleanupDiagnostics = async (): Promise<
      Record<string, unknown>[]
    > =>
      (await readFile(resolve(dataRoot, "logs/host.log"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    // Closing the only window would end the app, so the owner is replaced instead.
    await windows.recreate();
    await waitFor(
      async () =>
        (await readCleanupDiagnostics()).some(
          (entry) =>
            entry.event === "download-cleanup-retry" &&
            entry.windowId === cleanupOwner.windowId,
        ),
      "Closing owner did not retain and retry its failed cancellation",
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
    assert.equal(
      (await readCleanupDiagnostics()).some(
        (entry) => entry.event === "ui-failed",
      ),
      false,
    );
    await freshView();
    const crashing = await request("crashing");
    await windows.approveDownload({
      id: crashing.id,
    });
    await waitFor(async () => {
      const state = await item(crashing.id);
      return state.state === "inProgress" && (state.receivedBytes ?? 0) > 0;
    }, "Crash item did not start");
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
      windows,
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
            await windows.close().catch(() => {});
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
          const identity = await windows.getReadiness();
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
          const identity = await windows.getReadiness();
          assert(identity.viewId === "main");
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
      appMetadata: testAppMetadata,
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
