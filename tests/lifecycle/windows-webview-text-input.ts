import { dlopen, ptr } from "bun:ffi";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { checkHresult } from "@bunaway/plugin/win32";
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
import { deadline } from "../fixtures/deadlines.ts";

// Text typed as real keyboard input into the inputs of a real WebView2 page: SendInput with
// KEYEVENTF_UNICODE delivers Hangul syllables, a surrogate pair, a combining sequence and line
// breaks through the host window, and the page must see exactly the text that was sent in its
// beforeinput and input events and in the element value. The same text is typed under every
// keyboard layout installed on the machine, and a letter key must keep its physical code. IME
// composition is not synthesized, so the page must report no composition.
assert.equal(process.platform, "win32");
const root = resolve(import.meta.dir, "../..");
const output = resolve(root, "build/windows-webview-text-input");
const assets = resolve(output, "assets");
const caption = "Bunaway text input";
const STEP_TIMEOUT_MS = deadline("childStep");
// Time given to the page to report a typed text before the value is compared.
const TEXT_REPORT_POLL_MS = 25;
const VK_RETURN = 0x0d;
const VK_A = 0x41;
// SendInput structures: INPUT is 40 bytes; the mouse and keyboard members start at offset 8.
const INPUT_SIZE = 40;
const INPUT_MOUSE = 0;
const INPUT_KEYBOARD = 1;
const MOUSEEVENTF_MOVE = 0x0001;
const MOUSEEVENTF_LEFTDOWN = 0x0002;
const MOUSEEVENTF_LEFTUP = 0x0004;
const MOUSEEVENTF_ABSOLUTE = 0x8000;
const KEYEVENTF_KEYUP = 0x0002;
const KEYEVENTF_UNICODE = 0x0004;
const ABSOLUTE_COORDINATE_RANGE = 65535;
const SM_CXSCREEN = 0;
const SM_CYSCREEN = 1;
const GA_ROOT = 2;
const HWND_TOPMOST = -1n;
const HWND_NOTOPMOST = -2n;
const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOACTIVATE = 0x0010;
// Wait after moving the pointer so the browser sees a hover target before the click.
const POINTER_SETTLE_MS = 150;
const CLICK_ATTEMPTS = 3;
const LANGUAGE_ENGLISH_US = 0x0409;

const user = dlopen("user32.dll", {
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
  GetKeyboardLayout: {
    args: [
      "u32",
    ],
    returns: "u64",
  },
  GetKeyboardLayoutList: {
    args: [
      "i32",
      "ptr",
    ],
    returns: "i32",
  },
  ActivateKeyboardLayout: {
    args: [
      "u64",
      "u32",
    ],
    returns: "u64",
  },
});

await mkdir(resolve(assets, "web"), {
  recursive: true,
});
// The page records every key and input event of both elements and answers a report command with
// the element value, the focused element and the recorded events. A reset command clears an
// element and focuses it.
await writeFile(
  resolve(assets, "web/index.html"),
  `<!doctype html><title>Text input</title>
  <input id="a"><textarea id="b"></textarea>
  <script>
    const post = (message) => chrome.webview.postMessage(message);
    let events = [];
    for (const id of ["a", "b"]) {
      const element = document.getElementById(id);
      for (const type of ["beforeinput", "input"]) {
        element.addEventListener(type, (event) => {
          events.push({
            id,
            type,
            inputType: event.inputType,
            data: event.data,
            composing: event.isComposing,
          });
        });
      }
      for (const type of ["compositionstart", "compositionupdate", "compositionend"]) {
        element.addEventListener(type, () => events.push({ id, type, composing: true }));
      }
      element.addEventListener("keydown", (event) => {
        events.push({ id, type: "keydown", key: event.key, code: event.code });
      });
    }
    chrome.webview.addEventListener("message", (message) => {
      const command = message.data;
      if (command.cmd === "reset") {
        const element = document.getElementById(command.target);
        element.value = "";
        events = [];
        element.focus();
        post({ reset: command.seq });
      } else if (command.cmd === "report") {
        const active = document.activeElement;
        post({
          seq: command.seq,
          focus: (document.hasFocus() ? "focused:" : "unfocused:") + (active ? active.id : "none"),
          value: document.getElementById(command.target).value,
          events,
        });
      }
    });
    addEventListener("DOMContentLoaded", () => post("loaded"));
  </script>`,
);

interface PageEvent {
  id: string;
  type: string;
  inputType?: string;
  data?: string | null;
  composing?: boolean;
  key?: string;
  code?: string;
}
interface Report {
  seq: number;
  focus: string;
  value: string;
  events: PageEvent[];
}

checkHresult(ole.symbols.CoInitializeEx(null, 2), "CoInitializeEx(STA)");
const windows = new Windows(() => {});
const pending: ComHandler[] = [];
let hwnd = 0n;
let view: WebView | undefined;
let loaded = false;
let verified = false;
let sequence = 0;
let resetSeen = 0;
let latest: Report | undefined;
const originalLayout = user.symbols.GetKeyboardLayout(0);
let layoutChanged = false;
const step = (name: string) => console.log(`STEP ${name}`);
// Fails when the fixture outlives its deadline while the event loop still runs.
const watchdog = setTimeout(() => {
  console.error("text input fixture exceeded its deadline");
  process.exit(1);
}, deadline("nativeFixture"));

