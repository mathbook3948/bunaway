import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { frameworkRoot } from "#cli/files";

// The Android WebView and WKWebView run only in the device suites (`mise run host:android`,
// `mise run host:ios`). These checks pin the single-window contract those hosts rely on, so a
// regression fails in every CI job.
const read = (path: string) => Bun.file(resolve(frameworkRoot, path)).text();
const androidHost = "native/android/host/src/main/java/dev/bunaway/host";

test("the Android app Activity is singleTask so a second launch reuses it", async () => {
  const manifest = await read(
    "native/android/app/src/main/AndroidManifest.xml",
  );
  const activity = /<activity\b[^>]*>/.exec(manifest)?.[0];
  expect(activity).toContain('android:launchMode="singleTask"');
});

test("the Android renderer refuses new-window requests", async () => {
  const source = await read(`${androidHost}/Renderer.java`);
  // onCreateWindow is only called when multiple windows are enabled; otherwise WebView loads
  // the target into the existing view.
  expect(source).toContain("settings.setSupportMultipleWindows(true);");
  expect(source).toContain(
    "settings.setJavaScriptCanOpenWindowsAutomatically(false);",
  );
  const body =
    /public boolean onCreateWindow\([^)]*\) \{([\s\S]*?)\n {20}\}\n/.exec(
      source,
    )?.[1];
  expect(body?.trim()).toBe("return false;");
  expect(source).not.toContain("resultMsg.sendToTarget");
  expect(source).not.toContain("WebViewTransport");
});

test("Android Back consumes WebView history before finishing", async () => {
  const activity = await read(`${androidHost}/BunawayActivity.java`);
  const route = /private void goBackOrFinish\(\) \{([\s\S]*?)\n {4}\}\n/.exec(
    activity,
  )?.[1];
  expect(route).toContain("renderer.goBack()");
  expect(route).toContain("finish()");
  // Both the Android 13 back callback and the legacy callback take the same route.
  expect(activity).toContain("backCallback = this::goBackOrFinish;");
  expect(
    /public void onBackPressed\(\) \{\s*goBackOrFinish\(\);\s*\}/.test(
      activity,
    ),
  ).toBe(true);
  const renderer = await read(`${androidHost}/Renderer.java`);
  const goBack = /boolean goBack\(\) \{([\s\S]*?)\n {4}\}\n/.exec(
    renderer,
  )?.[1];
  expect(goBack).toContain("view.canGoBack()");
  expect(goBack).toContain("view.goBack();");
});

test("the iOS host cancels new-window requests and creates no web view", async () => {
  const source = await read("native/ios/host/BunawayViewController.swift");
  const create =
    /createWebViewWith[\s\S]*?\) -> WKWebView\? \{([\s\S]*?)\n {2}\}\n/.exec(
      source,
    )?.[1];
  expect(create?.trim()).toBe("nil");
  const policy =
    /decidePolicyFor action: WKNavigationAction,[\s\S]*?\) \{([\s\S]*?)\n {2}\}\n/.exec(
      source,
    )?.[1];
  // A nil target frame marks window.open and target=_blank; it is decided before any URL check.
  const nilTarget = policy?.indexOf("action.targetFrame != nil") ?? -1;
  const scheme = policy?.indexOf('url?.scheme == "bunaway"') ?? -1;
  expect(nilTarget).toBeGreaterThanOrEqual(0);
  expect(nilTarget).toBeLessThan(scheme);
  expect(source).toContain("webView.uiDelegate = self");
});
