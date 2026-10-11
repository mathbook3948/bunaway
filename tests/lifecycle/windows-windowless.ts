import { dlopen } from "bun:ffi";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CommandContext, DesktopContext } from "@bunaway/core";
import {
  validateWindowOutput,
  type WindowOperation,
  windowsPlugin,
} from "@bunaway/plugin-windows";
import { type HostContext, NativeRegistry } from "@bunaway/protocol";
import { closeWindowsApp } from "#cli/windows-dev-launch";
import { runWindowsApp } from "#native/windows/bun/entry";
import { bundleNativeWorker } from "../fixtures/native-worker.ts";

assert.equal(process.platform, "win32");
const root =
  process.env.BUNAWAY_WINDOWLESS_ROOT ?? resolve(import.meta.dir, "../..");
const output = resolve(root, "build/windows-windowless");
const scenario = process.argv[2] ?? "resident";
const assets = resolve(output, "assets");
const dataRoot = resolve(output, `${scenario}-${process.pid}`);
const hasTray = scenario.includes("tray");
const empty = scenario.endsWith("empty");
const registry = new NativeRegistry([
  windowsPlugin,
]);
const emit = (event: string, fields: Record<string, unknown> = {}) =>
  console.log(
    JSON.stringify({
      event,
      ...fields,
    }),
  );
const TRAY_CALLBACK_MESSAGE = 0x8001;
const WM_LBUTTONUP = 0x0202;
const WM_CLOSE = 0x0010;

/** Wait for observable native state, keeping the UI Worker and backend event loops running. */
async function waitFor(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 20_000;
  while (!(await check())) {
    assert(Date.now() < deadline, "Windowless scenario timed out");
    await Bun.sleep(10);
  }
}

