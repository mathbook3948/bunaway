import { dlopen, JSCallback, ptr, read, toArrayBuffer } from "bun:ffi";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
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
  wide,
} from "#native/windows/bun/win32-bindings";

// Spike for TODO 324 (menu roles): can CDP editing commands run Undo/Redo/Cut/Copy/Paste/Select All
// in a WebView2 page, with and without AreDevToolsEnabled, and does focus survive a closed popup?
// Every outcome is logged as one `MENU_ROLE_SPIKE <json>` line; individual failures never fail the
// run, only the final summary assertion does.
assert.equal(process.platform, "win32");
const root = resolve(import.meta.dir, "../..");
const output = resolve(root, "build/windows-menu-role-spike");
const assets = resolve(output, "assets");
const caption = "Bunaway menu role spike";
const CF_UNICODETEXT = 13;
const STEP_TIMEOUT_MS = 30_000;
const CLIPBOARD_ATTEMPTS = 20;
const POPUP_DISMISS_MS = 300;
const TIMER_ID = 1;
const TPM_RETURNCMD = 0x0100;
const MF_STRING = 0;
const SEED = "hello world";
// Chromium editing command names accepted by Input.dispatchKeyEvent `commands`.
const COMMANDS = [
  "selectAll",
  "copy",
  "cut",
  "paste",
  "undo",
  "redo",
] as const;
// Real key chords for the same operations, to compare against the `commands` route.
const CHORDS: Record<
  (typeof COMMANDS)[number],
  {
    key: string;
    code: string;
    vk: number;
    modifiers: number;
  }
> = {
  selectAll: {
    key: "a",
    code: "KeyA",
    vk: 65,
    modifiers: 2,
  },
  copy: {
    key: "c",
    code: "KeyC",
    vk: 67,
    modifiers: 2,
  },
  cut: {
    key: "x",
    code: "KeyX",
    vk: 88,
    modifiers: 2,
  },
  paste: {
    key: "v",
    code: "KeyV",
    vk: 86,
    modifiers: 2,
  },
  undo: {
    key: "z",
    code: "KeyZ",
    vk: 90,
    modifiers: 2,
  },
  redo: {
    key: "z",
    code: "KeyZ",
    vk: 90,
    modifiers: 10,
  },
};

