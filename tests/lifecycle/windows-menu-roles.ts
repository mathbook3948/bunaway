import { dlopen, ptr, read, toArrayBuffer } from "bun:ffi";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  NativeMenuItem,
  NativeMenuRole,
  NativeMenuWindowHost,
} from "@bunaway/plugin-api/native";
import {
  type ComHandler,
  checkCallbacks,
  disposeCom,
  disposeHandlers,
} from "#native/windows/bun/com";
import { WebView } from "#native/windows/bun/webview";
import { callDevToolsProtocolMethod } from "#native/windows/bun/webview-devtools";
import { Windows } from "#native/windows/bun/win32";
import {
  disposeWin32Bindings,
  hr,
  ole,
} from "#native/windows/bun/win32-bindings";
import { menuItemsSchema } from "#plugins/menu/src/contract";
import { WindowMenus } from "#plugins/menu/src/platforms/windows-window-menus";

// Menu roles end to end in a real WebView2 window: a menu-bar or popup selection reaches
// WindowMenus, the host runs the editing command with execCommand through the DevTools protocol
// and the page's textarea, the clipboard and the undo stack change. The page blocks keydown, so
// a key-event route would fail. Roles never become app selections. Paste and same-origin iframe
// outcomes are logged as MENU_ROLE_DIRECT_SPIKE lines and not asserted.
assert.equal(process.platform, "win32");
const root = resolve(import.meta.dir, "../..");
const output = resolve(root, "build/windows-menu-roles");
const assets = resolve(output, "assets");
const caption = "Bunaway menu roles";
const CF_UNICODETEXT = 13;
const STEP_TIMEOUT_MS = 15_000;
// Time a role command gets to finish before its effect is observed for the diagnostic log.
const CASCADE_SETTLE_MS = 250;
const POLL_MS = 25;
const CLIPBOARD_ATTEMPTS = 20;
const WM_MENUCOMMAND = 0x0126;
const WM_KEYDOWN = 0x0100;
const WM_TIMER = 0x0113;
const VK_RETURN = 0x0d;
const VK_DOWN = 0x28;
const MF_BYPOSITION = 0x0400;
// The popup is driven by keys posted from its cancellation poll timer (50 ms): Down, then Return.
const POPUP_KEY_TICKS = {
  down: 1,
  enter: 3,
  giveUp: 40,
} as const;
const SEED = "hello world";
const ROLES: readonly NativeMenuRole[] = [
  "undo",
  "redo",
  "cut",
  "copy",
  "paste",
  "selectAll",
];

