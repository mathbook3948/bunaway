import { dlopen, JSCallback } from "bun:ffi";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { checkCallbacks, disposeCom } from "#native/windows/bun/com";
import { WebView } from "#native/windows/bun/webview";
import { Windows, WM_SIZE } from "#native/windows/bun/win32";
import {
  disposeWin32Bindings,
  hr,
  kernel,
  ole,
} from "#native/windows/bun/win32-bindings";

const WM_ACTIVATE = 0x0006;
const WM_SETFOCUS = 0x0007;
const WM_SHOWWINDOW = 0x0018;
const EVENT_SYSTEM_FOREGROUND = 0x0003;
const EVENT_OBJECT_SHOW = 0x8002;
const EVENT_OBJECT_FOCUS = 0x8005;
const GA_ROOT = 2;
const COINIT_APARTMENTTHREADED = 0x2;
const WINEVENT_OUTOFCONTEXT = 0;
const root = resolve(import.meta.dir, "../..");
const assets = resolve(root, "build/windows-hidden-webview/assets");
await mkdir(resolve(assets, "web"), {
  recursive: true,
});
await writeFile(
  resolve(assets, "web/index.html"),
  "<!doctype html><title>Hidden WebView2</title><input autofocus>",
);
hr(
  ole.symbols.CoInitializeEx(null, COINIT_APARTMENTTHREADED),
  "CoInitializeEx(STA)",
);
const windows = new Windows(() => {});
const driver = dlopen("user32.dll", {
  SetWinEventHook: {
    args: [
      "u32",
      "u32",
      "u64",
      "ptr",
      "u32",
      "u32",
      "u32",
    ],
    returns: "u64",
  },
  UnhookWinEvent: {
    args: [
      "u64",
    ],
    returns: "i32",
  },
  GetAncestor: {
    args: [
      "u64",
      "u32",
    ],
    returns: "u64",
  },
  GetFocus: {
    args: [],
    returns: "u64",
  },
  GetForegroundWindow: {
    args: [],
    returns: "u64",
  },
});
let hidden = 0n;
let source = 0n;
let webview: WebView | undefined;
let nativeMessages = 0;
const systemEventRoots = new Set<bigint>();
const callback = new JSCallback(
  (_hook, event, hwnd) => {
    if (
      Number(event) !== EVENT_OBJECT_SHOW &&
      Number(event) !== EVENT_OBJECT_FOCUS &&
      Number(event) !== EVENT_SYSTEM_FOREGROUND
    ) {
      return;
    }
    // WinEvents can arrive inside CreateWindowExW, before `hidden` receives its HWND.
    systemEventRoots.add(driver.symbols.GetAncestor(BigInt(hwnd), GA_ROOT));
  },
  {
    args: [
      "u64",
      "u32",
      "u64",
      "i32",
      "i32",
      "u32",
      "u32",
    ],
    returns: "void",
  },
);
let hook = 0n;
let configured = false;
let documentReady = false;
try {
  source = windows.create("Hidden preparation input", 640, 480, () => {});
  const focused = windows.focus(source);
  windows.pump();
  const keyboardFocus = driver.symbols.GetFocus();
  hook = driver.symbols.SetWinEventHook(
    EVENT_SYSTEM_FOREGROUND,
    EVENT_OBJECT_FOCUS,
    0n,
    callback.ptr,
    process.pid,
    kernel.symbols.GetCurrentThreadId(),
    WINEVENT_OUTOFCONTEXT,
  );
  assert(hook);
  hidden = windows.create(
    "Hidden preparation target",
    640,
    480,
    (message, wparam) => {
      if (
        (message === WM_SHOWWINDOW && wparam !== 0n) ||
        (message === WM_ACTIVATE && (wparam & 0xffffn) !== 0n) ||
        message === WM_SETFOCUS
      ) {
        nativeMessages++;
      }
      if (message === WM_SIZE) {
        webview?.resize();
      }
    },
    false,
  );
  webview = new WebView(
    hidden,
    {
      view: "hidden",
      title: "Hidden",
      home: "https://app.bunaway.local/index.html",
      window: {
        width: 640,
        height: 480,
      },
      visible: false,
    },
    assets,
    resolve(root, `build/windows-hidden-webview/data-${process.pid}`),
    resolve(
      root,
      "build/cache/webview2/sdk/build/native/x64/WebView2Loader.dll",
    ),
    [
      "https://app.bunaway.local",
    ],
    {
      message() {},
      revoke() {},
      sameDocument() {},
      close() {
        throw new Error("Unexpected close");
      },
      ready() {
        configured = true;
        webview?.navigate();
      },
      documentComplete(error) {
        assert.equal(error, null);
        documentReady = true;
      },
      log() {},
    },
  );
  const deadline = Date.now() + 30_000;
  while (!documentReady) {
    assert(Date.now() < deadline, "Hidden WebView2 timed out");
    windows.pump();
    checkCallbacks();
    assert.equal(windows.isVisible(hidden), false);
    assert.equal(windows.isFocused(hidden), false);
    assert.equal(driver.symbols.GetFocus(), keyboardFocus);
    assert.notEqual(driver.symbols.GetForegroundWindow(), hidden);
    await Bun.sleep(5);
  }
  for (let count = 0; count < 10; count++) {
    windows.pump();
    await Bun.sleep(5);
  }
  assert(configured);
  assert.equal(
    nativeMessages,
    0,
    "Hidden construction showed or activated the HWND",
  );
  assert.equal(
    systemEventRoots.has(hidden),
    false,
    "WinEvent observer saw a transient show or focus",
  );
  console.log(
    "PASS actual Win32 and WebView2 hidden creation: zero show/activation/focus messages or WinEvents, keyboard focus preserved",
    {
      focused,
    },
  );
} finally {
  assert(driver.symbols.UnhookWinEvent(hook));
  callback.close();
  if (webview) {
    webview.requestClose();
    const deadline = Date.now() + 35_000;
    while (!webview.detach()) {
      assert(Date.now() < deadline);
      windows.pump();
      await Bun.sleep(5);
    }
    windows.destroy(hidden);
    hidden = 0n;
    while (!webview.finish()) {
      assert(Date.now() < deadline);
      windows.pump();
      await Bun.sleep(5);
    }
  }
  if (hidden) {
    windows.destroy(hidden);
  }
  if (source) {
    windows.destroy(source);
  }
  for (let count = 0; count < 10; count++) {
    windows.pump();
    await Bun.sleep(5);
  }
  disposeCom();
  windows.dispose();
  driver.close();
  ole.symbols.CoUninitialize();
  disposeWin32Bindings();
}
