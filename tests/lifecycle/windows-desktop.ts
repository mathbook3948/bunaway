import { dlopen } from "bun:ffi";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runWindowsApp } from "../../native/windows/bun/entry.ts";
import {
  forwardToInstance,
  instanceAddress,
  listenForInstances,
} from "../../native/windows/bun/instance.ts";
import { containAppProcess } from "../../native/windows/bun/job.ts";
import { closeWindowsApp } from "../../packages/cli/src/launch.ts";
import type { AppDefinition } from "../../packages/core/src/index.ts";
import {
  type HostContext,
  NativeRegistry,
} from "../../packages/protocol/src/index.ts";
import { windowsPlugin } from "../../plugins/windows/src/index.ts";
import { bundleNativeWorker } from "../fixtures/native-worker.ts";

const windowRegistry = new NativeRegistry([
  windowsPlugin,
]);

let uiReadyResolve: () => void = () => {};
const uiReady = new Promise<void>((resolveReady) => {
  uiReadyResolve = resolveReady;
});
let uiRestoredResolve: () => void = () => {};
const uiRestored = new Promise<void>((resolveRestored) => {
  uiRestoredResolve = resolveRestored;
});
export const desktopTestApp = {
  plugins: [
    windowsPlugin,
  ],
  commands: {
    "test.ready": {
      input: {
        const: null,
      },
      output: {
        const: null,
      },
      async run() {
        uiReadyResolve();
        return null;
      },
    },
    "test.restored": {
      input: {
        const: null,
      },
      output: {
        const: null,
      },
      async run(_input, context) {
        if (scenario === "hide") {
          assert.equal(
            await context.host.call(windowRegistry.operation("windows.close"), {
              view: "main",
            }),
            false,
          );
          assert(
            !context.signal.aborted,
            "close to tray must keep the request context alive",
          );
          await context.host.call(windowRegistry.operation("windows.show"), {
            view: "main",
          });
        }
        uiRestoredResolve();
        return null;
      },
    },
  },
  events: {
    "test.reopen": {
      const: null,
    },
  },
} satisfies AppDefinition;

// Real Win32/WebView2 gate. Each scenario runs in a fresh Job-owned process.
const scenario = process.argv[2] ?? "hide";
const devShutdown = scenario.startsWith("dev-");
const devPending = scenario === "dev-pending";
const repoRoot = process.argv.includes("--repo")
  ? (process.argv[process.argv.indexOf("--repo") + 1] ?? "")
  : resolve(import.meta.dir, "../..");
