import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const loader = resolve(
  import.meta.dir,
  "../../build/cache/webview2/sdk/build/native/x64/WebView2Loader.dll",
);

// The Check job runs this file without the pinned SDK; the native job builds the loader first.
test.skipIf(process.platform !== "win32" || !existsSync(loader))(
  "the pinned WebView2Loader reports the installed runtime version and releases its handles",
  async () => {
    const { readWebViewVersion } = await import(
      "#native/windows/bun/webview-version"
    );
    const pattern = /^\d+\.\d+\.\d+\.\d+( .+)?$/;
    // Repeated calls prove the loader and ole32 handles can be reopened after close.
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(readWebViewVersion(loader)).toMatch(pattern);
    }
  },
);

test.skipIf(process.platform !== "win32")(
  "a missing loader rejects with a diagnosable error instead of returning a version",
  async () => {
    const { readWebViewVersion } = await import(
      "#native/windows/bun/webview-version"
    );
    expect(() =>
      readWebViewVersion(resolve(import.meta.dir, "missing.dll")),
    ).toThrow();
  },
);

// Pure comparison logic: runs on every platform.
test("runtime versions compare by numeric part and unreadable shapes never count as old", async () => {
  const {
    MIN_WEBVIEW_RUNTIME_VERSION,
    isWebViewVersionTooOld,
    webViewVersionTooOldMessage,
  } = await import("#native/windows/bun/webview-version-check");
  const minimum = "97.0.1072.54";
  expect(isWebViewVersionTooOld("97.0.1072.53", minimum)).toBe(true);
  expect(isWebViewVersionTooOld("96.9.9999.99", minimum)).toBe(true);
  expect(isWebViewVersionTooOld("97.0.1072.54", minimum)).toBe(false);
  // Numeric, not lexical: "100" sorts before "54" as text.
  expect(isWebViewVersionTooOld("97.0.1072.100", minimum)).toBe(false);
  expect(isWebViewVersionTooOld("120.0.2210.91", minimum)).toBe(false);
  expect(isWebViewVersionTooOld("100.0.1.1", minimum)).toBe(false);
  expect(isWebViewVersionTooOld("120.0.2210.91 canary", minimum)).toBe(false);
  expect(isWebViewVersionTooOld("96.0.1.1 canary", minimum)).toBe(true);
  expect(isWebViewVersionTooOld("unknown", minimum)).toBe(false);
  expect(isWebViewVersionTooOld("1.2.3", minimum)).toBe(false);
  expect(isWebViewVersionTooOld("1.0.0.0")).toBe(true);
  expect(MIN_WEBVIEW_RUNTIME_VERSION).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
  const message = webViewVersionTooOldMessage("90.0.1.1");
  expect(message).toContain("90.0.1.1");
  expect(message).toContain(MIN_WEBVIEW_RUNTIME_VERSION);
  expect(message).not.toMatch(/[A-Za-z]:\\|\.dll/);
});

test("the startup check separates unreadable, too old, unparsable and supported versions", async () => {
  const { checkWebViewVersion } = await import(
    "#native/windows/bun/webview-version-check"
  );
  const unavailable = checkWebViewVersion(() => {
    throw new Error("no runtime");
  });
  expect(unavailable).toEqual({
    version: null,
    event: {
      name: "webview-version-unavailable",
      fields: {
        message: "no runtime",
      },
    },
  });
  const old = checkWebViewVersion(() => "90.0.1.1");
  expect(old.version).toBe("90.0.1.1");
  expect(old.event).toEqual({
    name: "webview-version-too-old",
    fields: {
      version: "90.0.1.1",
    },
  });
  expect(old.failure?.message).toContain("90.0.1.1");
  expect(old.failure).toBeInstanceOf(Error);
  const unparsable = checkWebViewVersion(() => "unknown");
  expect(unparsable.version).toBe("unknown");
  expect(unparsable.event?.name).toBe("webview-version-unparsable");
  expect(unparsable.failure).toBeUndefined();
  expect(checkWebViewVersion(() => "999.0.0.0")).toEqual({
    version: "999.0.0.0",
  });
});
