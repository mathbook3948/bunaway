import { dlopen, ptr } from "bun:ffi";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { checkHresult, pick, USER32 } from "@bunaway/plugin/win32";
import type { NativeMenuWindowHost } from "@bunaway/plugin-api/native";
import { isRecord } from "@bunaway/protocol";
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
// The keys are real input (SendInput) after a real click activated the window, because messages
// posted to the browser's widget window do not raise the accelerator event.
assert.equal(process.platform, "win32");
const root = resolve(import.meta.dir, "../..");
const output = resolve(root, "build/windows-menu-auto-hide");
const assets = resolve(output, "assets");
const caption = "Bunaway menu auto-hide";
// GUITHREADINFO is 72 bytes on 64-bit Windows; hwndFocus follows flags, hwndActive.
const GUI_THREAD_INFO_SIZE = 72;
const GUI_THREAD_INFO_FOCUS_OFFSET = 16;
// Time given to the page and the controller to report one real key.
const KEY_REPORT_SETTLE_MS = 750;
const STEP_TIMEOUT_MS = deadline("childStep");
const WM_TIMER = 0x0113;
const WM_ENTERMENULOOP = 0x0211;
const WM_EXITMENULOOP = 0x0212;
const END_MENU_TIMER = 0xb171n;
const VK_MENU = 0x12;
const VK_ESCAPE = 0x1b;
const VK_F = 0x46;
// SendInput structures: INPUT is 40 bytes; the mouse and keyboard members start at offset 8.
const INPUT_SIZE = 40;
const INPUT_MOUSE = 0;
const INPUT_KEYBOARD = 1;
const MOUSEEVENTF_MOVE = 0x0001;
const MOUSEEVENTF_LEFTDOWN = 0x0002;
const MOUSEEVENTF_LEFTUP = 0x0004;
const MOUSEEVENTF_ABSOLUTE = 0x8000;
const KEYEVENTF_KEYUP = 0x0002;
const ABSOLUTE_COORDINATE_RANGE = 65535;
const SM_CXSCREEN = 0;
const SM_CYSCREEN = 1;
const GA_ROOT = 2;
const CLASS_NAME_CHARS = 256;
const HWND_TOPMOST = -1n;
const HWND_NOTOPMOST = -2n;
const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOACTIVATE = 0x0010;
// Wait after moving the pointer so the browser sees a hover target before the click.
const POINTER_SETTLE_MS = 150;
const CLICK_ATTEMPTS = 3;

