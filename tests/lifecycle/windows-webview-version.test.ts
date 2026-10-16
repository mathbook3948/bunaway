import { expect, test } from "bun:test";
import { resolve } from "node:path";

const loader = resolve(
  import.meta.dir,
  "../../build/cache/webview2/sdk/build/native/x64/WebView2Loader.dll",
);

test.skipIf(process.platform !== "win32")(
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
