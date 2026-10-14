import { expect, test } from "bun:test";
import windows from "@bunaway/plugin-windows";
import { BunawayError } from "@bunaway/protocol";
import { MacosWebviewControls } from "#native/macos/bun/webview-controls";

/** Replace only Objective-C messaging, keeping URL policy and lifecycle guards in production code. */
function fixture() {
  const strings = new Map<bigint, string>();
  const mutations: unknown[] = [];
  let next = 10n;
  let ready = true;
  let closed = false;
  let supportsZoom = true;
  let zoom = 1;
  const string = (value: string) => {
    const id = next++;
    strings.set(id, value);
    return id;
  };
  const objc: ConstructorParameters<typeof MacosWebviewControls>[0] = {
    class: string,
    string,
    selector: string,
    text: (value) => strings.get(BigInt(value ?? 0)) ?? "",
    withAutoreleasePool: (work) => work(),
    double: () => zoom,
    setDouble(_object, _selector, value) {
      mutations.push(value);
      zoom = Math.round(value * 100) / 100;
    },
    send(object, selector, ...args) {
      switch (selector) {
        case "respondsToSelector:":
          return supportsZoom ? 1n : null;
        case "URL":
          return string("bunaway://app.bunaway.local/index.html?x=1#hash");
        case "title":
          return string("Native document");
        case "absoluteString":
          return object;
        case "URLWithString:":
        case "requestWithURL:":
          return BigInt(args[0] ?? 0);
        case "loadRequest:":
          mutations.push(strings.get(BigInt(args[0] ?? 0)));
          return 2n;
        case "canGoBack":
          return 1n;
        case "goBack":
          mutations.push(selector);
          return 2n;
        case "reload":
        case "stopLoading":
          mutations.push(selector);
          return null;
        default:
          return null;
      }
    },
  };
  const controls = new MacosWebviewControls(objc, () => {
    if (closed) {
      throw new BunawayError({
        code: "CANCELLED",
        message: "closed",
      });
    }
    if (!ready) {
      throw new BunawayError({
        code: "BUSY",
        message: "not ready",
      });
    }
    return 1n;
  }, [
    "https://app.bunaway.local",
    "http://127.0.0.1:8123",
  ]);
  return {
    controls,
    mutations,
    close: () => {
      closed = true;
    },
    notReady: () => {
      ready = false;
    },
    noZoom: () => {
      supportsZoom = false;
    },
  };
}

test("macOS registers only implemented public WebView controls", () => {
  const operations = windows._definition.nativePlatforms.macos?.operations;
  for (const name of [
    "getWebViewState",
    "navigateWebView",
    "reloadWebView",
    "stopWebView",
    "goBack",
    "goForward",
    "setZoomFactor",
  ]) {
    expect(operations).toContain(name);
  }
  expect(operations).not.toContain("openDevTools");
  expect(operations).not.toContain("getDownloads");
});
test("navigation preserves the exact HTTP origins and maps packaged assets without expanding policy", () => {
  const f = fixture();
  for (const url of [
    "bunaway://app.bunaway.local/",
    "https://app.bunaway.local.evil/",
    "HTTPS://APP.BUNAWAY.LOCAL.EVIL/",
    "HTTPS://user:pass@APP.BUNAWAY.LOCAL/",
    "http://127.0.0.1:8124/",
    "http://user:pass@127.0.0.1:8123/",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "data:text/html,hello",
    "https://app.bunaway.local/\0",
    "bad-url",
  ]) {
    expect(() => f.controls.navigate(url)).toThrow(
      expect.objectContaining({
        code: "PERMISSION_DENIED",
      }),
    );
  }
  expect(f.mutations).toEqual([]);
  f.controls.navigate("https://app.bunaway.local/next.html?x=1#hash");
  f.controls.navigate("HTTPS://app.bunaway.local/next.html?x=1#hash");
  f.controls.navigate("https://APP.BUNAWAY.LOCAL/next.html?x=1#hash");
  f.controls.navigate("HTTPS://APP.BUNAWAY.LOCAL:443/next.html?x=1#hash");
  f.controls.navigate("http://127.0.0.1:8123/next.html");
  expect(f.mutations).toEqual([
    "bunaway://app.bunaway.local/next.html?x=1#hash",
    "bunaway://app.bunaway.local/next.html?x=1#hash",
    "bunaway://app.bunaway.local/next.html?x=1#hash",
    "bunaway://app.bunaway.local/next.html?x=1#hash",
    "http://127.0.0.1:8123/next.html",
  ]);
});
test("state and normalized zoom reflect native values, history absence does not start navigation", () => {
  const f = fixture();
  expect(f.controls.getState()).toEqual({
    url: "https://app.bunaway.local/index.html?x=1#hash",
    title: "Native document",
    loading: false,
    canGoBack: true,
    canGoForward: false,
    zoomFactor: 1,
  });
  expect(f.controls.setZoomFactor(1.234)).toBe(1.23);
  expect(f.controls.getState().zoomFactor).toBe(1.23);
  expect(f.controls.goForward()).toBe(false);
  expect(f.controls.goBack()).toBe(true);
  f.controls.reload();
  f.controls.stop();
  expect(f.mutations).toEqual([
    1.234,
    "goBack",
    "reload",
    "stopLoading",
  ]);
  for (const factor of [
    Number.NaN,
    Infinity,
    0.249,
    5.001,
  ]) {
    expect(() => f.controls.setZoomFactor(factor)).toThrow(
      expect.objectContaining({
        code: "INVALID_ARGUMENT",
      }),
    );
  }
});
test("closed and initializing owners reject native access; unavailable zoom and DevTools stay unsupported", () => {
  for (const closed of [
    false,
    true,
  ]) {
    const f = fixture();
    if (closed) {
      f.close();
    } else {
      f.notReady();
    }
    for (const work of [
      () => f.controls.getState(),
      () => f.controls.navigate("https://app.bunaway.local/"),
      () => f.controls.reload(),
      () => f.controls.stop(),
      () => f.controls.goBack(),
      () => f.controls.goForward(),
      () => f.controls.setZoomFactor(1.5),
    ]) {
      expect(work).toThrow(
        expect.objectContaining({
          code: closed ? "CANCELLED" : "BUSY",
        }),
      );
    }
    expect(f.mutations).toEqual([]);
  }
  const f = fixture();
  f.noZoom();
  expect(() => f.controls.setZoomFactor(1.5)).toThrow(
    expect.objectContaining({
      code: "UNSUPPORTED",
    }),
  );
  expect(() => f.controls.openDevTools()).toThrow(
    expect.objectContaining({
      code: "UNSUPPORTED",
    }),
  );
  expect(f.mutations).toEqual([]);
});