/** Pump the UI thread until the condition holds, failing at the step deadline. */
async function pumpUntil(done: () => boolean, what: string): Promise<void> {
  const limit = Date.now() + STEP_TIMEOUT_MS;
  while (!done()) {
    assert(Date.now() < limit, `${what} timed out`);
    windows.pump();
    checkCallbacks();
    if (view?.failure) {
      throw view.failure;
    }
    await Bun.sleep(5);
  }
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

/** One keyboard input record: a virtual key, or a UTF-16 code unit sent as a Unicode packet. */
interface KeyRecord {
  virtualKey: number;
  scan: number;
  flags: number;
}

/**
 * Press and release a sequence of keys in one SendInput call. A line break is the Enter key,
 * because a Unicode packet for U+000A is not an Enter key press; every other UTF-16 code unit is
 * a Unicode packet, so a surrogate pair is two packets as a real Unicode source sends it.
 */
function sendText(text: string): void {
  const records: KeyRecord[] = [];
  const pair = (virtualKey: number, scan: number, flags: number) => {
    records.push({
      virtualKey,
      scan,
      flags,
    });
    records.push({
      virtualKey,
      scan,
      flags: flags | KEYEVENTF_KEYUP,
    });
  };
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    if (unit === 0x0a) {
      pair(VK_RETURN, 0, 0);
    } else {
      pair(0, unit, KEYEVENTF_UNICODE);
    }
  }
  const events = Buffer.alloc(INPUT_SIZE * records.length);
  records.forEach((record, index) => {
    const base = INPUT_SIZE * index;
    events.writeUInt32LE(INPUT_KEYBOARD, base);
    events.writeUInt16LE(record.virtualKey, base + 8);
    events.writeUInt16LE(record.scan, base + 10);
    events.writeUInt32LE(record.flags, base + 12);
  });
  assert.equal(
    user.symbols.SendInput(records.length, ptr(events), INPUT_SIZE),
    records.length,
    "SendInput rejected the text",
  );
}