const clip = dlopen("user32.dll", {
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
  CreatePopupMenu: {
    args: [],
    returns: "u64",
  },
  AppendMenuW: {
    args: [
      "u64",
      "u32",
      "u64",
      "ptr",
    ],
    returns: "i32",
  },
  TrackPopupMenu: {
    args: [
      "u64",
      "u32",
      "i32",
      "i32",
      "i32",
      "u64",
      "ptr",
    ],
    returns: "i32",
  },
  EndMenu: {
    args: [],
    returns: "i32",
  },
  DestroyMenu: {
    args: [
      "u64",
    ],
    returns: "i32",
  },
  SetTimer: {
    args: [
      "u64",
      "u64",
      "u32",
      "ptr",
    ],
    returns: "u64",
  },
  KillTimer: {
    args: [
      "u64",
      "u64",
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
    if (clip.symbols.OpenClipboard(owner)) {
      try {
        const handle = clip.symbols.GetClipboardData(CF_UNICODETEXT);
        if (!handle) {
          return null;
        }
        const address = memory.symbols.GlobalLock(handle);
        if (!address) {
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
        clip.symbols.CloseClipboard();
      }
    }
    await Bun.sleep(25);
  }
  return null;
}

function clearClipboard(owner: bigint): void {
  if (clip.symbols.OpenClipboard(owner)) {
    clip.symbols.EmptyClipboard();
    clip.symbols.CloseClipboard();
  }
}

await mkdir(resolve(assets, "web"), {
  recursive: true,
});
await writeFile(
  resolve(assets, "web/index.html"),
  `<!doctype html><title>Menu role spike</title>
  <textarea id="a" rows="4" cols="40"></textarea>
  <textarea id="b" rows="4" cols="40"></textarea>
  <script>addEventListener("load", () => chrome.webview.postMessage("loaded"));</script>`,
);
hr(ole.symbols.CoInitializeEx(null, 2), "CoInitializeEx(STA)");
const windows = new Windows(() => {});

type Step = {
  step: string;
  ok: boolean;
  [key: string]: unknown;
};
const records: Step[] = [];
function record(devtools: boolean, step: Step): void {
  const line = {
    devtools,
    ...step,
  };
  records.push(step);
  console.log(`MENU_ROLE_SPIKE ${JSON.stringify(line)}`);
}

/** Run one observation; a throw becomes a recorded failure instead of aborting the spike. */
async function observe(
  devtools: boolean,
  step: string,
  run: () => Promise<Record<string, unknown>>,
): Promise<void> {
  try {
    const details = await run();
    record(devtools, {
      step,
      ok: details.ok !== false,
      ...details,
    });
  } catch (error) {
    record(devtools, {
      step,
      ok: false,
      error: String(error),
    });
  }
}

async function runScenario(devtools: boolean): Promise<void> {
  let hwnd = 0n;
  let webview: WebView | undefined;
  let loaded = false;
  const pending: ComHandler[] = [];
  const finished = new Set<ComHandler>();
  try {
    hwnd = windows.create(caption, 640, 480, () => {}, true, {
      titlebar: "system",
    });
    webview = new WebView(
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
          webview?.navigate();
        },
        documentComplete() {},
        log() {},
      },
      false,
      devtools,
    );
    const view = webview;
    const pumpUntil = async (done: () => boolean, what: string) => {
      const deadline = Date.now() + STEP_TIMEOUT_MS;
      while (!done()) {
        assert(Date.now() < deadline, `${what} timed out`);
        windows.pump();
        checkCallbacks();
        if (view.failure) {
          throw view.failure;
        }
        await Bun.sleep(5);
      }
    };
    await pumpUntil(() => loaded, "Spike page load");

    /** One CDP call, pumped to completion. */
    const cdp = async (method: string, params: object) => {
      assert(view.webview, "WebView is not ready");
      let result:
        | {
            hresult: number;
            json: string;
          }
        | undefined;
      const completion = callDevToolsProtocolMethod(
        view.webview,
        method,
        JSON.stringify(params),
        (value) => {
          result = value;
          finished.add(completion);
        },
      );
      pending.push(completion);
      await pumpUntil(() => result !== undefined, `CDP ${method}`);
      assert(result);
      return result;
    };
    const evaluate = async (expression: string) => {
      const result = await cdp("Runtime.evaluate", {
        expression,
        returnByValue: true,
      });
      assert(result.hresult >= 0, `Runtime.evaluate 0x${result.hresult >>> 0}`);
      const parsed = JSON.parse(result.json) as {
        result?: {
          value?: unknown;
        };
        exceptionDetails?: unknown;
      };
      assert(!parsed.exceptionDetails, result.json);
      return parsed.result?.value;
    };
    const fieldState = () =>
      evaluate(
        `(() => { const e = document.activeElement; return { id: e.id, value: e.value, start: e.selectionStart, end: e.selectionEnd, hasFocus: document.hasFocus() }; })()`,
      ) as Promise<{
        id: string;
        value: string;
        start: number;
        end: number;
        hasFocus: boolean;
      }>;
    const focusField = (id: string) =>
      evaluate(`document.getElementById(${JSON.stringify(id)}).focus(), true`);
    const sendCommand = (command: (typeof COMMANDS)[number]) =>
      cdp("Input.dispatchKeyEvent", {
        type: "rawKeyDown",
        commands: [
          command,
        ],
      });
    const sendChord = async (command: (typeof COMMANDS)[number]) => {
      const chord = CHORDS[command];
      const common = {
        modifiers: chord.modifiers,
        key: chord.key,
        code: chord.code,
        windowsVirtualKeyCode: chord.vk,
      };
      await cdp("Input.dispatchKeyEvent", {
        type: "rawKeyDown",
        ...common,
      });
      return cdp("Input.dispatchKeyEvent", {
        type: "keyUp",
        ...common,
      });
    };

    await observe(devtools, "environment", async () => ({
      devtoolsEnabled: devtools,
      foreground: windows.focus(hwnd),
      webviewFocused: view.getState().focused,
    }));

    // Run the same Undo/Redo/Cut/Copy/Paste/Select All sequence for both input routes.
    for (const route of [
      "commands",
      "chord",
    ] as const) {
      const send = route === "commands" ? sendCommand : sendChord;
      await observe(devtools, `${route}:setup`, async () => {
        clearClipboard(hwnd);
        await evaluate(`document.getElementById("a").value = ""`);
        await focusField("a");
        const inserted = await cdp("Input.insertText", {
          text: SEED,
        });
        const state = await fieldState();
        return {
          ok: inserted.hresult >= 0 && state.value === SEED,
          hresult: inserted.hresult,
          state,
        };
      });
      for (const command of COMMANDS) {
        await observe(devtools, `${route}:${command}`, async () => {
          const sent = await send(command);
          // Commands apply on the renderer asynchronously relative to the CDP reply.
          await Bun.sleep(100);
          const state = await fieldState();
          const clipboard = await readClipboard(hwnd);
          const expected = {
            selectAll: state.start === 0 && state.end === SEED.length,
            copy: clipboard === SEED && state.value === SEED,
            cut: clipboard === SEED && state.value === "",
            paste: state.value === SEED,
            undo: state.value === "",
            redo: state.value === SEED,
          }[command];
          return {
            ok: sent.hresult >= 0 && expected,
            hresult: sent.hresult,
            reply: sent.json,
            state,
            clipboard,
          };
        });
      }
    }

    // Closing a popup menu must leave keyboard focus in the page so a role can still run.
    await observe(devtools, "popup-focus", async () => {
      await focusField("a");
      const before = {
        os: view.getState().focused,
        page: await fieldState(),
      };
      const menu = clip.symbols.CreatePopupMenu();
      const label = wide("Spike item");
      clip.symbols.AppendMenuW(menu, MF_STRING, 1n, ptr(label));
      const dismiss = new JSCallback(
        () => {
          clip.symbols.EndMenu();
        },
        {
          args: [
            "u64",
            "u32",
            "u64",
            "u32",
          ],
          returns: "void",
        },
      );
      let tracked: number;
      try {
        clip.symbols.SetTimer(
          hwnd,
          BigInt(TIMER_ID),
          POPUP_DISMISS_MS,
          dismiss.ptr,
        );
        tracked = clip.symbols.TrackPopupMenu(
          menu,
          TPM_RETURNCMD,
          100,
          100,
          0,
          hwnd,
          null,
        );
      } finally {
        clip.symbols.KillTimer(hwnd, BigInt(TIMER_ID));
        dismiss.close();
        clip.symbols.DestroyMenu(menu);
      }
      windows.pump();
      const afterOs = view.getState().focused;
      const afterPage = await fieldState();
      // Does a role still run without restoring focus explicitly?
      await sendCommand("selectAll");
      await Bun.sleep(100);
      const selected = await fieldState();
      let restored: boolean | undefined;
      if (!afterOs) {
        view.moveFocusToContent();
        await Bun.sleep(100);
        restored = view.getState().focused;
      }
      return {
        before,
        tracked,
        after: {
          os: afterOs,
          page: afterPage,
        },
        selectAllAfterPopup:
          selected.start === 0 && selected.end === SEED.length,
        restoredByMoveFocus: restored,
        ok: afterPage.id === "a" && selected.end === selected.value.length,
      };
    });
  } finally {
    if (webview) {
      webview.requestClose();
      const deadline = Date.now() + 35_000;
      while (!webview.detach()) {
        assert(Date.now() < deadline, "Spike controller did not detach");
        windows.pump();
        await Bun.sleep(5);
      }
      windows.destroy(hwnd);
      hwnd = 0n;
      while (!webview.finish()) {
        assert(Date.now() < deadline, "Spike controller retained resources");
        windows.pump();
        await Bun.sleep(5);
      }
    }
    if (hwnd) {
      windows.destroy(hwnd);
    }
    // Every issued call has completed before cleanup, so each handler holds only its owner ref.
    disposeHandlers(pending.filter((completion) => finished.has(completion)));
  }
}

try {
  for (const devtools of [
    false,
    true,
  ]) {
    await runScenario(devtools);
  }
} finally {
  disposeCom();
  windows.dispose();
  ole.symbols.CoUninitialize();
  disposeWin32Bindings();
}
const failed = records.filter((step) => !step.ok).map((step) => step.step);
const summary = {
  step: "summary",
  total: records.length,
  failed: failed.length,
  failedSteps: failed,
};
console.log(`MENU_ROLE_SPIKE ${JSON.stringify(summary)}`);
await writeFile(
  resolve(root, "build/windows-menu-role-spike-results.json"),
  JSON.stringify(
    {
      records,
      summary,
    },
    null,
    2,
  ),
);
// Individual command outcomes are data for the design decision; only a missing run is a failure.
assert(records.length > 0, "Spike recorded no observations");
