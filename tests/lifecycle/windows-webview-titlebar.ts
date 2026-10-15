import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  checkCallbacks,
  disposeCom,
  disposeHandlers,
  handler,
} from "#native/windows/bun/com";
import { WebView } from "#native/windows/bun/webview";
import { enableCustomTitlebar } from "#native/windows/bun/webview-titlebar";
import { Windows } from "#native/windows/bun/win32";
import {
  disposeWin32Bindings,
  hr,
  ole,
} from "#native/windows/bun/win32-bindings";

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
  <header>Window title <button aria-label="Example titlebar button">Action</button></header>
  <script>addEventListener("load", () => chrome.webview.postMessage(JSON.stringify({
    drag: getComputedStyle(document.querySelector("header")).getPropertyValue("app-region"),
    noDrag: getComputedStyle(document.querySelector("button")).getPropertyValue("app-region")
  })));</script>`,
);
hr(ole.symbols.CoInitializeEx(null, 2), "CoInitializeEx(STA)");
const windows = new Windows(() => {});
let hwnd = 0n;
let webview: WebView | undefined;
let documents = 0;
let browserVersion = "";
let verified = false;
let regionDocuments = 0;
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
    const deadline = Date.now() + 35_000;
    while (!webview.detach()) {
      assert(Date.now() < deadline, "Titlebar controller did not detach");
      windows.pump();
      await Bun.sleep(5);
    }
    windows.destroy(hwnd);
    hwnd = 0n;
    while (!webview.finish()) {
      assert(
        Date.now() < deadline,
        "Titlebar controller retained native resources",
      );
      windows.pump();
      await Bun.sleep(5);
    }
  }
  if (hwnd) {
    windows.destroy(hwnd);
  }
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
      physicalMouseAndAccessibilityVerified: false,
    },
    null,
    2,
  ),
);
console.log(
  "PASS actual WebView2 custom titlebar startup, CSS region documents, fullscreen restoration, unsupported interface and native cleanup; physical mouse and assistive technology remain unverified",
);