/** Press and release one virtual key as real keyboard input. */
function pressKey(virtualKey: number): void {
  const events = Buffer.alloc(INPUT_SIZE * 2);
  [
    0,
    KEYEVENTF_KEYUP,
  ].forEach((flags, index) => {
    events.writeUInt32LE(INPUT_KEYBOARD, INPUT_SIZE * index);
    events.writeUInt16LE(virtualKey, INPUT_SIZE * index + 8);
    events.writeUInt32LE(flags, INPUT_SIZE * index + 12);
  });
  assert.equal(user.symbols.SendInput(2, ptr(events), INPUT_SIZE), 2);
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
function rootAtPoint(x: number, y: number): bigint {
  const point = (BigInt(y) << 32n) | (BigInt(x) & 0xffff_ffffn);
  const hit = user.symbols.WindowFromPoint(BigInt.asIntN(64, point));
  return hit === 0n ? 0n : user.symbols.GetAncestor(hit, GA_ROOT);
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
      assert.equal(
        rootAtPoint(screenX, screenY),
        window,
        "Another window covers the click point",
      );
      sendMouse(screenX, screenY, [
        MOUSEEVENTF_LEFTDOWN,
        MOUSEEVENTF_LEFTUP,
      ]);
      const limit = Date.now() + STEP_TIMEOUT_MS;
      while (
        user.symbols.GetForegroundWindow() !== window &&
        Date.now() < limit
      ) {
        windows.pump();
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

/** Clear one element in the page and focus it. */
async function reset(target: "a" | "b"): Promise<void> {
  const seq = ++sequence;
  view?.send(
    JSON.stringify({
      cmd: "reset",
      target,
      seq,
    }),
  );
  await pumpUntil(() => resetSeen === seq, `Page reset of ${target}`);
}

/** Ask the page for the element value and recorded events once. */
async function report(target: "a" | "b"): Promise<Report> {
  const seq = ++sequence;
  view?.send(
    JSON.stringify({
      cmd: "report",
      target,
      seq,
    }),
  );
  await pumpUntil(() => latest?.seq === seq, `Page report of ${target}`);
  assert(latest);
  return latest;
}

/**
 * Ask the page again until the element holds the expected text or the step deadline passes, then
 * return the last report so a mismatch shows what the page really had.
 */
async function reportValue(
  target: "a" | "b",
  expected: string,
): Promise<Report> {
  const limit = Date.now() + STEP_TIMEOUT_MS;
  let current = await report(target);
  while (current.value !== expected && Date.now() < limit) {
    await settle(TEXT_REPORT_POLL_MS);
    current = await report(target);
  }
  return current;
}

/** The text that the beforeinput and input events of one type carried, in order. */
function insertedText(events: PageEvent[], type: string): string {
  return events
    .filter((event) => event.type === type && event.inputType === "insertText")
    .map((event) => event.data ?? "")
    .join("");
}

/** Type a text into one element and check the value and the events the page saw. */
async function checkText(
  layout: string,
  target: "a" | "b",
  label: string,
  text: string,
): Promise<void> {
  await reset(target);
  sendText(text);
  const reported = await reportValue(target, text);
  const where = `${label} under layout ${layout} in ${target}`;
  assert.equal(reported.value, text, `Value of ${where}`);
  // The value is compared as sent, so the page did not normalize the text; the events carry the
  // same characters, split into any number of insertText events.
  const plain = text.replaceAll("\n", "");
  assert.equal(
    insertedText(reported.events, "beforeinput"),
    plain,
    `beforeinput data of ${where}`,
  );
  assert.equal(
    insertedText(reported.events, "input"),
    plain,
    `input data of ${where}`,
  );
  assert.equal(
    reported.events.filter((event) => event.type === "input" && event.composing)
      .length,
    0,
    `No composition input in ${where}`,
  );
  assert(
    !reported.events.some((event) => event.type.startsWith("composition")),
    `No composition events in ${where}`,
  );
  assert.equal(
    reported.focus,
    `focused:${target}`,
    `Page focus after ${where}`,
  );
  assert.equal(
    user.symbols.GetForegroundWindow(),
    hwnd,
    `Host foreground after ${where}`,
  );
  console.log(`Typed ${where}: ${JSON.stringify(text)}`);
}

/** Keyboard layouts installed for the current user, the active one first. */
function installedLayouts(): bigint[] {
  const count = user.symbols.GetKeyboardLayoutList(0, null);
  const list = new BigUint64Array(Math.max(count, 1));
  const filled = user.symbols.GetKeyboardLayoutList(count, ptr(list));
  const all = Array.from(list.slice(0, filled));
  return [
    originalLayout,
    ...all.filter((layout) => layout !== originalLayout),
  ];
}

const layoutName = (layout: bigint) =>
  `0x${(layout & 0xffff_ffffn).toString(16).padStart(8, "0")}`;

try {
  hwnd = windows.create(caption, 640, 480, () => {}, true, {
    titlebar: "system",
  });
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
          if (typeof parsed.reset === "number") {
            resetSeen = parsed.reset;
          } else if (typeof parsed.seq === "number") {
            latest = parsed as unknown as Report;
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
      key() {},
      log() {},
    },
  );
  const page = view;
  await pumpUntil(() => loaded, "Page load");

  // Real input needs the window in the foreground with the page focused.
  step("activate");
  await activateByClick(hwnd);
  page.moveFocusToContent();
  await reset("a");

  const layouts = installedLayouts();
  console.log(
    `Installed keyboard layouts: ${JSON.stringify(layouts.map(layoutName))}`,
  );
  if (layouts.length < 2) {
    console.log(
      "Only one keyboard layout is installed; the layout switch is not exercised",
    );
  }
  for (const layout of layouts) {
    const name = layoutName(layout);
    step(`layout ${name}`);
    if (layout !== user.symbols.GetKeyboardLayout(0)) {
      assert(
        user.symbols.ActivateKeyboardLayout(layout, 0) !== 0n,
        `ActivateKeyboardLayout(${name}) failed`,
      );
      layoutChanged = true;
    }
    assert.equal(
      user.symbols.GetKeyboardLayout(0),
      layout,
      "The thread input layout did not change",
    );
    await checkText(name, "a", "Hangul", "한글 입력 테스트");
    await checkText(name, "a", "Emoji", "a😀b👨‍👩‍👧c");
    await checkText(name, "a", "Combining sequence", "café ñ");
    await checkText(name, "b", "Lines", "첫째 줄\n둘째 줄 😀\né\n");

    // A letter key keeps its physical code under any layout; its character is the layout's.
    await reset("a");
    pressKey(VK_A);
    const limit = Date.now() + STEP_TIMEOUT_MS;
    let letter = await report("a");
    while (
      !letter.events.some((event) => event.type === "keydown") &&
      Date.now() < limit
    ) {
      await settle(TEXT_REPORT_POLL_MS);
      letter = await report("a");
    }
    const keyEvents = letter.events.filter((event) => event.type === "keydown");
    assert.equal(keyEvents.length, 1, `One keydown under layout ${name}`);
    assert.equal(keyEvents[0]?.code, "KeyA", `Key code under layout ${name}`);
    assert((keyEvents[0]?.key ?? "").length > 0, "The key has a value");
    if ((layout & 0xffffn) === BigInt(LANGUAGE_ENGLISH_US)) {
      assert.equal(keyEvents[0]?.key, "a");
      assert.equal(letter.value, "a");
    }
  }
  verified = true;
} finally {
  if (layoutChanged) {
    user.symbols.ActivateKeyboardLayout(originalLayout, 0);
  }
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
  "PASS Unicode text typed with SendInput reaches WebView2 inputs unchanged under every installed keyboard layout",
);