const user = dlopen("user32.dll", {
  OpenClipboard: {
    args: [
      "u64",
    ],
    returns: "i32",
  },
  CloseClipboard: {
    args: [],
    returns: "i32",
  },
  EmptyClipboard: {
    args: [],
    returns: "i32",
  },
  GetClipboardData: {
    args: [
      "u32",
    ],
    returns: "ptr",
  },
  SendMessageW: {
    args: [
      "u64",
      "u32",
      "u64",
      "u64",
    ],
    returns: "i64",
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
  GetMenu: {
    args: [
      "u64",
    ],
    returns: "u64",
  },
  GetSubMenu: {
    args: [
      "u64",
      "i32",
    ],
    returns: "u64",
  },
  GetMenuStringW: {
    args: [
      "u64",
      "u32",
      "ptr",
      "i32",
      "u32",
    ],
    returns: "i32",
  },
});
const memory = dlopen("kernel32.dll", {
  GlobalLock: {
    args: [
      "ptr",
    ],
    returns: "ptr",
  },
  GlobalUnlock: {
    args: [
      "ptr",
    ],
    returns: "i32",
  },
});

/** Read CF_UNICODETEXT, retrying while another process holds the clipboard. */
async function readClipboard(owner: bigint): Promise<string | null> {
  for (let attempt = 0; attempt < CLIPBOARD_ATTEMPTS; attempt++) {
    if (user.symbols.OpenClipboard(owner)) {
      try {
        const handle = user.symbols.GetClipboardData(CF_UNICODETEXT);
        const address = handle && memory.symbols.GlobalLock(handle);
        if (!handle || !address) {
          return null;
        }
        try {
          let bytes = 0;
          while (read.u16(address, bytes)) {
            bytes += 2;
          }
          return Buffer.from(toArrayBuffer(address, 0, bytes)).toString(
            "utf16le",
          );
        } finally {
          memory.symbols.GlobalUnlock(handle);
        }
      } finally {
        user.symbols.CloseClipboard();
      }
    }
    await Bun.sleep(POLL_MS);
  }
  return null;
}

function clearClipboard(owner: bigint): void {
  assert(user.symbols.OpenClipboard(owner), "Clipboard is unavailable");
  user.symbols.EmptyClipboard();
  user.symbols.CloseClipboard();
}

/**
 * Test page: a top textarea and a same-origin srcdoc iframe with its own textarea. Capture-phase
 * listeners on both windows count the events a page could use to block an editing command.
 * The keydown listener also calls preventDefault, so any command routed through a key event
 * would be suppressed and show up as a non-zero keydown count.
 */
function pageHtml(): string {
  const attribute = (html: string) =>
    html.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
  const frameHtml = (id: string) =>
    attribute(
      `<!doctype html><textarea id="${id}" rows="4" cols="40"></textarea>`,
    );
  // `f` shares the page origin; `x` is sandboxed without allow-same-origin, so its document is
  // cross-origin to the page and `contentDocument` is null.
  return `<!doctype html><title>Menu roles</title>
  <textarea id="a" rows="4" cols="40"></textarea>
  <iframe id="f" srcdoc="${frameHtml("b")}"></iframe>
  <iframe id="x" sandbox srcdoc="${frameHtml("c")}"></iframe>
  <script>
    window.counts = { keydown: 0, beforeinput: 0, copy: 0, cut: 0, paste: 0, selectstart: 0 };
    window.inputTypes = [];
    const watch = (target) => {
      for (const type of Object.keys(window.counts)) {
        target.addEventListener(type, (event) => {
          window.counts[type]++;
          if (type === "beforeinput") {
            window.inputTypes.push(event.inputType);
          }
          if (type === "keydown") {
            event.preventDefault();
          }
        }, true);
      }
    };
    watch(window);
    // The srcdoc document replaces the initial about:blank window, so listeners attach to the
    // loaded one; the page reports ready only once that document has its textarea.
    const frame = document.getElementById("f");
    let watched = false;
    const attachFrame = () => {
      if (!watched && frame.contentDocument?.getElementById("b")) {
        watched = true;
        watch(frame.contentWindow);
        chrome.webview.postMessage("loaded");
      }
    };
    frame.addEventListener("load", attachFrame);
    addEventListener("load", attachFrame);
  </script>`;
}

function menuText(menu: bigint, position: number): string {
  const buffer = Buffer.alloc(256);
  const length = user.symbols.GetMenuStringW(
    menu,
    position,
    ptr(buffer),
    buffer.length / 2,
    MF_BYPOSITION,
  );
  return buffer.subarray(0, length * 2).toString("utf16le");
}

await mkdir(resolve(assets, "web"), {
  recursive: true,
});
await writeFile(resolve(assets, "web/index.html"), pageHtml());
hr(ole.symbols.CoInitializeEx(null, 2), "CoInitializeEx(STA)");
const windows = new Windows(() => {});

const listeners = new Set<
  (message: number, wparam: bigint, lparam: bigint) => void
>();
const executed: NativeMenuRole[] = [];
const failures: string[] = [];
const skips: string[] = [];
const selections: string[] = [];
const pending: ComHandler[] = [];
let hwnd = 0n;
let view: WebView | undefined;
let menus: WindowMenus | undefined;
let loaded = false;
let verified = false;

/** Pump the STA until `done`, surfacing native callback and WebView failures. */
async function pumpUntil(done: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  while (!done()) {
    assert(Date.now() < deadline, `${what} timed out`);
    windows.pump();
    checkCallbacks();
    if (view?.failure) {
      throw view.failure;
    }
    await Bun.sleep(5);
  }
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
      log() {},
    },
  );
  const page = view;
  await pumpUntil(() => loaded, "Page load");

  /** One DevTools protocol call used only to inspect and seed the page. */
  const cdp = async (method: string, params: object) => {
    assert(page.webview, "WebView is not ready");
    let result:
      | {
          hresult: number;
          json: string;
        }
      | undefined;
    pending.push(
      callDevToolsProtocolMethod(
        page.webview,
        method,
        JSON.stringify(params),
        (value) => {
          result = value;
        },
      ),
    );
    await pumpUntil(() => result !== undefined, `CDP ${method}`);
    assert(result && result.hresult >= 0, `${method} failed`);
    return result.json;
  };
  const evaluate = async (expression: string) => {
    const parsed = JSON.parse(
      await cdp("Runtime.evaluate", {
        expression,
        returnByValue: true,
      }),
    );
    assert(!parsed.exceptionDetails, JSON.stringify(parsed));
    return parsed.result?.value;
  };
  type Frame = "top" | "same-origin";
  type FieldState = {
    value: string;
    start: number;
    end: number;
  };
  /** Expression for the document that holds the textarea of a frame. */
  const documentOf = (frame: Frame) =>
    frame === "top"
      ? "document"
      : `document.getElementById("f").contentDocument`;
  const fieldId = (frame: Frame) => (frame === "top" ? "a" : "b");
  const fieldIn = (frame: Frame): Promise<FieldState> =>
    evaluate(
      `(() => { const e = ${documentOf(frame)}.getElementById("${fieldId(frame)}"); return { value: e.value, start: e.selectionStart, end: e.selectionEnd }; })()`,
    );
  const field = () => fieldIn("top");
  const focusField = (frame: Frame) =>
    evaluate(
      frame === "top"
        ? `document.getElementById("a").focus(), true`
        : `(() => { const f = document.getElementById("f"); f.focus(); f.contentDocument.getElementById("b").focus(); return true; })()`,
    );
  type EventCounts = Record<string, number>;
  /** Poll a page expression until it is truthy. */
  const waitForPage = async (expression: string, what: string) => {
    const deadline = Date.now() + STEP_TIMEOUT_MS;
    while (!(await evaluate(expression))) {
      assert(Date.now() < deadline, `${what} did not become ready`);
      await Bun.sleep(POLL_MS);
    }
  };
  const eventCounts = (): Promise<EventCounts> =>
    evaluate(`({ ...window.counts })`);
  /** Poll the textarea until it satisfies `accept`, since a command applies asynchronously. */
  const fieldWhere = async (
    accept: (state: FieldState) => boolean,
    what: string,
    frame: Frame = "top",
  ) => {
    const deadline = Date.now() + STEP_TIMEOUT_MS;
    let state = await fieldIn(frame);
    while (!accept(state)) {
      assert(
        Date.now() < deadline,
        `${what} did not happen: ${JSON.stringify(state)}`,
      );
      await Bun.sleep(POLL_MS);
      state = await fieldIn(frame);
    }
    return state;
  };

  const host: NativeMenuWindowHost = {
    resolve: () => hwnd,
    subscribe(_id, receive) {
      listeners.add(receive);
      return () => {
        listeners.delete(receive);
      };
    },
    interrupt: () => () => {},
    changed() {
      page.resize();
    },
    executeRole(_id, role) {
      executed.push(role);
      page.executeEditCommand(role, {
        failed: (reason) => failures.push(`${role}: ${reason}`),
        skipped: (reason) => skips.push(`${role}: ${reason}`),
      });
    },
  };
  menus = new WindowMenus(host);
  // Role items omit their label; the plain item proves non-role selections still report.
  const items = menuItemsSchema.parse([
    {
      id: "edit",
      type: "submenu",
      label: "Edit",
      items: [
        ...ROLES.map((role) => ({
          id: role,
          type: "item",
          role,
        })),
        {
          id: "plain",
          type: "item",
          label: "Plain",
        },
      ],
    },
    // A top-level menu-bar role item gets no shortcut text.
    {
      id: "top-copy",
      type: "item",
      role: "copy",
    },
  ]);
  menus.set(
    "main",
    items,
    (id) => selections.push(id),
    () => {},
  );
  const menuBar = user.symbols.GetMenu(hwnd);
  const submenu = user.symbols.GetSubMenu(menuBar, 0);
  assert(submenu, "Edit submenu is missing");
  assert.equal(menuText(menuBar, 1), "Copy");

  // Electron's default labels with their Windows shortcut text.
  assert.deepEqual(
    [
      ...ROLES,
      "plain",
    ].map((_, position) => menuText(submenu, position)),
    [
      "Undo\tCtrl+Z",
      "Redo\tCtrl+Y",
      "Cut\tCtrl+X",
      "Copy\tCtrl+C",
      "Paste\tCtrl+V",
      "Select All\tCtrl+A",
      "Plain",
    ],
  );

  windows.focus(hwnd);

  /** Choose a menu-bar item exactly as Windows reports it: WM_MENUCOMMAND with HMENU and position. */
  const choose = (position: number) => {
    user.symbols.SendMessageW(hwnd, WM_MENUCOMMAND, BigInt(position), submenu);
  };
  const roleItem = (role: NativeMenuRole) => ROLES.indexOf(role);
  const spike = (check: string, role: string, frame: Frame, result: object) =>
    console.log(
      `MENU_ROLE_DIRECT_SPIKE ${JSON.stringify({
        check,
        role,
        frame,
        result,
      })}`,
    );

  /**
   * Select a role from the menu bar and observe the page: the field, the clipboard, the page
   * events it caused and the host's failure and skip reports. Same-origin iframe observations
   * are also logged as MENU_ROLE_DIRECT_SPIKE lines, since their copy and cut behaviour is
   * recorded rather than asserted.
   */
  const selectRole = async (frame: Frame, role: NativeMenuRole) => {
    const before = await eventCounts();
    const typesBefore: string[] = await evaluate(`[...window.inputTypes]`);
    const failuresBefore = failures.length;
    const skipsBefore = skips.length;
    choose(roleItem(role));
    // The command completes on a later pump; each page query below pumps the STA.
    await Bun.sleep(CASCADE_SETTLE_MS);
    const state = await fieldIn(frame);
    const clipboard = await readClipboard(hwnd);
    const after = await eventCounts();
    const events = Object.fromEntries(
      Object.keys(after).map((type) => [
        type,
        (after[type] ?? 0) - (before[type] ?? 0),
      ]),
    );
    const inputTypes: string[] = (
      (await evaluate(`[...window.inputTypes]`)) as string[]
    ).slice(typesBefore.length);
    const observed = {
      ...state,
      clipboard,
      events,
      inputTypes,
      failures: failures.slice(failuresBefore),
      skips: skips.slice(skipsBefore),
    };
    if (frame !== "top") {
      spike("menu-bar", role, frame, observed);
    }
    return observed;
  };

  // The iframe element exists before its srcdoc document is loaded; wait for both textareas.
  await waitForPage(
    `document.getElementById("a") !== null && document.getElementById("f").contentDocument?.getElementById("b") != null`,
    "Test frames",
  );

  for (const frame of [
    "top",
    "same-origin",
  ] as const) {
    // Copy and cut write the clipboard through the page's user activation. Whether that
    // activation reaches a subframe is recorded for the iframe instead of being asserted, and
    // the steps that depend on a successful cut follow the same rule.
    const topFrame = frame === "top";
    clearClipboard(hwnd);
    await focusField(frame);
    await evaluate(
      `${documentOf(frame)}.getElementById("${fieldId(frame)}").value = ""`,
    );
    await cdp("Input.insertText", {
      text: SEED,
    });
    assert.equal((await fieldIn(frame)).value, SEED);
    const label = (what: string) => `${frame} ${what}`;

    const selectAll = await selectRole(frame, "selectAll");
    assert.deepEqual(
      [
        selectAll.start,
        selectAll.end,
        selectAll.events.selectstart,
      ],
      [
        0,
        SEED.length,
        1,
      ],
      label("Select All"),
    );
    assert.deepEqual(selectAll.failures, [], label("Select All failures"));

    const copied = await selectRole(frame, "copy");
    if (topFrame) {
      assert.equal(copied.clipboard, SEED, label("Copy clipboard"));
      assert.equal(copied.value, SEED, label("Copy keeps the text"));
      assert.equal(copied.events.copy, 1, label("Copy event"));
      assert.deepEqual(copied.failures, [], label("Copy failures"));
    }
    clearClipboard(hwnd);
    const cut = await selectRole(frame, "cut");
    if (topFrame) {
      assert.equal(cut.value, "", label("Cut empties the field"));
      assert.equal(cut.clipboard, SEED, label("Cut clipboard"));
      assert.equal(cut.events.cut, 1, label("Cut event"));
      assert.equal(cut.events.beforeinput, 0, label("Cut beforeinput"));
      assert.deepEqual(cut.failures, [], label("Cut failures"));
    }
    const cutWorked = cut.value === "";

    const pasted = await selectRole(frame, "paste");
    assert.equal(pasted.events.paste, 0, label("Paste emits no paste event"));
    assert.deepEqual(pasted.failures, [], label("Paste failures"));
    if (pasted.clipboard === null) {
      // An iframe whose cut did not reach the clipboard leaves nothing to insert.
      assert(!topFrame, "Top frame cut must leave text on the clipboard");
      assert.deepEqual(pasted.skips, [
        "paste: clipboard-empty",
      ]);
      assert.deepEqual(pasted.inputTypes, []);
    } else {
      assert.equal(
        pasted.value,
        pasted.clipboard,
        label("Paste inserts the clipboard text"),
      );
      assert.deepEqual(
        pasted.inputTypes,
        [
          "insertText",
        ],
        label("Paste input"),
      );
    }

    const undone = await selectRole(frame, "undo");
    const redone = await selectRole(frame, "redo");
    if (topFrame || cutWorked) {
      assert.notEqual(undone.value, pasted.value, label("Undo changes text"));
      assert.equal(redone.value, pasted.value, label("Redo restores text"));
      assert.equal(undone.events.beforeinput, 0, label("Undo beforeinput"));
      assert.equal(redone.events.beforeinput, 0, label("Redo beforeinput"));
      assert.deepEqual(undone.failures, [], label("Undo failures"));
      assert.deepEqual(redone.failures, [], label("Redo failures"));
    }
  }

  assert.deepEqual(executed, [
    ...[
      "top",
      "same-origin",
    ].flatMap(() => [
      "selectAll",
      "copy",
      "cut",
      "paste",
      "undo",
      "redo",
    ]),
  ]);

  // An empty clipboard skips paste without touching the page.
  await focusField("top");
  clearClipboard(hwnd);
  const emptyClipboard = await selectRole("top", "paste");
  assert.deepEqual(emptyClipboard.skips, [
    "paste: clipboard-empty",
  ]);
  assert.deepEqual(emptyClipboard.failures, []);
  assert.equal(emptyClipboard.events.beforeinput, 0);

  // A focused cross-origin frame (a sandboxed iframe without same-origin access) is skipped:
  // nothing is inserted and nothing fails.
  await focusField("top");
  await selectRole("top", "selectAll");
  assert.equal((await selectRole("top", "copy")).clipboard, SEED);
  await evaluate(`document.getElementById("x").focus(), true`);
  const crossOriginBefore = await field();
  for (const role of [
    "copy",
    "paste",
  ] as const) {
    const skipped = await selectRole("top", role);
    assert.deepEqual(
      skipped.skips,
      [
        `${role}: cross-origin-frame`,
      ],
      `cross-origin ${role}`,
    );
    assert.deepEqual(skipped.failures, []);
    assert.equal(skipped.events.beforeinput, 0);
  }
  assert.deepEqual(await field(), crossOriginBefore);
  assert.deepEqual(selections, [], "Roles must not be reported as selections");
  assert.equal(
    (await eventCounts()).keydown,
    0,
    "Menu roles must not produce key events",
  );
  choose(ROLES.length);
  assert.deepEqual(selections, [
    "plain",
  ]);

  // A context popup runs the role too, then reports no selection.
  await focusField("top");
  await evaluate(
    `(() => { const e = document.getElementById("a"); e.setSelectionRange(0, 0); return true; })()`,
  );
  const popupItems: NativeMenuItem[] = menuItemsSchema.parse([
    {
      id: "selectAll",
      type: "item",
      role: "selectAll",
    },
  ]);
  let ticks = 0;
  const controller = new AbortController();
  const driver = (message: number, wparam: bigint) => {
    if (message !== WM_TIMER || wparam === 0n) {
      return;
    }
    ticks++;
    if (ticks === POPUP_KEY_TICKS.down) {
      user.symbols.PostMessageW(hwnd, WM_KEYDOWN, BigInt(VK_DOWN), 0n);
    } else if (ticks === POPUP_KEY_TICKS.enter) {
      user.symbols.PostMessageW(hwnd, WM_KEYDOWN, BigInt(VK_RETURN), 0n);
    } else if (ticks === POPUP_KEY_TICKS.giveUp) {
      controller.abort();
    }
  };
  listeners.add(driver);
  let popupResult: string | null | undefined;
  try {
    popupResult = menus.popup("main", popupItems, 100, 100, controller.signal);
  } finally {
    listeners.delete(driver);
  }
  assert.equal(popupResult, null, "A role popup item reports no selection");
  await fieldWhere(
    (state) => state.start === 0 && state.end === SEED.length,
    "Popup Select All",
  );
  assert.deepEqual(executed.at(-1), "selectAll");
  assert.deepEqual(selections, [
    "plain",
  ]);
  assert.equal((await eventCounts()).keydown, 0);

  // Close with a command still in flight: cleanup must wait for WebView2 to release its
  // completion handler instead of failing the outstanding-reference check.
  const ignore = {
    failed() {},
    skipped() {},
  };
  assert.equal(page.executeEditCommand("copy", ignore), true);
  // A closing WebView then ignores further commands and reports that they did not start.
  page.requestClose();
  assert.equal(page.executeEditCommand("copy", ignore), false);
  verified = true;
} finally {
  menus?.dispose();
  if (view) {
    view.requestClose();
    const deadline = Date.now() + 35_000;
    while (!view.detach()) {
      assert(Date.now() < deadline, "Controller did not detach");
      windows.pump();
      await Bun.sleep(5);
    }
    windows.destroy(hwnd);
    hwnd = 0n;
    while (!view.finish()) {
      assert(Date.now() < deadline, "Controller retained native resources");
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
assert(verified);
await writeFile(
  resolve(root, "build/windows-menu-roles-results.json"),
  JSON.stringify(
    {
      pass: true,
      roles: executed,
    },
    null,
    2,
  ),
);
console.log(
  "PASS actual WebView2 menu roles from a window menu and a context popup: undo, redo, cut, copy, paste and select all run without menu.clicked selections",
);
