import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { AppearanceWindows } from "#native/windows/bun/appearance";
import { checkCallbacks, disposeCom } from "#native/windows/bun/com";
import { WebView } from "#native/windows/bun/webview";
import { Windows } from "#native/windows/bun/win32";
import { disposeWin32Bindings, ole } from "#native/windows/bun/win32-bindings";
import { createAppearanceController } from "#plugins/appearance/src/platforms/windows-controller";
import { initialize } from "#plugins/appearance/src/platforms/windows-preferences";
import { checkHresult } from "@bunaway/plugin/win32";
import { waitFor } from "../fixtures/deadlines.ts";

assert.equal(process.platform, "win32");
const root = resolve(import.meta.dir, "../..");
const output = resolve(root, "build/windows-webview-color-scheme");
const assets = resolve(output, "assets");
await mkdir(resolve(assets, "web"), {
  recursive: true,
});
// The page reports its `prefers-color-scheme: dark` match on load and whenever it changes.
await writeFile(
  resolve(assets, "web/index.html"),
  `<!doctype html><title>Content color scheme</title><h1>Color scheme</h1>
  <script>
    const query = matchMedia("(prefers-color-scheme: dark)");
    const report = (kind) => chrome.webview.postMessage({ kind, dark: query.matches });
    query.addEventListener("change", () => report("change"));
    addEventListener("load", () => report("load"));
  </script>`,
);
checkHresult(ole.symbols.CoInitializeEx(null, 2), "CoInitializeEx(STA)");
const windows = new Windows(() => {});
const service = new AppearanceWindows();
const reader = initialize();
const controller = createAppearanceController(reader, {
  appearance: service,
});
let hwnd = 0n;
let webview: WebView | undefined;
let documents = 0;
let browserVersion = "";
let verified = false;
const reports: {
  kind: string;
  dark: boolean;
}[] = [];
const unsupportedEvents: string[] = [];
try {
  const system = reader.read();
  hwnd = windows.create("Content color scheme regression", 640, 480, () => {});
  // Choosing a theme while the WebView does not exist yet must still reach its first document.
  service.attach("main", hwnd);
  controller.setTheme("main", "dark");
  webview = new WebView(
    hwnd,
    {
      view: "main",
      title: "Content color scheme regression",
      home: "https://app.bunaway.local/index.html",
      window: {
        width: 640,
        height: 480,
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
        reports.push(JSON.parse(raw));
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
        if (event === "color-scheme-unsupported") {
          unsupportedEvents.push(event);
        }
      },
    },
  );
  const created = webview;
  service.bindContent("main", (scheme) => created.setColorScheme(scheme));
  const pump = (done: () => boolean, what: string) =>
    waitFor(
      () => {
        windows.pump();
        checkCallbacks();
        return done() || undefined;
      },
      {
        deadline: "nativeFixture",
        what,
        intervalMs: 5,
        failed: () => webview?.failure,
      },
    );
  /** Wait for the next report after `count`, which proves the page observed the new scheme. */
  const nextReport = async (count: number, what: string) => {
    await pump(() => reports.length > count, what);
    return reports[reports.length - 1];
  };
  await pump(() => documents >= 1 && reports.length >= 1, "first document");
  // Neither an old runtime nor high contrast (which keeps the OS colors) can show a pinned scheme.
  if (unsupportedEvents.length || system.highContrast) {
    console.log("SKIP content color scheme: runtime or OS cannot pin it");
  } else {
    assert.deepEqual(reports[0], {
      kind: "load",
      dark: true,
    });
    let showsDark = true;
    /** Choose a theme and, when it changes what the page shows, wait for the page to report it. */
    const choose = async (
      theme: "system" | "light" | "dark",
      dark: boolean,
    ) => {
      const before = reports.length;
      controller.setTheme("main", theme);
      if (dark !== showsDark) {
        assert.deepEqual(await nextReport(before, `${theme} change`), {
          kind: "change",
          dark,
        });
        showsDark = dark;
      }
    };
    const osDark = system.appsTheme === "dark";
    await choose("light", false);
    await choose("dark", true);
    await choose("light", false);
    // The profile keeps the value for the next document.
    const loads = documents;
    webview.navigate();
    await pump(() => documents > loads, "second document");
    const loaded = reports.filter((report) => report.kind === "load");
    assert.equal(loaded[loaded.length - 1]?.dark, false);
    // `system` returns the content to the OS setting, which is what the runner reports.
    await choose("system", osDark);
    await choose("dark", true);
    // Disposing the plugin hands the content back to the OS setting.
    const before = reports.length;
    controller.dispose();
    if (!osDark) {
      assert.deepEqual(await nextReport(before, "reset on dispose"), {
        kind: "change",
        dark: false,
      });
    }
  }
  verified = true;
} finally {
  if (webview) {
    webview.requestClose();
    // A closing view remembers the request without touching the profile.
    assert.doesNotThrow(() => webview?.setColorScheme("auto"));
    const closing = webview;
    const pumpUntil = (done: () => boolean, what: string) =>
      waitFor(
        () => {
          windows.pump();
          return done() || undefined;
        },
        {
          deadline: "nativeFixture",
          what,
          intervalMs: 5,
        },
      );
    await pumpUntil(() => closing.detach(), "controller detach");
    service.detach("main");
    windows.destroy(hwnd);
    hwnd = 0n;
    await pumpUntil(() => closing.finish(), "native resource release");
  }
  service.detach("main");
  controller.dispose();
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
  resolve(root, "build/windows-webview-color-scheme-results.json"),
  JSON.stringify(
    {
      pass: true,
      browserVersion,
      unsupportedRuntime: unsupportedEvents.length > 0,
    },
    null,
    2,
  ),
);
console.log(
  "PASS actual WebView2 prefers-color-scheme follows the appearance controller before and after creation, persists across navigation and ends with native cleanup",
);
