import { dlopen, ptr } from "bun:ffi";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { checkHresult } from "@bunaway/plugin/win32";
import type { NativeMenuWindowHost } from "@bunaway/plugin-api/native";
import {
  type ComHandler,
  checkCallbacks,
  disposeCom,
  disposeHandlers,
} from "#native/windows/bun/com";
import { WebView } from "#native/windows/bun/webview";
import { Windows } from "#native/windows/bun/win32";
import { disposeWin32Bindings, ole } from "#native/windows/bun/win32-bindings";
import { webViewKeyMessage } from "#native/windows/bun/window-input-events";
import { menuItemsSchema } from "#plugins/menu/src/contract";
import { WindowMenus } from "#plugins/menu/src/platforms/windows-window-menus";
import { deadline } from "../fixtures/deadlines.ts";

// Alt taps while the page owns keyboard focus, in a real WebView2 window: the controller's
// accelerator event reaches WindowMenus like a frame key, so an auto-hide menu bar links after
// an Alt tap and unlinks on the next one and on Esc, and Alt used with another key is no tap.
assert.equal(process.platform, "win32");
const root = resolve(import.meta.dir, "../..");
const output = resolve(root, "build/windows-menu-auto-hide");
const assets = resolve(output, "assets");
const caption = "Bunaway menu auto-hide";
const STEP_TIMEOUT_MS = deadline("childStep");
const WM_KEYDOWN = 0x0100;
const WM_KEYUP = 0x0101;
const WM_SYSKEYDOWN = 0x0104;
const WM_SYSKEYUP = 0x0105;
const VK_MENU = 0x12;
const VK_ESCAPE = 0x1b;
const VK_F = 0x46;
const SCAN_MENU = 0x38;
const SCAN_ESCAPE = 0x01;
const SCAN_F = 0x21;

const user = dlopen("user32.dll", {
  GetMenu: {
    args: [
      "u64",
    ],
    returns: "u64",
  },
  FindWindowExW: {
    args: [
      "u64",
      "u64",
      "ptr",
      "ptr",
    ],
    returns: "u64",
  },
  PostMessageW: {
    args: [
      "u64",
      "u32",
      "u64",
      "u64",
    ],
    returns: "i32",
  },
});

await mkdir(resolve(assets, "web"), {
  recursive: true,
});
await writeFile(
  resolve(assets, "web/index.html"),
  `<!doctype html><title>Menu auto-hide</title><input id="a">
  <script>
    addEventListener("DOMContentLoaded", () => {
      document.getElementById("a").focus();
      chrome.webview.postMessage("loaded");
    });
  </script>`,
);
checkHresult(ole.symbols.CoInitializeEx(null, 2), "CoInitializeEx(STA)");
const windows = new Windows(() => {});
const listeners = new Set<
  (message: number, wparam: bigint, lparam: bigint) => void
>();
const pending: ComHandler[] = [];
let hwnd = 0n;
let view: WebView | undefined;
let menus: WindowMenus | undefined;
let loaded = false;
let verified = false;
const accelerators: string[] = [];
const step = (name: string) => console.log(`STEP ${name}`);
// Reports the fixture state and fails when it outlives its deadline while the event loop still runs.
const watchdog = setTimeout(() => {
  console.error(
    `menu auto-hide fixture exceeded its deadline (accelerator events: ${accelerators.join(",")})`,
  );
  process.exit(1);
}, deadline("nativeFixture"));

async function pumpUntil(done: () => boolean, what: string): Promise<void> {
  const limit = Date.now() + STEP_TIMEOUT_MS;
  while (!done()) {
    assert(
      Date.now() < limit,
      `${what} timed out (accelerator events: ${accelerators.join(",")})`,
    );
    windows.pump();
    checkCallbacks();
    if (view?.failure) {
      throw view.failure;
    }
    await Bun.sleep(5);
  }
}

/** Depth-first search for the first descendant window of the given class. */
function findDescendant(parent: bigint, className: string): bigint {
  const name = ptr(Buffer.from(`${className}\0`, "utf16le"));
  const direct = user.symbols.FindWindowExW(parent, 0n, name, null);
  if (direct) {
    return direct;
  }
  let child = user.symbols.FindWindowExW(parent, 0n, null, null);
  while (child) {
    const found = findDescendant(child, className);
    if (found) {
      return found;
    }
    child = user.symbols.FindWindowExW(parent, child, null, null);
  }
  return 0n;
}

