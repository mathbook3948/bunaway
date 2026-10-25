import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { checkHresult } from "@bunaway/plugin/win32";
import {
  type ComHandler,
  checkCallbacks,
  disposeCom,
  disposeHandlers,
  handler,
} from "#native/windows/bun/com";
import { WebView } from "#native/windows/bun/webview";
import { callDevToolsProtocolMethod } from "#native/windows/bun/webview-devtools";
import { enableCustomTitlebar } from "#native/windows/bun/webview-titlebar";
import { Windows } from "#native/windows/bun/win32";
import { disposeWin32Bindings, ole } from "#native/windows/bun/win32-bindings";
import { deadline, waitFor } from "../fixtures/deadlines.ts";

assert.equal(process.platform, "win32");
const root = resolve(import.meta.dir, "../..");
const output = resolve(root, "build/windows-webview-titlebar");
const assets = resolve(output, "assets");
await mkdir(resolve(assets, "web"), {
  recursive: true,
});
await writeFile(
  resolve(assets, "web/index.html"),
  `<!doctype html><title>Custom titlebar</title>
  <style>header { app-region: drag; height: 48px; } button { app-region: no-drag; }</style>
  <header>Window title <button aria-label="Example titlebar button" onclick="window.titlebarClicks++">Action</button></header>
  <button id="after-titlebar">After titlebar</button>
  <script>window.titlebarClicks = 0;addEventListener("load", () => chrome.webview.postMessage({
    drag: getComputedStyle(document.querySelector("header")).getPropertyValue("app-region"),
    noDrag: getComputedStyle(document.querySelector("button")).getPropertyValue("app-region")
  }));</script>`,
);
checkHresult(ole.symbols.CoInitializeEx(null, 2), "CoInitializeEx(STA)");
const windows = new Windows(() => {});
let hwnd = 0n;
let webview: WebView | undefined;
let documents = 0;
let browserVersion = "";
let verified = false;
let regionDocuments = 0;
let accessibleButtonNames: string[] = [];
let keyboardClicks = 0;
const pendingCalls: ComHandler[] = [];
try {
  const missing = handler(
    "missing-titlebar-extension",
    "d557aa55-f616-4e1d-8d88-912294b793ce",
    [],
    () => {},
  );
  assert.throws(() => enableCustomTitlebar(missing.pointer), {
    code: "UNSUPPORTED",
  });
  disposeHandlers([
    missing,
  ]);
  hwnd = windows.create(
    "Custom titlebar regression",
    640,
    480,
    () => {},
    true,
    {
      titlebar: "custom",
    },
  );
  webview = new WebView(
    hwnd,
    {
      view: "main",
      title: "Custom titlebar regression",
      home: "https://app.bunaway.local/index.html",
      window: {
        width: 640,
        height: 480,
        titlebar: "custom",
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
        assert.deepEqual(JSON.parse(raw), {
          drag: "drag",
          noDrag: "no-drag",
        });
        regionDocuments++;
      },
      revoke() {},
      sameDocument() {},
      close() {
        throw new Error("Unexpected close before cleanup");
      },
      ready() {
        webview?.navigate();
      },
      documentComplete(error) {
        assert.equal(error, null);
        documents++;
      },
      log(event, data) {
        if (event === "webview-ready" && data && "browserVersion" in data) {
          browserVersion = String(data.browserVersion);
        }
      },
    },
  );
  const waitForDocument = async (count: number) => {
    const deadline = Date.now() + 30_000;
    while (documents < count || regionDocuments < count) {
      assert(
        Date.now() < deadline,
        "Titlebar regression document did not load",
      );
      windows.pump();
      checkCallbacks();
      if (webview?.failure) {
        throw webview.failure;
      }
      await Bun.sleep(5);
    }
  };
  await waitForDocument(1);
  assert.equal(windows.getTitlebar(hwnd), "custom");
  const page = webview;
  /** One DevTools protocol call against the titlebar page, pumped to completion. */
  const cdp = async (method: string, params: object) => {
    assert(page.webview, "WebView is not ready");
    let result:
      | {
          hresult: number;
          json: string;
        }
      | undefined;
    const call = callDevToolsProtocolMethod(
      page.webview,
      method,
      JSON.stringify(params),
      (value) => {
        result = value;
      },
    );
    const callDeadline = Date.now() + deadline("toolchain");
    while (result === undefined) {
      assert(Date.now() < callDeadline, `CDP ${method} did not complete`);
      windows.pump();
      checkCallbacks();
      await Bun.sleep(5);
    }
    // Only a completed call is retired in the cleanup: native may still hold the handler of one
    // that never completed, and retiring that one would hide the timeout behind a COM error.
    pendingCalls.push(call);
    assert(result.hresult >= 0, `${method} failed: ${result.hresult}`);
    return JSON.parse(result.json || "{}");
  };
  const press = async (code: string, key: string, vk: number, text = "") => {
    const common = {
      key,
      code,
      windowsVirtualKeyCode: vk,
    };
    await cdp("Input.dispatchKeyEvent", {
      ...common,
      type: text ? "keyDown" : "rawKeyDown",
      ...(text
        ? {
            text,
          }
        : {}),
    });
    await cdp("Input.dispatchKeyEvent", {
      ...common,
      type: "keyUp",
    });
  };
  const evaluate = async (expression: string) => {
    const parsed = await cdp("Runtime.evaluate", {
      expression,
      returnByValue: true,
    });
    assert(!parsed.exceptionDetails, JSON.stringify(parsed));
    return parsed.result?.value;
  };
  // A control inside a CSS drag region must stay exposed in the page's accessibility tree with
  // its accessible name. The tree is computed after Accessibility.enable, so it is polled until
  // the button appears.
  await cdp("Accessibility.enable", {});
  accessibleButtonNames = await waitFor(
    async () => {
      const tree = await cdp("Accessibility.getFullAXTree", {});
      const names = (
        tree.nodes as {
          ignored?: boolean;
          role?: {
            value?: string;
          };
          name?: {
            value?: string;
          };
        }[]
      )
        .filter((node) => !node.ignored && node.role?.value === "button")
        .map((node) => node.name?.value ?? "");
      return names.includes("Example titlebar button") ? names : undefined;
    },
    {
      deadline: "toolchain",
      what: "the titlebar button in the accessibility tree",
      intervalMs: 100,
    },
  );
  // Keyboard navigation reaches a no-drag control inside the drag region and activates it.
  // Focus emulation keeps the renderer from treating the page as unfocused when the CI session
  // has no foreground window.
  await cdp("Emulation.setFocusEmulationEnabled", {
    enabled: true,
  });
  assert.equal(
    await evaluate("document.activeElement === document.body"),
    true,
  );
  await press("Tab", "Tab", 9);
  assert.equal(
    await evaluate("document.activeElement?.tagName"),
    "BUTTON",
    "Tab did not reach the titlebar button",
  );
  await press("Enter", "Enter", 13, "\r");
  await press("Space", " ", 32, " ");
  keyboardClicks = await evaluate("window.titlebarClicks");
  assert.equal(
    keyboardClicks,
    2,
    "Enter and Space did not activate the button",
  );
  await press("Tab", "Tab", 9);
  assert.equal(
    await evaluate("document.activeElement?.id"),
    "after-titlebar",
    "Tab did not move on from the titlebar button",
  );
  const initialWidth = windows.getBounds(hwnd, "content").width;
  windows.setFullscreen(hwnd, true);
  windows.setFullscreen(hwnd, false);
  webview.resize();
  assert.equal(windows.getTitlebar(hwnd), "custom");
  assert.equal(windows.getBounds(hwnd, "content").width, initialWidth);
  webview.navigate();
  await waitForDocument(2);
  verified = true;
} finally {
  if (webview) {
    webview.requestClose();
    const closeLimit = Date.now() + 35_000;
    while (!webview.detach()) {
      assert(Date.now() < closeLimit, "Titlebar controller did not detach");
      windows.pump();
      await Bun.sleep(5);
    }
    windows.destroy(hwnd);
    hwnd = 0n;
    while (!webview.finish()) {
      assert(
        Date.now() < closeLimit,
        "Titlebar controller retained native resources",
      );
      windows.pump();
      await Bun.sleep(5);
    }
  }
  if (hwnd) {
    windows.destroy(hwnd);
  }
  disposeHandlers(pendingCalls);
  disposeCom();
  windows.dispose();
  ole.symbols.CoUninitialize();
  disposeWin32Bindings();
}
assert(verified);
await writeFile(
  resolve(root, "build/windows-webview-titlebar-results.json"),
  JSON.stringify(
    {
      pass: true,
      browserVersion,
      customTitlebarAcrossNavigation: true,
      nativeCleanup: true,
      cssRegionDocuments: regionDocuments,
      accessibleButtonNames,
      keyboardClicks,
      physicalInputAndAssistiveClientVerified: false,
    },
    null,
    2,
  ),
);
console.log(
  "PASS actual WebView2 custom titlebar startup, CSS region documents, accessibility tree, keyboard navigation, fullscreen restoration, unsupported interface and native cleanup; physical mouse and an attached assistive technology client remain unverified",
);
