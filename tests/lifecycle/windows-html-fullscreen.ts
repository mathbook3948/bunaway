import { dlopen, ptr } from "bun:ffi";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineApp } from "@bunaway/backend";
import windows from "@bunaway/plugin-windows";
import type { HostContext, Policy } from "@bunaway/protocol";
import { runWindowsApp } from "#native/windows/bun/entry";
import { testAppMetadata } from "../fixtures/app-info.ts";
import { killAfter } from "../fixtures/deadlines.ts";
import { bundleNativeWorker } from "../fixtures/native-worker.ts";
import { windowPermissions } from "../fixtures/window-permissions.ts";

assert.equal(process.platform, "win32");
const root = resolve(import.meta.dir, "../..");
const output = resolve(root, "build/windows-html-fullscreen");
const assets = resolve(output, "assets");
const reportPath = resolve(output, "report.json");
/** Unique caption so FindWindowW cannot match an unrelated desktop window. */
const WINDOW_CAPTION = "Bunaway HTML fullscreen main";
// Win32 SendInput constants for one absolute left click.
const INPUT_SIZE = 40;
const INPUT_MOUSE = 0;
const MOUSEEVENTF_MOVE = 0x0001;
const MOUSEEVENTF_LEFTDOWN = 0x0002;
const MOUSEEVENTF_LEFTUP = 0x0004;
const MOUSEEVENTF_ABSOLUTE = 0x8000;
const ABSOLUTE_COORDINATE_RANGE = 65535;
const SM_CXSCREEN = 0;
const SM_CYSCREEN = 1;
// Wait after moving the pointer so the browser sees a hover target before the click.
const POINTER_SETTLE_MS = 150;
// SetWindowPos Z-order handle (-1) and flags.
const HWND_TOPMOST = -1n;
const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOACTIVATE = 0x0010;
const policy: Policy = {
  version: 1,
  backend: {
    permissions: [
      ...windowPermissions(),
    ],
  },
  views: [
    {
      id: "main",
      origins: [
        "https://app.bunaway.local",
      ],
      commands: [
        "test.click",
        "test.isFullscreen",
        "test.setFullscreen",
        "test.finish",
      ],
      events: [
        "windows.htmlFullscreenChanged",
      ],
      host: {
        permissions: [
          ...windowPermissions(),
        ],
      },
    },
  ],
};

