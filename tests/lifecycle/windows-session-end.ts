import { dlopen, ptr } from "bun:ffi";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tray from "@bunaway/plugin-tray";
import windows from "@bunaway/plugin-windows";
import type { HostContext } from "@bunaway/protocol";
import { runWindowsApp } from "#native/windows/bun/entry";
import { containAppProcess } from "#native/windows/bun/job";
import { testAppMetadata } from "../fixtures/app-info.ts";
import { bundleNativeWorker } from "../fixtures/native-worker.ts";

// Real Win32 gate for Windows session end. Each scenario runs the host in a fresh Job-owned
// process and sends WM_QUERYENDSESSION / WM_ENDSESSION to one real top-level HWND:
//   window  - an app window, using the per-window procedure
//   control - the keep-alive control window of a windowless app
//   tray    - the tray window of a windowless tray app
const scenario = process.argv[2] ?? "window";
const targetEvents: Record<string, string | undefined> = {
  window: "window-created",
  control: "desktop-control-created",
  tray: "tray-created",
};
const targetEvent = targetEvents[scenario];
assert(targetEvent, `Unknown session-end scenario: ${scenario}`);
const repoRoot = process.argv.includes("--repo")
  ? (process.argv[process.argv.indexOf("--repo") + 1] ?? "")
  : resolve(import.meta.dir, "../..");
const root = resolve(repoRoot, `build/windows-session-end-${scenario}`);
const WM_QUERYENDSESSION = 0x0011;
const WM_ENDSESSION = 0x0016;
const ENDSESSION_LOGOFF = 0x80000000n;
const SMTO_ABORTIFHUNG = 0x2;
/** Windows gives an app about five seconds; the host must answer WM_ENDSESSION well within it. */
const SESSION_END_BUDGET_MS = 4500;
/** Failing fast beats hanging the whole native suite when the window procedure never returns. */
const SEND_TIMEOUT_MS = 8000;
const emit = (event: string, fields: Record<string, unknown> = {}) =>
  console.log(
    JSON.stringify({
      event,
      at: Date.now(),
      ...fields,
    }),
  );