try {
  hwnd = windows.create(
    caption,
    640,
    480,
    (message, wparam, lparam) => {
      for (const receive of [
        ...listeners,
      ]) {
        receive(message, wparam, lparam);
      }
    },
    true,
    {
      titlebar: "system",
    },
  );
  view = new WebView(
    hwnd,
    {
      view: "main",
      title: caption,
      home: "https://app.bunaway.local/index.html",
      window: {
        width: 640,
        height: 480,
        titlebar: "system",
      },
    },
    assets,
    resolve(output, `data-${crypto.randomUUID()}`),
    resolve(
      root,
      "build/cache/webview2/sdk/build/native/x64/WebView2Loader.dll",
    ),
    [
      "https://app.bunaway.local",
    ],
    {
      message(_source, raw) {
        if (JSON.parse(raw) === "loaded") {
          loaded = true;
        }
      },
      revoke() {},
      sameDocument() {},
      close() {
        throw new Error("Unexpected close before cleanup");
      },
      ready() {
        view?.navigate();
      },
      documentComplete() {},
      key(kind, virtualKey) {
        accelerators.push(`${kind}:${virtualKey}`);
        const message = webViewKeyMessage(kind);
        if (message !== undefined) {
          // The host defers the dispatch out of the COM callback the same way.
          setTimeout(() => {
            for (const receive of [
              ...listeners,
            ]) {
              receive(message, BigInt(virtualKey), 0n);
            }
          }, 0);
        }
      },
      log() {},
    },
  );
  const page = view;
  await pumpUntil(() => loaded, "Page load");

  const host: NativeMenuWindowHost = {
    current: () => "main",
    resolve: () => hwnd,
    subscribe(_id, receive) {
      listeners.add(receive);
      return () => listeners.delete(receive);
    },
    interrupt: () => () => {},
    changed() {
      page.resize();
    },
    executeRole() {},
  };
  menus = new WindowMenus(host);
  menus.set(
    "main",
    menuItemsSchema.parse([
      {
        id: "file",
        type: "submenu",
        label: "File",
        items: [
          {
            id: "open",
            type: "item",
            label: "Open",
          },
        ],
      },
    ]),
    () => {},
    () => {},
  );
  const tree = user.symbols.GetMenu(hwnd);
  assert(tree, "Menu bar was not attached");
  // Turning auto-hide on does not hide the bar by itself.
  menus.setAutoHide("main", true);
  assert.equal(user.symbols.GetMenu(hwnd), tree);
  page.moveFocusToContent();

  // Post the keys to the page's own window, as Windows delivers them while the page has focus.
  const target = findDescendant(hwnd, "Chrome_RenderWidgetHostHWND");
  assert(target, "The WebView render widget window was not found");
  const post = (message: number, virtualKey: number, scan: number) => {
    const up = message === WM_KEYUP || message === WM_SYSKEYUP;
    const system = message === WM_SYSKEYDOWN || message === WM_SYSKEYUP;
    const lparam =
      1 | (scan << 16) | (system ? 1 << 29 : 0) | (up ? 0xc0000000 : 0);
    assert(
      user.symbols.PostMessageW(
        target,
        message,
        BigInt(virtualKey),
        BigInt(lparam >>> 0),
      ),
      "PostMessageW failed",
    );
  };
  const tap = () => {
    post(WM_SYSKEYDOWN, VK_MENU, SCAN_MENU);
    post(WM_SYSKEYUP, VK_MENU, SCAN_MENU);
  };

  const linked = (expected: bigint) => () =>
    user.symbols.GetMenu(hwnd) === expected;

  // The bar is shown until the first Alt tap; each tap toggles it.
  step("first Alt tap");
  tap();
  await pumpUntil(linked(0n), "Alt tap hides");
  step("second Alt tap");
  tap();
  await pumpUntil(linked(tree), "Alt tap shows");

  // Alt used with another key is not a tap.
  step("Alt+F");
  const seen = accelerators.length;
  post(WM_SYSKEYDOWN, VK_MENU, SCAN_MENU);
  post(WM_SYSKEYDOWN, VK_F, SCAN_F);
  post(WM_SYSKEYUP, VK_F, SCAN_F);
  post(WM_SYSKEYUP, VK_MENU, SCAN_MENU);
  // The sequence has arrived once its accelerator events are recorded; the bar must still be
  // linked after the deferred dispatch has run.
  await pumpUntil(
    () => accelerators.length >= seen + 4,
    "Alt+F accelerator events",
  );
  await Bun.sleep(50);
  windows.pump();
  assert.equal(
    user.symbols.GetMenu(hwnd),
    tree,
    "Alt+F must not toggle the bar",
  );
  step("Alt tap after Alt+F");
  tap();
  await pumpUntil(linked(0n), "Alt tap after Alt+F hides");
  tap();
  await pumpUntil(linked(tree), "Alt tap shows again");
  step("Esc");
  post(WM_KEYDOWN, VK_ESCAPE, SCAN_ESCAPE);
  await pumpUntil(linked(0n), "Esc hides");
  verified = true;
} finally {
  menus?.dispose();
  if (view) {
    view.requestClose();
    const limit = Date.now() + deadline("nativeFixture");
    while (!view.detach()) {
      assert(Date.now() < limit, "Controller did not detach");
      windows.pump();
      await Bun.sleep(5);
    }
    windows.destroy(hwnd);
    hwnd = 0n;
    while (!view.finish()) {
      assert(Date.now() < limit, "Controller retained native resources");
      windows.pump();
      await Bun.sleep(5);
    }
  }
  if (hwnd) {
    windows.destroy(hwnd);
  }
  disposeHandlers(pending.filter((completion) => completion.refs === 1));
  disposeCom();
  windows.dispose();
  ole.symbols.CoUninitialize();
  disposeWin32Bindings();
}
clearTimeout(watchdog);
assert(verified);
console.log(
  "PASS an auto-hide window menu bar follows Alt taps and Esc delivered to the WebView2 page",
);
