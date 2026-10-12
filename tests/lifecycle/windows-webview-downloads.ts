import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineApp } from "@bunaway/backend";
import { windows, windowsPlugin } from "@bunaway/plugin-windows";
import type { HostContext, Policy } from "@bunaway/protocol";
import { runWindowsApp } from "#native/windows/bun/entry";
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
  let action: {
    kind: "download" | "navigate";
    url: string;
  } | null = null;
  let arrivals = 0;
  let completed = false;
  let failure: unknown;
  let exerciseTask: Promise<void> | undefined;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/driver") {
        const next = action;
        action = null;
        return Response.json(next);
      }
      if (url.pathname === "/downloads.js") {
        return new Response(script, {
          headers: {
            "Content-Type": "text/javascript",
          },
        });
      }
      if (url.pathname.endsWith(".bin")) {
        const offset = Number(
          request.headers.get("Range")?.match(/^bytes=(\d+)-$/)?.[1] ?? 0,
        );
        let position = offset;
        let cancelled = false;
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            await Bun.sleep(50);
            if (cancelled) {
              return;
            }
            const end = Math.min(position + 64 * 1024, content.length);
            controller.enqueue(content.subarray(position, end));
            position = end;
            if (position >= content.length) {
              controller.close();
            }
          },
          cancel() {
            cancelled = true;
          },
        });
        return new Response(body, {
          status: offset ? 206 : 200,
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Disposition": `attachment; filename="bunaway-download-${nonce}-${url.pathname.slice(1)}"`,
            "Content-Length": String(content.length - offset),
            "Accept-Ranges": "bytes",
            ...(offset
              ? {
                  "Content-Range": `bytes ${offset}-${content.length - 1}/${content.length}`,
                }
              : {}),
          },
        });
      }
      return new Response(
        '<!doctype html><body><script type="module" src="/downloads.js"></script>',
        {
          headers: {
            "Content-Type": "text/html",
          },
        },
      );
    },
  });
  const origin = server.url.origin;
  const main = {
    view: "main",
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
    const found = (await windows.getDownloads(main)).find(
      (download) => download.id === id,
    );
    assert(found, "Missing retained download");
    return found;
  };
  const request = async (name: string) => {
    action = {
      kind: "download",
      url: `${origin}/${name}.bin`,
    };
    await waitFor(
      async () =>
        (await windows.getDownloads(main)).some(
          (download) =>
            download.state === "pending" &&
            download.url.endsWith(`/${name}.bin`),
        ),
      `Missing download request ${name}`,
    );
    const found = (await windows.getDownloads(main)).find(
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
      () => arrivals >= 1,
      "Renderer did not verify backend-only authority",
    );
    action = {
      kind: "download",
      url: `${origin}/disabled.bin`,
    };
    await waitFor(async () => {
      const log = await readFile(resolve(dataRoot, "logs/host.log"), "utf8");
      return (
        log.includes('"event":"download-rejected"') &&
        log.includes("/disabled.bin")
      );
    }, "Default-denied download was not observed");
    assert.deepEqual(await windows.getDownloads(main), []);
    await windows.setDownloadRequestsEnabled({
      ...main,
      enabled: true,
    });
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

    const accepted = await request("approved");
    assert.equal(accepted.mimeType, "application/octet-stream");
    assert.equal(accepted.totalBytes, content.length);
    await windows.approveDownload({
      ...main,
      id: accepted.id,
    });
    await waitFor(async () => {
      const state = await item(accepted.id);
      return state.state === "inProgress" && (state.receivedBytes ?? 0) > 0;
    }, "Approved download did not report progress");
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
    paths.add(saved.path);
    assert.equal(saved.receivedBytes, content.length);
    assert.deepEqual(await readFile(saved.path), content);
    await windows.forgetDownload({
      ...main,
      id: accepted.id,
    });

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

    const navigated = await request("navigated");
    action = {
      kind: "navigate",
      url: `${origin}/next.html`,
    };
    await waitFor(
      async () => (await item(navigated.id)).state === "cancelled",
      "Navigation retained an undecided download",
    );
    assert.equal(await Bun.file(navigated.path).exists(), false);
    await waitFor(() => arrivals >= 2, "New document did not reconnect");
    const closing = await request("closing");
    assert.equal(await Bun.file(closing.path).exists(), false);
    completed = true;
    await windows.close(main);
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
            await windows.close(main).catch(() => {});
          });
        },
      },
    ],
    commands: {
      "test.arrived": {
        input: {
          const: null,
        },
        output: {
          const: null,
        },
        async run() {
          arrivals++;
          return null;
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
          arrivals,
          approvalExpiry: true,
          nativeCleanup: true,
        },
        null,
        2,
      ),
    );
  } finally {
    await server.stop(true);
    // Only delete unique files whose browser-selected path was recorded by this test's own item.
    for (const path of paths) {
      await rm(path, {
        force: true,
      });
    }
  }
}