if (!process.argv.includes("--child")) {
  await mkdir(resolve(root, "web"), {
    recursive: true,
  });
  await writeFile(
    resolve(root, "web/index.html"),
    "<!doctype html><title>Session end</title>",
  );
  const childEntry = await bundleNativeWorker(
    "windows-session-end",
    root,
    import.meta.path,
  );
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      fileURLToPath(childEntry),
      scenario,
      "--child",
      "--repo",
      repoRoot,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const api = dlopen("user32.dll", {
    SendMessageTimeoutW: {
      args: [
        "u64",
        "u32",
        "u64",
        "i64",
        "u32",
        "u32",
        "ptr",
      ],
      returns: "u64",
    },
    IsWindow: {
      args: [
        "u64",
      ],
      returns: "i32",
    },
  });
  const events: {
    event: string;
    at: number;
    reason?: string;
  }[] = [];
  let target = 0n;
  let pending = "";
  const decoder = new TextDecoder();
  const stream = child.stdout.pipeTo(
    new WritableStream({
      write(chunk) {
        pending += decoder.decode(chunk, {
          stream: true,
        });
        for (
          let end = pending.indexOf("\n");
          end >= 0;
          end = pending.indexOf("\n")
        ) {
          const line = pending.slice(0, end);
          pending = pending.slice(end + 1);
          if (!line) {
            continue;
          }
          const event = JSON.parse(line);
          events.push(event);
          if (event.event === targetEvent) {
            target = BigInt(event.hwnd);
          }
        }
      },
    }),
  );
  const errors = new Response(child.stderr).text();
  const timer = setTimeout(() => child.kill(), 60_000);
  async function waitFor(check: () => boolean, message: string) {
    const deadline = Date.now() + 20_000;
    while (!check()) {
      assert(Date.now() < deadline, message);
      await Bun.sleep(10);
    }
  }
  const count = (event: string) =>
    events.filter((candidate) => candidate.event === event).length;
  /** Sends a window message and fails the test, not the suite, when the procedure does not return. */
  function send(message: number, wparam: bigint, lparam: bigint) {
    const result = new BigUint64Array(1);
    const started = Date.now();
    const delivered = api.symbols.SendMessageTimeoutW(
      target,
      message,
      wparam,
      lparam,
      SMTO_ABORTIFHUNG,
      SEND_TIMEOUT_MS,
      ptr(result),
    );
    return {
      delivered: delivered !== 0n,
      result: result[0] ?? 0n,
      elapsedMs: Date.now() - started,
      returnedAt: Date.now(),
    };
  }
  try {
    await waitFor(
      () => target !== 0n && count("opened") === 1,
      "Session-end app did not become ready",
    );
    const query = send(WM_QUERYENDSESSION, 0n, ENDSESSION_LOGOFF);
    assert(query.delivered, "WM_QUERYENDSESSION must return");
    assert.equal(query.result, 1n, "WM_QUERYENDSESSION must answer TRUE");
    const cancelled = send(WM_ENDSESSION, 0n, ENDSESSION_LOGOFF);
    assert(cancelled.delivered, "cancelled WM_ENDSESSION must return");
    await waitFor(
      () => count("session-end-cancelled") === 1,
      "A cancelled session end must be reported",
    );
    // The cancelled attempt must leave the app running, unconsulted and unstopped.
    await Bun.sleep(300);
    assert.equal(child.exitCode, null, "a cancelled session end must not quit");
    assert(api.symbols.IsWindow(target));
    for (const unexpected of [
      "quitting",
      "will-quit",
      "plugin-stopped",
    ]) {
      assert.equal(count(unexpected), 0, `${unexpected} after cancellation`);
    }

    const ending = send(WM_ENDSESSION, 1n, ENDSESSION_LOGOFF);
    assert(ending.delivered, "WM_ENDSESSION must return before the timeout");
    assert.equal(ending.result, 0n);
    assert(
      ending.elapsedMs < SESSION_END_BUDGET_MS,
      `WM_ENDSESSION blocked for ${ending.elapsedMs} ms`,
    );
    // Cleanup finished before the window procedure returned. Events carry the child's clock,
    // because the parent could not read its pipe while blocked inside the send.
    await waitFor(
      () => count("will-quit") === 1 && count("plugin-stopped") === 1,
      "Session end cleanup must be reported",
    );
    for (const done of [
      "will-quit",
      "plugin-stopped",
    ]) {
      const event = events.find((candidate) => candidate.event === done);
      assert(
        event && event.at <= ending.returnedAt,
        `${done} must finish before WM_ENDSESSION returns`,
      );
    }
    assert.equal(
      events.find((candidate) => candidate.event === "will-quit")?.reason,
      "session-end",
    );
    assert.equal(
      count("quitting"),
      0,
      "beforeQuit must not run on session end",
    );
    const exitTimer = setTimeout(() => child.kill(), 20_000);
    assert.equal(await child.exited, 0, await errors);
    clearTimeout(exitTimer);
    await stream;
    const quit = events.find((candidate) => candidate.event === "quit");
    // onQuit may be cut off by the operating system, but never reports another cause.
    assert(quit === undefined || quit.reason === "session-end");
    assert.equal(api.symbols.IsWindow(target), 0);
    console.log(`PASS Windows session end ${scenario}`);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) {
      child.kill();
    }
    await child.exited;
    api.close();
  }
} else {
  const dataRoot = resolve(root, `data-${process.pid}`);
  containAppProcess(dataRoot);
  await runWindowsApp(
    {
      commands: {},
      events: {},
      plugins: [
        windows._definition,
        ...(scenario === "tray"
          ? [
              tray._definition,
            ]
          : []),
        {
          name: "session-end-test",
          version: "1",
          setup() {
            return () => emit("plugin-stopped");
          },
        },
      ],
      desktop: {
        closeBehavior: "keep-alive",
        ...(scenario === "tray"
          ? {
              tray: {
                tooltip: "Bunaway session end",
              },
            }
          : {}),
        beforeQuit(reason) {
          emit("quitting", {
            reason,
          });
          // A veto must have no effect on a session end.
          return false;
        },
        onOpen() {
          emit("opened");
        },
        onWillQuit(reason) {
          emit("will-quit", {
            reason,
          });
        },
        onQuit(reason) {
          emit("quit", {
            reason,
          });
        },
      },
    },
    {
      appMetadata: testAppMetadata,
      runtime: {
        id: "session-end-test",
        generation: crypto.randomUUID(),
      },
      backendContext: "backend-session-end" as HostContext,
      assets: root,
      dataRoot,
      loader: resolve(
        repoRoot,
        "build/cache/webview2/sdk/build/native/x64/WebView2Loader.dll",
      ),
      policy: {
        version: 1,
        backend: {
          permissions: [],
        },
        views: [
          {
            id: "main",
            origins: [
              "https://app.bunaway.local",
            ],
            commands: [],
            events: [],
            host: {
              permissions: [],
            },
          },
        ],
      },
      windows:
        scenario === "window"
          ? [
              {
                view: "main",
                title: "Session end",
                home: "https://app.bunaway.local/index.html",
                window: {
                  width: 640,
                  height: 480,
                },
              },
            ]
          : [],
    },
    {
      argv: [],
      cwd: root,
    },
  );
}