const user = dlopen("user32.dll", {
  GetMenu: {
    args: [
      "u64",
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
  GetForegroundWindow: {
    args: [],
    returns: "u64",
  },
  // POINT is passed by value as one 64-bit register: x in the low half, y in the high half.
  WindowFromPoint: {
    args: [
      "i64",
    ],
    returns: "u64",
  },
  GetAncestor: {
    args: [
      "u64",
      "u32",
    ],
    returns: "u64",
  },
  GetClassNameW: {
    args: [
      "u64",
      "ptr",
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
  ...pick(USER32, "SetTimer", "KillTimer"),
  GetGUIThreadInfo: {
    args: [
      "u32",
      "ptr",
    ],
    returns: "i32",
  },
  IsChild: {
    args: [
      "u64",
      "u64",
    ],
    returns: "i32",
  },
  EndMenu: {
    args: [],
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
    // The page reports whether it has focus and which element holds it, on every change and key.
    const focusState = () =>
      (document.hasFocus() ? "focused:" : "unfocused:") +
      (document.activeElement ? document.activeElement.tagName : "none");
    let lastFocusState = "";
    const reportFocus = () => {
      const state = focusState();
      if (state !== lastFocusState) {
        lastFocusState = state;
        chrome.webview.postMessage({ focus: state });
      }
    };
    setInterval(reportFocus, 20);
    addEventListener("focus", reportFocus);
    addEventListener("blur", reportFocus);
    addEventListener("keydown", (event) => {
      chrome.webview.postMessage({ keydown: event.key, focus: focusState() });
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
// Keys the page itself received, to tell a key that never reached the page from one the
// controller did not report.
const pageKeys: string[] = [];
// Latest focus state the page reported: whether the document has focus and its active element.
let pageFocus = "none reported";
// Every focus state the page reported and every fixture action, in order with the time since the
// fixture started, to show whether the page ever had focus and when it lost it.
const focusTimeline: string[] = [];
const startedAt = Date.now();
const markTimeline = (event: string) =>
  focusTimeline.push(`${Date.now() - startedAt}ms ${event}`);
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

/**
 * Window that holds keyboard focus in the given thread's input state (0 means the foreground
 * thread), for diagnostics.
 */
function focusWindow(thread = 0): bigint {
  const info = new DataView(new ArrayBuffer(GUI_THREAD_INFO_SIZE));
  info.setUint32(0, GUI_THREAD_INFO_SIZE, true);
  if (!user.symbols.GetGUIThreadInfo(thread, ptr(info.buffer))) {
    return 0n;
  }
  return info.getBigUint64(GUI_THREAD_INFO_FOCUS_OFFSET, true);
}

/** Log which window has focus and which keys the controller and the page have seen. */
function logInputState(label: string): void {
  const focus = focusWindow();
  console.log(
    `Input state ${label}: ${JSON.stringify({
      focusClass: focus === 0n ? "none" : className(focus),
      focusIsHost: focus === hwnd,
      focusInsideHost: focus !== 0n && user.symbols.IsChild(hwnd, focus) !== 0,
      foregroundIsHost: user.symbols.GetForegroundWindow() === hwnd,
      accelerators,
      pageKeys,
      pageFocus,
    })}`,
  );
}

/** Pump the UI thread for a fixed time so late callbacks and page messages arrive. */
async function settle(milliseconds: number): Promise<void> {
  const end = Date.now() + milliseconds;
  while (Date.now() < end) {
    windows.pump();
    checkCallbacks();
    await Bun.sleep(5);
  }
}

/** Class name of a window, for diagnostics. */
function className(window: bigint): string {
  const name = Buffer.alloc(CLASS_NAME_CHARS * 2);
  const length = user.symbols.GetClassNameW(
    window,
    ptr(name),
    CLASS_NAME_CHARS,
  );
  return name.toString("utf16le", 0, length * 2);
}

/** Send absolute mouse events at a physical screen point. */
function sendMouse(screenX: number, screenY: number, flags: number[]): void {
  const width = user.symbols.GetSystemMetrics(SM_CXSCREEN);
  const height = user.symbols.GetSystemMetrics(SM_CYSCREEN);
  const events = Buffer.alloc(INPUT_SIZE * flags.length);
  flags.forEach((flag, index) => {
    const base = INPUT_SIZE * index;
    events.writeUInt32LE(INPUT_MOUSE, base);
    events.writeInt32LE(
      Math.round((screenX * ABSOLUTE_COORDINATE_RANGE) / (width - 1)),
      base + 8,
    );
    events.writeInt32LE(
      Math.round((screenY * ABSOLUTE_COORDINATE_RANGE) / (height - 1)),
      base + 12,
    );
    events.writeUInt32LE(flag, base + 20);
  });
  assert.equal(
    user.symbols.SendInput(flags.length, ptr(events), INPUT_SIZE),
    flags.length,
  );
}

/** Whether the fixture pressed Alt and has not released it yet. */
let altHeld = false;

/**
 * Press or release one virtual key as real keyboard input. Returns whether Windows accepted the
 * event; a rejected event leaves the Alt state unchanged.
 */
function trySendKey(virtualKey: number, up: boolean): boolean {
  const event = Buffer.alloc(INPUT_SIZE);
  event.writeUInt32LE(INPUT_KEYBOARD, 0);
  event.writeUInt16LE(virtualKey, 8);
  event.writeUInt32LE(up ? KEYEVENTF_KEYUP : 0, 12);
  const sent = user.symbols.SendInput(1, ptr(event), INPUT_SIZE) === 1;
  if (sent && virtualKey === VK_MENU) {
    altHeld = !up;
  }
  return sent;
}

/** Press or release one virtual key, failing the test when Windows rejects the input. */
function sendKey(virtualKey: number, up: boolean): void {
  assert(trySendKey(virtualKey, up), "SendInput rejected a key event");
}

/** Move the test window above other windows, or back, without activating it. */
function setTopmost(window: bigint, topmost: boolean): void {
  assert(
    user.symbols.SetWindowPos(
      window,
      topmost ? HWND_TOPMOST : HWND_NOTOPMOST,
      0,
      0,
      0,
      0,
      SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE,
    ) !== 0,
    "SetWindowPos failed",
  );
}

/** Top-level window under a screen point. */
function rootAtPoint(
  x: number,
  y: number,
): {
  hit: bigint;
  root: bigint;
} {
  const point = (BigInt(y) << 32n) | (BigInt(x) & 0xffff_ffffn);
  const hit = user.symbols.WindowFromPoint(BigInt.asIntN(64, point));
  return {
    hit,
    root: hit === 0n ? 0n : user.symbols.GetAncestor(hit, GA_ROOT),
  };
}

/**
 * Click the middle of the window's client area, which is the WebView, until the window is the
 * foreground window. A real click is always accepted by the foreground lock and gives the page
 * keyboard focus, as a user's click would.
 */
async function activateByClick(window: bigint): Promise<void> {
  const clientRect = new Int32Array(4);
  assert(user.symbols.GetClientRect(window, ptr(clientRect)));
  const [, , clientWidth = 0, clientHeight = 0] = clientRect;
  const center = new Int32Array([
    Math.floor(clientWidth / 2),
    Math.floor(clientHeight / 2),
  ]);
  assert(user.symbols.ClientToScreen(window, ptr(center)));
  const [screenX = 0, screenY = 0] = center;
  setTopmost(window, true);
  try {
    for (let attempt = 1; attempt <= CLICK_ATTEMPTS; attempt++) {
      sendMouse(screenX, screenY, [
        MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE,
      ]);
      await Bun.sleep(POINTER_SETTLE_MS);
      const under = rootAtPoint(screenX, screenY);
      console.log(
        `Input diagnostics: ${JSON.stringify({
          attempt,
          underClass: className(under.hit),
          underIsTarget: under.root === window,
          foregroundIsTarget: user.symbols.GetForegroundWindow() === window,
        })}`,
      );
      assert.equal(under.root, window, "Another window covers the click point");
      sendMouse(screenX, screenY, [
        MOUSEEVENTF_LEFTDOWN,
        MOUSEEVENTF_LEFTUP,
      ]);
      const limit = Date.now() + deadline("childStep");
      while (
        user.symbols.GetForegroundWindow() !== window &&
        Date.now() < limit
      ) {
        windows.pump();
        // Page reports that arrive during the click are timed when they arrive, not afterwards.
        checkCallbacks();
        await Bun.sleep(10);
      }
      const activated = user.symbols.GetForegroundWindow() === window;
      console.log(
        `Input diagnostics after click: ${JSON.stringify({
          attempt,
          foregroundIsTarget: activated,
        })}`,
      );
      if (activated) {
        return;
      }
    }
    assert.fail("A click never made the test window the foreground window");
  } finally {
    setTopmost(window, false);
  }
}

try {
  hwnd = windows.create(
    caption,
    640,
    480,
    (message, wparam, lparam) => {
      // An Alt key up that reaches the frame makes Windows enter keyboard menu mode, a modal loop
      // that would stop this fixture's pump. The fixture ends the loop itself, retrying EndMenu from
      // a timer because it is ignored before tracking starts, and does not pass the loop messages to
      // the menu code (Windows still runs its default handling). The loop only opens while the bar
      // is linked; the menu code's own handling of the loop end is covered by the frame test.
      if (message === WM_ENTERMENULOOP) {
        assert(
          user.symbols.SetTimer(hwnd, END_MENU_TIMER, 20, null),
          "SetTimer failed",
        );
        return;
      }
      if (message === WM_EXITMENULOOP) {
        user.symbols.KillTimer(hwnd, END_MENU_TIMER);
        return;
      }
      if (message === WM_TIMER && wparam === END_MENU_TIMER) {
        user.symbols.EndMenu();
        return;
      }
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
        const parsed: unknown = JSON.parse(raw);
        if (parsed === "loaded") {
          loaded = true;
        } else if (isRecord(parsed)) {
          if (typeof parsed.focus === "string") {
            pageFocus = parsed.focus;
          }
          if (typeof parsed.keydown === "string") {
            pageKeys.push(parsed.keydown);
            markTimeline(`page keydown ${parsed.keydown} (${pageFocus})`);
          } else if (typeof parsed.focus === "string") {
            markTimeline(`page ${parsed.focus}`);
          }
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
      log(event, data) {
        // Registration and delivery of the controller accelerator event, for the key diagnosis.
        if (event.startsWith("webview-accelerator")) {
          console.log(`Host log ${event}: ${JSON.stringify(data)}`);
        }
      },
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

  // Real input needs the window in the foreground with the page focused.
  step("activate");
  markTimeline("click start");
  await activateByClick(hwnd);
  markTimeline("click done");
  await settle(KEY_REPORT_SETTLE_MS);
  logInputState("after the click");
  // The click normally focuses the page; asking again makes the key target certain. The result
  // is logged because a rejected move would leave the page without focus.
  try {
    page.moveFocusToContent();
    markTimeline("MoveFocus returned S_OK");
    console.log("MoveFocus result: S_OK");
  } catch (error) {
    markTimeline("MoveFocus failed");
    console.log(`MoveFocus result: ${String(error)}`);
  }
  await settle(KEY_REPORT_SETTLE_MS);
  logInputState("after MoveFocus");
  const tap = () => {
    sendKey(VK_MENU, false);
    sendKey(VK_MENU, true);
  };
  const press = (virtualKey: number) => {
    sendKey(virtualKey, false);
    sendKey(virtualKey, true);
  };
  // A plain key must raise the controller's accelerator event, or the Alt checks below cannot work.
  step("accelerator probe");
  // The key is sent only once the page reports focus on its input, so a missing key report cannot
  // be a page without focus.
  await pumpUntil(
    () => pageFocus === "focused:INPUT",
    "Page focus on the input",
  );
  logInputState("before probe key");
  markTimeline("probe key F");
  press(VK_F);
  // Report what both the page and the controller saw before judging, so a failure says whether
  // the key never reached the page or only the controller event is missing.
  await settle(KEY_REPORT_SETTLE_MS);
  logInputState("after probe key");
  await pumpUntil(
    () => accelerators.length > 0,
    "Controller accelerator event for a real key",
  );
  windows.pump();
  assert.equal(
    user.symbols.GetMenu(hwnd),
    tree,
    "A plain key must not toggle the bar",
  );

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
  sendKey(VK_MENU, false);
  sendKey(VK_F, false);
  sendKey(VK_F, true);
  sendKey(VK_MENU, true);
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
  press(VK_ESCAPE);
  await pumpUntil(linked(0n), "Esc hides");
  verified = true;
} finally {
  // Printed on every path, so a failure before the probe key still shows what the page reported.
  console.log(`Page focus timeline: ${JSON.stringify(focusTimeline)}`);
  // A failure between the Alt press and release must not leave Alt held for the rest of the
  // session. A rejected release is ignored so the cleanup below still runs.
  if (altHeld) {
    trySendKey(VK_MENU, true);
  }
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
  "PASS an auto-hide window menu bar follows Alt taps and Esc typed into the WebView2 page",
);