const root = resolve(repoRoot, `build/windows-desktop-${scenario}`);
if (!process.argv.includes("--child")) {
  await mkdir(resolve(root, "web"), {
    recursive: true,
  });
  const built = await Bun.build({
    entrypoints: [
      resolve(import.meta.dir, "windows-desktop-web.ts"),
    ],
    target: "browser",
  });
  assert(built.success && built.outputs[0]);
  await writeFile(
    resolve(root, "web/app.js"),
    new Uint8Array(await built.outputs[0].arrayBuffer()),
  );
  await writeFile(
    resolve(root, "web/index.html"),
    '<!doctype html><title>Desktop lifecycle</title><script type="module" src="app.js"></script>',
  );
  const childEntry = await bundleNativeWorker(
    "windows-desktop",
    resolve(root, "driver"),
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
    PostMessageW: {
      args: [
        "u64",
        "u32",
        "u64",
        "i64",
      ],
      returns: "i32",
    },
    IsWindowVisible: {
      args: [
        "u64",
      ],
      returns: "i32",
    },
    IsWindow: {
      args: [
        "u64",
      ],
      returns: "i32",
    },
    ShowWindow: {
      args: [
        "u64",
        "i32",
      ],
      returns: "i32",
    },
    IsZoomed: {
      args: [
        "u64",
      ],
      returns: "i32",
    },
  });
  let hwnd = 0n;
  let trayWindow = 0n;
  let trayQuit = false;
  let pending = "";
  let hidden = false;
  let vetoed = false;
  let reopened = false;
  let sessionCount = 0;
  let quitCount = 0;
  let stopped = false;
  const decoder = new TextDecoder();
  const stream = child.stdout.pipeTo(
    new WritableStream({
      async write(chunk) {
        pending += decoder.decode(chunk, {
          stream: true,
        });
        while (pending.includes("\n")) {
          const end = pending.indexOf("\n");
          const line = pending.slice(0, end);
          pending = pending.slice(end + 1);
          if (!line) {
            continue;
          }
          const event = JSON.parse(line);
          if (event.event === "desktop-stopped") {
            stopped = true;
          }
          if (event.event === "quitting") {
            quitCount++;
            if (devPending) {
              assert.equal(await closeWindowsApp(child.pid), 1);
            }
          }
          if (event.event === "session-open") {
            sessionCount++;
          }
          if (event.event === "tray-created") {
            trayWindow = BigInt(event.hwnd);
          }
          if (event.event === "quitting" && event.reason === "tray") {
            trayQuit = true;
          }
          if (event.event === "window-created") {
            hwnd = BigInt(event.hwnd);
          }
          if (event.event === "opened" && event.source === "initial") {
            assert(hwnd);
            if (devShutdown && !devPending) {
              assert.equal(
                await closeWindowsApp(child.pid),
                trayWindow ? 2 : 1,
              );
              continue;
            }
            if (scenario === "hide") {
              api.symbols.ShowWindow(hwnd, 3);
            }
            assert(api.symbols.PostMessageW(hwnd, 0x10, 0n, 0n));
          }
          if (event.event === "view-window-hidden") {
            if (hidden) {
              continue;
            }
            hidden = true;
            assert.equal(api.symbols.IsWindowVisible(hwnd), 0);
            assert.equal(child.exitCode, null);
            await forwardToInstance(
              instanceAddress(resolve(root, `data-${child.pid}`)),
              {
                argv: [
                  "한글 파일.txt",
                  "memo://open/42",
                ],
                cwd: root,
              },
            );
          }
          if (event.event === "quit-vetoed") {
            vetoed = true;
            assert(api.symbols.IsWindow(hwnd));
            assert.equal(child.exitCode, null);
            await forwardToInstance(
              instanceAddress(resolve(root, `data-${child.pid}`)),
              {
                argv: [
                  "memo://open/42",
                ],
                cwd: root,
              },
            );
          }
          if (event.event === "opened" && event.source === "second-instance") {
            reopened = true;
            assert(api.symbols.IsWindowVisible(hwnd));
            assert.deepEqual(event.urls, [
              "memo://open/42",
            ]);
            if (scenario === "hide") {
              assert(
                api.symbols.IsZoomed(hwnd),
                "restoring a hidden window must preserve maximization",
              );
              assert.deepEqual(event.files, [
                resolve(root, "한글 파일.txt"),
              ]);
              assert(trayWindow);
              assert(api.symbols.PostMessageW(trayWindow, 0x10, 0n, 0n));
            }
          }
        }
      },
    }),
  );
  const errors = new Response(child.stderr).text();
  const timer = setTimeout(() => child.kill(), devShutdown ? 20000 : 60000);
  try {
    assert.equal(await child.exited, 0, await errors);
    await stream;
    assert(stopped, "CLI shutdown must run plugin cleanup");
    if (devShutdown) {
      assert(!reopened && !hidden && !vetoed);
      assert.equal(
        quitCount,
        devPending ? 1 : 0,
        "CLI shutdown must bypass beforeQuit",
      );
    } else {
      assert(reopened);
      assert(scenario === "hide" ? hidden && trayQuit : vetoed);
    }
    assert.equal(
      sessionCount,
      1,
      "hidden or vetoed view must retain its original session",
    );
    assert.equal(api.symbols.IsWindow(hwnd), 0);
    if (trayWindow) {
      assert.equal(api.symbols.IsWindow(trayWindow), 0);
    }
    console.log(`PASS Windows desktop ${scenario}`);
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
  const inbox = await listenForInstances(instanceAddress(dataRoot));
  let ticks = 0;
  let atOpen = 0;
  let attempts = 0;
  let emitReopen: () => Promise<void> = async () => {};
  const timer = setInterval(() => {
    ticks++;
  }, 10);
  try {
    await runWindowsApp(
      {
        ...desktopTestApp,
        plugins: [
          ...desktopTestApp.plugins,
          {
            name: "desktop-test",
            version: "1",
            setup(context) {
              emitReopen = () =>
                context.events.emit("test.reopen", null, {
                  kind: "broadcast",
                });
              return () =>
                console.log(
                  JSON.stringify({
                    event: "desktop-stopped",
                  }),
                );
            },
          },
        ],
        desktop: {
          ...(scenario === "hide" || scenario === "dev-hide"
            ? ({
                closeBehavior: "hide",
                tray: {
                  tooltip: "Bunaway lifecycle",
                },
              } as const)
            : {}),
          beforeQuit(reason) {
            console.log(
              JSON.stringify({
                event: "quitting",
                reason,
              }),
            );
            if (devPending) {
              return new Promise<boolean>(() => {});
            }
            if (devShutdown) {
              return false;
            }
            if (scenario === "veto" && attempts++ === 0) {
              // Keep the check pending briefly so repeated WM_CLOSE remains coalesced.
              return Bun.sleep(30).then(() => {
                console.log(
                  JSON.stringify({
                    event: "quit-vetoed",
                  }),
                );
                return false;
              });
            }
            return true;
          },
          async onOpen(request, context) {
            if (request.source === "initial") {
              await uiReady;
            } else {
              await Bun.sleep(100);
              assert(ticks > atOpen, "backend stopped while hidden or vetoed");
              await emitReopen();
              await uiRestored;
            }
            console.log(
              JSON.stringify({
                event: "opened",
                source: request.source,
                urls: request.urls,
                files: request.files,
              }),
            );
            if (request.source === "initial") {
              atOpen = ticks;
              return;
            }
            if (scenario === "veto") {
              assert(await context.quit());
            }
          },
        },
      },
      {
        runtime: {
          id: "desktop-test",
          generation: crypto.randomUUID(),
        },
        backendContext: "backend-desktop" as HostContext,
        assets: root,
        dataRoot,
        loader: resolve(
          repoRoot,
          "native/windows/bun/vendor/sdk/build/native/x64/WebView2Loader.dll",
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
              commands: [
                "test.ready",
                "test.restored",
              ],
              events: [
                "test.reopen",
              ],
              host: {
                permissions: [
                  "windows:list",
                  {
                    identifier: "windows:control",
                    allow: [
                      {
                        view: "main",
                      },
                    ],
                  },
                ],
              },
            },
          ],
        },
        windows: [
          {
            view: "main",
            title: "Desktop lifecycle",
            home: "https://app.bunaway.local/index.html",
            window: {
              width: 640,
              height: 480,
            },
          },
        ],
      },
      {
        argv: [],
        cwd: root,
      },
      inbox,
    );
  } finally {
    clearInterval(timer);
    await inbox.close();
  }
}