if (!process.argv.includes("--child")) {
  await mkdir(resolve(assets, "web"), {
    recursive: true,
  });
  const web = await Bun.build({
    entrypoints: [
      resolve(root, "tests/lifecycle/windows-windowless-web.ts"),
    ],
    target: "browser",
  });
  assert(web.success && web.outputs[0]);
  await writeFile(resolve(assets, "web/app.js"), await web.outputs[0].text());
  await writeFile(
    resolve(assets, "web/index.html"),
    '<!doctype html><title>Windowless test</title><script type="module" src="app.js"></script>',
  );
  const entry = await bundleNativeWorker(
    "windows-windowless",
    assets,
    import.meta.path,
  );
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      fileURLToPath(entry),
      scenario,
      "--child",
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        BUNAWAY_WINDOWLESS_ROOT: root,
      },
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
    IsWindow: {
      args: [
        "u64",
      ],
      returns: "i32",
    },
    IsWindowVisible: {
      args: [
        "u64",
      ],
      returns: "i32",
    },
  });
  let owner = 0n;
  const handles: bigint[] = [];
  let created = 0;
  let quitChecks = 0;
  let stopped = false;
  let ready = false;
  let verified = false;
  const processApi = dlopen("kernel32.dll", {
    OpenProcess: {
      args: [
        "u32",
        "i32",
        "u32",
      ],
      returns: "u64",
    },
    WaitForSingleObject: {
      args: [
        "u64",
        "u32",
      ],
      returns: "u32",
    },
    CloseHandle: {
      args: [
        "u64",
      ],
      returns: "i32",
    },
  });
  const SYNCHRONIZE = 0x00100000;
  let descendant = 0n;
  const post = (message: number, lparam = 0n) =>
    assert(api.symbols.PostMessageW(owner, message, 0n, lparam));
  let pending = "";
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
          if (event.event === "owned-child") {
            descendant = processApi.symbols.OpenProcess(
              SYNCHRONIZE,
              0,
              event.pid,
            );
            assert(descendant);
          }
          if (
            event.event === "tray-created" ||
            event.event === "desktop-control-created"
          ) {
            owner = BigInt(event.hwnd);
            handles.push(owner);
            assert.equal(api.symbols.IsWindowVisible(owner), 0);
          }
          if (event.event === "window-created") {
            created++;
            handles.push(BigInt(event.hwnd));
          }
          if (event.event === "windowless-ready") {
            ready = true;
            assert.equal(created, 0, "windowless startup created an app HWND");
            assert(owner);
            if (scenario === "dev-pending-tray") {
              post(WM_CLOSE);
            } else if (scenario.startsWith("dev-")) {
              assert.equal(await closeWindowsApp(child.pid), 1);
            } else if (scenario.startsWith("force-")) {
              child.kill();
            } else if (hasTray) {
              post(TRAY_CALLBACK_MESSAGE, BigInt(WM_LBUTTONUP));
              if (empty) {
                await Bun.sleep(100);
                assert.equal(created, 0);
                post(WM_CLOSE);
              }
            }
          }
          if (
            event.event === "restore-requested" ||
            event.event === "recreate-requested"
          ) {
            // Repeated clicks must coalesce while old WebView cleanup is pending.
            for (let count = 0; count < 3; count++) {
              post(TRAY_CALLBACK_MESSAGE, BigInt(WM_LBUTTONUP));
            }
          }
          if (event.event === "tray-quit-requested") {
            post(WM_CLOSE);
          }
          if (event.event === "native-close-requested") {
            const hwnd = handles.at(-1);
            assert(hwnd);
            assert(api.symbols.PostMessageW(hwnd, WM_CLOSE, 0n, 0n));
          }
          if (event.event === "quit-check") {
            quitChecks++;
            if (scenario === "dev-pending-tray") {
              assert.equal(await closeWindowsApp(child.pid), 1);
            }
          }
          if (event.event === "quit-vetoed" && hasTray) {
            await Bun.sleep(100);
            assert.equal(child.exitCode, null);
            assert(api.symbols.IsWindow(owner));
            post(WM_CLOSE);
          }
          if (event.event === "verified") {
            verified = true;
          }
          if (event.event === "plugin-stopped") {
            stopped = true;
          }
        }
      },
    }),
  );
  const errors = new Response(child.stderr).text();
  const timer = setTimeout(() => child.kill(), 60_000);
  try {
    const exit = await child.exited;
    await stream;
    const stderr = await errors;
    assert(ready, stderr);
    if (scenario.startsWith("force-")) {
      assert.notEqual(exit, 0);
      assert(!stopped, "OS force kill cannot promise plugin cleanup");
    } else {
      assert.equal(exit, 0, stderr);
      assert(stopped, "orderly shutdown must run StopHook");
      if (scenario.startsWith("dev-")) {
        assert.equal(
          quitChecks,
          scenario === "dev-pending-tray" ? 1 : 0,
          "CLI interruption must bypass beforeQuit",
        );
      } else {
        assert.equal(quitChecks, 2);
        assert(empty || verified);
        assert.equal(created, empty ? 0 : 2);
      }
    }
    for (const hwnd of handles) {
      assert.equal(api.symbols.IsWindow(hwnd), 0);
    }
    if (descendant) {
      assert.equal(
        processApi.symbols.WaitForSingleObject(descendant, 5000),
        0,
        "force kill must close the Job's descendants",
      );
    }
    const log = await Bun.file(
      resolve(output, `${scenario}-${child.pid}`, "logs/host.log"),
    ).text();
    if (!scenario.startsWith("force-")) {
      assert(log.includes('"host-stopped"'));
      assert(log.includes('"activeProcesses":0'));
    }
    console.log(
      `PASS Windows windowless ${scenario}: native HWND/tray, liveness and cleanup`,
    );
    await writeFile(
      resolve(output, `${scenario}-report.json`),
      `${JSON.stringify(
        {
          scenario,
          pass: true,
          created,
          quitChecks,
          stopped,
          forced: scenario.startsWith("force-"),
          generatedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) {
      child.kill();
    }
    await child.exited;
    api.close();
    if (descendant) {
      processApi.symbols.CloseHandle(descendant);
    }
    processApi.close();
  }
} else {
  let backend: CommandContext | undefined;
  let sessions = 0;
  let ticks = 0;
  let attempts = 0;
  const timer = setInterval(() => {
    ticks++;
  }, 10);
  const call = async <K extends WindowOperation>(
    operation: K,
    payload: {
      view: string;
    },
  ) => {
    assert(backend);
    return validateWindowOutput(
      operation,
      await backend.host.call(registry.operation(operation), payload),
    );
  };
  const ready = () => waitFor(() => sessions > 0);
  /** Exercise deferred creation, last close and restoration through real backend Host calls. */
  async function exercise(desktop: DesktopContext) {
    assert(backend);
    const listed = validateWindowOutput(
      "windows.list",
      await backend.host.call(registry.operation("windows.list"), null),
    );
    assert.deepEqual(
      listed.map((window) => [
        window.view,
        window.open,
      ]),
      empty
        ? []
        : [
            [
              "main",
              false,
            ],
          ],
    );
    if (scenario.startsWith("force-")) {
      const child = Bun.spawn(
        [
          process.execPath,
          "-e",
          "setInterval(() => {}, 1000)",
        ],
        {
          stdout: "ignore",
          stderr: "ignore",
        },
      );
      emit("owned-child", {
        pid: child.pid,
      });
    }
    const before = ticks;
    await Bun.sleep(150);
    assert(ticks > before, "backend must continue with no views");
    emit("windowless-ready");
    if (scenario.startsWith("dev-") || scenario.startsWith("force-")) {
      return;
    }
    if (empty) {
      if (!hasTray) {
        await desktop.show();
        assert.equal(await desktop.quit(), false);
        assert.equal(await desktop.quit(), true);
      }
      return;
    }
    if (!hasTray) {
      await call("windows.create", {
        view: "main",
      });
    }
    await ready();
    const original = await call("windows.getSnapshot", {
      view: "main",
    });
    await call("windows.maximize", {
      view: "main",
    });
    if (hasTray) {
      await desktop.hide();
      await waitFor(
        async () =>
          !(await call("windows.isVisible", {
            view: "main",
          })),
      );
      emit("restore-requested");
      await waitFor(() =>
        call("windows.isVisible", {
          view: "main",
        }),
      );
      assert(
        await call("windows.isMaximized", {
          view: "main",
        }),
      );
      assert.equal(
        (
          await call("windows.getSnapshot", {
            view: "main",
          })
        ).windowId,
        original.windowId,
      );
      assert.equal(sessions, 1, "tray restoration must preserve the session");
      await call("windows.minimize", {
        view: "main",
      });
      emit("restore-requested");
      await waitFor(
        async () =>
          !(await call("windows.isMinimized", {
            view: "main",
          })),
      );
    }
    emit("native-close-requested");
    await waitFor(() =>
      call("windows.isDestroyed", {
        view: "main",
      }),
    );
    assert.equal(attempts, 0, "keep-alive last close must not call beforeQuit");
    await Bun.sleep(100);
    const closedTicks = ticks;
    if (hasTray) {
      emit("recreate-requested");
    } else {
      await desktop.show();
    }
    await waitFor(() => sessions === 2);
    assert(ticks > closedTicks);
    assert.notEqual(
      (
        await call("windows.getSnapshot", {
          view: "main",
        })
      ).windowId,
      original.windowId,
    );
    assert.equal(
      await call("windows.close", {
        view: "main",
      }),
      true,
    );
    emit("verified");
    if (hasTray) {
      emit("tray-quit-requested");
    } else {
      assert.equal(await desktop.quit(), false);
      assert.equal(await desktop.quit(), true);
    }
  }
  try {
    await runWindowsApp(
      {
        commands: {
          "test.ready": {
            input: {
              const: null,
            },
            output: {
              const: null,
            },
            async run() {
              sessions++;
              return null;
            },
          },
        },
        events: {},
        plugins: [
          windowsPlugin,
          {
            name: "windowless-test",
            version: "1",
            setup(context) {
              backend = context;
              return () => emit("plugin-stopped");
            },
          },
        ],
        desktop: {
          // Empty tray-only apps also exercise the default quit policy with no startup views.
          ...(!(hasTray && empty)
            ? {
                closeBehavior: "keep-alive" as const,
              }
            : {}),
          ...(hasTray
            ? {
                tray: {
                  tooltip: "Bunaway windowless test",
                },
              }
            : {}),
          beforeQuit(reason) {
            emit("quit-check", {
              reason,
            });
            if (scenario === "dev-pending-tray") {
              return new Promise<boolean>(() => {});
            }
            if (attempts++ === 0) {
              emit("quit-vetoed");
              return false;
            }
            return true;
          },
          async onOpen(_request, desktop) {
            try {
              await exercise(desktop);
            } catch (error) {
              console.error(error);
              process.exit(1);
            }
          },
        },
      },
      {
        runtime: {
          id: "windowless-test",
          generation: crypto.randomUUID(),
        },
        backendContext: "backend-windowless" as HostContext,
        assets,
        dataRoot,
        loader: resolve(
          root,
          "build/cache/webview2/sdk/build/native/x64/WebView2Loader.dll",
        ),
        policy: {
          version: 1,
          backend: {
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
          views: [
            {
              id: "main",
              origins: [
                "https://app.bunaway.local",
              ],
              commands: [
                "test.ready",
              ],
              events: [],
              host: {
                permissions: [],
              },
            },
          ],
        },
        windows: empty
          ? []
          : [
              {
                view: "main",
                title: "Windowless test",
                home: "https://app.bunaway.local/index.html",
                startup: false,
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
    );
  } finally {
    clearInterval(timer);
  }
}