if (!process.argv.includes("--child")) {
  await mkdir(resolve(assets, "web"), {
    recursive: true,
  });
  await writeFile(
    resolve(assets, "web/index.html"),
    '<!doctype html><title>HTML fullscreen</title><script type="module" src="/fullscreen.js"></script>',
  );
  const web = await Bun.build({
    entrypoints: [
      resolve(root, "tests/lifecycle/windows-bun/html-fullscreen.js"),
    ],
    target: "browser",
  });
  assert(web.success, web.logs.map(String).join("\n"));
  for (const artifact of web.outputs) {
    await writeFile(
      resolve(assets, "web/fullscreen.js"),
      await artifact.text(),
    );
  }
  const entry = await bundleNativeWorker(
    "windows-html-fullscreen",
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
        BUNAWAY_HTML_FULLSCREEN_TEST_ROOT: root,
      },
    },
  );
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  const timeout = killAfter(child, "nativeFixture");
  try {
    const code = await child.exited;
    assert.equal(code, 0, `${await stderr}\n${await stdout}`);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    assert.equal(report.error, undefined, JSON.stringify(report));
    // A window that was windowed follows the page element in and out.
    assert.equal(report.windowDuringElement, true);
    assert.equal(report.windowAfterElement, false);
    // A window that was already fullscreen keeps its state when the element ends.
    assert.equal(report.windowDuringElementAlreadyFullscreen, true);
    assert.equal(report.windowAfterElementAlreadyFullscreen, true);
    assert.deepEqual(report.events, [
      true,
      false,
      true,
      false,
    ]);
    console.log(
      "PASS WebView2 HTML fullscreen: the window enters and leaves fullscreen with the page element, an already fullscreen window stays fullscreen, events report each page state",
    );
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) {
      child.kill();
    }
    await child.exited;
  }
} else {
  // The bundled child has a different import.meta.dir; use the driver-selected repository root.
  const childRoot = process.env.BUNAWAY_HTML_FULLSCREEN_TEST_ROOT;
  assert(childRoot);
  const childAssets = resolve(
    childRoot,
    "build/windows-html-fullscreen/assets",
  );
  const childReport = resolve(
    childRoot,
    "build/windows-html-fullscreen/report.json",
  );
  const user = dlopen("user32.dll", {
    FindWindowW: {
      args: [
        "ptr",
        "ptr",
      ],
      returns: "u64",
    },
    GetClientRect: {
      args: [
        "u64",
        "ptr",
      ],
      returns: "i32",
    },
    ClientToScreen: {
      args: [
        "u64",
        "ptr",
      ],
      returns: "i32",
    },
    GetSystemMetrics: {
      args: [
        "i32",
      ],
      returns: "i32",
    },
    SetWindowPos: {
      args: [
        "u64",
        "i64",
        "i32",
        "i32",
        "i32",
        "i32",
        "u32",
      ],
      returns: "i32",
    },
    SendInput: {
      args: [
        "u32",
        "ptr",
        "i32",
      ],
      returns: "u32",
    },
  });
  /** Send one batch of absolute mouse events at a screen point, in physical pixels. */
  const sendMouse = (screenX: number, screenY: number, flags: number[]) => {
    const screenWidth = user.symbols.GetSystemMetrics(SM_CXSCREEN);
    const screenHeight = user.symbols.GetSystemMetrics(SM_CYSCREEN);
    const x = Math.round(
      (screenX * ABSOLUTE_COORDINATE_RANGE) / (screenWidth - 1),
    );
    const y = Math.round(
      (screenY * ABSOLUTE_COORDINATE_RANGE) / (screenHeight - 1),
    );
    const events = Buffer.alloc(INPUT_SIZE * flags.length);
    flags.forEach((flag, index) => {
      const base = INPUT_SIZE * index;
      events.writeUInt32LE(INPUT_MOUSE, base);
      events.writeInt32LE(x, base + 8);
      events.writeInt32LE(y, base + 12);
      events.writeUInt32LE(flag, base + 20);
    });
    assert.equal(
      user.symbols.SendInput(flags.length, ptr(events), INPUT_SIZE),
      flags.length,
    );
  };
  /** A real left click at the center of the window's client area, which is the WebView. */
  const clickClientCenter = async () => {
    const hwnd = user.symbols.FindWindowW(
      null,
      ptr(Buffer.from(`${WINDOW_CAPTION}\0`, "utf16le")),
    );
    assert(hwnd !== 0n, `Window ${WINDOW_CAPTION} was not found`);
    // Raise only this window above others, such as the runner's console, so the click reaches
    // it; activation still comes from the click. The window closes at the end of the test.
    assert(
      user.symbols.SetWindowPos(
        hwnd,
        HWND_TOPMOST,
        0,
        0,
        0,
        0,
        SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE,
      ) !== 0,
      `SetWindowPos failed for window ${hwnd}`,
    );
    // RECT is left, top, right, bottom with left and top fixed at 0 for client coordinates.
    const clientRect = new Int32Array(4);
    assert(user.symbols.GetClientRect(hwnd, ptr(clientRect)));
    const [, , clientWidth = 0, clientHeight = 0] = clientRect;
    // POINT is x then y; ClientToScreen rewrites it in place.
    const center = new Int32Array([
      Math.floor(clientWidth / 2),
      Math.floor(clientHeight / 2),
    ]);
    assert(user.symbols.ClientToScreen(hwnd, ptr(center)));
    const [screenX = 0, screenY = 0] = center;
    sendMouse(screenX, screenY, [
      MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE,
    ]);
    await Bun.sleep(POINTER_SETTLE_MS);
    sendMouse(screenX, screenY, [
      MOUSEEVENTF_LEFTDOWN | MOUSEEVENTF_ABSOLUTE,
      MOUSEEVENTF_LEFTUP | MOUSEEVENTF_ABSOLUTE,
    ]);
  };
  const app = defineApp({
    modules: [],
    plugins: [
      windows,
    ],
    commands: {
      "test.click": {
        input: {
          const: null,
        },
        output: {
          const: null,
        },
        async run() {
          await clickClientCenter();
          return null;
        },
      },
      "test.isFullscreen": {
        input: {
          const: null,
        },
        output: {
          type: "boolean",
        },
        async run() {
          return await windows.isFullscreen();
        },
      },
      "test.setFullscreen": {
        input: {
          const: true,
        },
        output: {
          const: null,
        },
        async run() {
          await windows.setFullscreen({
            fullscreen: true,
          });
          return null;
        },
      },
      "test.finish": {
        input: {
          type: "object",
        },
        output: {
          const: null,
        },
        async run(input: unknown) {
          await writeFile(childReport, JSON.stringify(input));
          await windows.setFullscreen({
            fullscreen: false,
          });
          await windows.close();
          return null;
        },
      },
    },
  });
  await runWindowsApp(app, {
    appMetadata: testAppMetadata,
    runtime: {
      id: "html-fullscreen",
      generation: crypto.randomUUID(),
    },
    backendContext: `backend-${crypto.randomUUID()}` as HostContext,
    policy,
    assets: childAssets,
    dataRoot: resolve(
      childRoot,
      `build/windows-html-fullscreen/data-${process.pid}`,
    ),
    loader: resolve(
      childRoot,
      "build/cache/webview2/sdk/build/native/x64/WebView2Loader.dll",
    ),
    windows: [
      {
        view: "main",
        title: WINDOW_CAPTION,
        home: "https://app.bunaway.local/index.html",
        window: {
          width: 640,
          height: 480,
        },
      },
    ],
  });
}
