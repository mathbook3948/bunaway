import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  checkCallbacks,
  disposeCom,
  disposeHandlers,
  handler,
  query,
} from "#native/windows/bun/com";
import { WebView } from "#native/windows/bun/webview";
import { Windows } from "#native/windows/bun/win32";
import { disposeWin32Bindings, ole } from "#native/windows/bun/win32-bindings";
import { checkHresult } from "@bunaway/plugin/win32";

assert.equal(process.platform, "win32");
const root = resolve(import.meta.dir, "../..");
const assets = resolve(root, "build/windows-webview-print-ui/assets");
await mkdir(resolve(assets, "web"), {
  recursive: true,
});
await writeFile(
  resolve(assets, "web/index.html"),
  "<!doctype html><title>Print UI regression</title><h1>Print preview only</h1>",
);
checkHresult(ole.symbols.CoInitializeEx(null, 2), "CoInitializeEx(STA)");
const windows = new Windows(() => {});
let hwnd = 0n;
let webview: WebView | undefined;
let documentReady = false;
let browserVersion = "";
let accepted = false;
try {
  // Exercise the optional QueryInterface result with a real COM ABI object that lacks the extension.
  const missing = handler(
    "missing-print-extension",
    "d557aa55-f616-4e1d-8d88-912294b793ce",
    [],
    () => {},
  );
  assert.equal(
    query(missing.pointer, "0eb34dc9-9f91-41e1-8639-95cd5943906b", true),
    undefined,
  );
  assert.throws(
    () => query(missing.pointer, "0eb34dc9-9f91-41e1-8639-95cd5943906b"),
    /QueryInterface/,
  );
  disposeHandlers([
    missing,
  ]);
  hwnd = windows.create("Print dialog regression", 640, 480, () => {});
  webview = new WebView(
    hwnd,
    {
      view: "main",
      title: "Print dialog regression",
      home: "https://app.bunaway.local/index.html",
      window: {
        width: 640,
        height: 480,
      },
    },
    assets,
    resolve(root, `build/windows-webview-print-ui/data-${process.pid}`),
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
        throw new Error("Unexpected close before cleanup");
      },
      ready() {
        webview?.navigate();
      },
      documentComplete(error) {
        assert.equal(error, null);
        documentReady = true;
      },
      log(event, data) {
        if (event === "webview-ready" && data && "browserVersion" in data) {
          browserVersion = String(data.browserVersion);
        }
      },
    },
  );
  const deadline = Date.now() + 30_000;
  while (!documentReady) {
    assert(Date.now() < deadline, "Print document did not become ready");
    windows.pump();
    checkCallbacks();
    if (webview.failure) {
      throw webview.failure;
    }
    await Bun.sleep(5);
  }
  webview.showPrintUI("browser");
  // A second request uses WebView2's existing-dialog behavior, without submitting a print job.
  webview.showPrintUI("browser");
  accepted = true;
  for (let i = 0; i < 20; i++) {
    windows.pump();
    checkCallbacks();
    await Bun.sleep(5);
  }
} finally {
  if (webview) {
    webview.requestClose();
    const deadline = Date.now() + 35_000;
    while (!webview.detach()) {
      assert(Date.now() < deadline, "Print controller did not detach");
      windows.pump();
      await Bun.sleep(5);
    }
    windows.destroy(hwnd);
    hwnd = 0n;
    while (!webview.finish()) {
      assert(
        Date.now() < deadline,
        "Print preview retained native resources after close",
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
assert(accepted);
await writeFile(
  resolve(root, "build/windows-webview-print-ui-results.json"),
  JSON.stringify(
    {
      pass: true,
      browserVersion,
      browserDialogRequestAccepted: true,
      nativeCleanup: true,
      physicalPrintingVerified: false,
      systemDialogVerified: false,
    },
    null,
    2,
  ),
);
console.log(
  "PASS actual WebView2 browser print dialog request, repeated request and native cleanup; physical printing and system dialog interaction remain unverified",
);
