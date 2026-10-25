import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { checkHresult } from "@bunaway/plugin/win32";
import { checkCallbacks, disposeCom } from "#native/windows/bun/com";
import { WebView } from "#native/windows/bun/webview";
import { Windows } from "#native/windows/bun/win32";
import { disposeWin32Bindings, ole } from "#native/windows/bun/win32-bindings";
import { waitFor } from "../fixtures/deadlines.ts";

assert.equal(process.platform, "win32");
const root = resolve(import.meta.dir, "../..");
const output = resolve(root, "build/windows-webview-audio");
const assets = resolve(output, "assets");
await mkdir(resolve(assets, "web"), {
  recursive: true,
});
await writeFile(
  resolve(assets, "web/index.html"),
  "<!doctype html><title>Audio controls</title><h1>Silent regression document</h1>",
);
checkHresult(ole.symbols.CoInitializeEx(null, 2), "CoInitializeEx(STA)");
const windows = new Windows(() => {});
let hwnd = 0n;
let webview: WebView | undefined;
let documents = 0;
const audioEvents: {
  muted: boolean;
  playing: boolean;
}[] = [];
let browserVersion = "";
let verified = false;
try {
  hwnd = windows.create("Audio controls regression", 640, 480, () => {});
  webview = new WebView(
    hwnd,
    {
      view: "main",
      title: "Audio controls regression",
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
      message() {},
      revoke() {},
      sameDocument() {},
      close() {
        throw new Error("Unexpected close before cleanup");
      },
      ready() {
        webview?.navigate();
      },
      audioChanged(state) {
        audioEvents.push(state);
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
  assert.throws(() => webview?.getAudioState(), {
    code: "BUSY",
  });
  assert.throws(() => webview?.setAudioMuted(true), {
    code: "BUSY",
  });
  const waitForDocument = async (count: number) => {
    const deadline = Date.now() + 30_000;
    while (documents < count) {
      assert(Date.now() < deadline, "Audio regression document did not load");
      windows.pump();
      checkCallbacks();
      if (webview?.failure) {
        throw webview.failure;
      }
      await Bun.sleep(5);
    }
  };
  const waitForAudioEvents = async (count: number) => {
    await waitFor(
      () => {
        windows.pump();
        checkCallbacks();
        return audioEvents.length >= count;
      },
      {
        deadline: "childStep",
        what: "the audio change event",
        intervalMs: 5,
      },
    );
    // Let a duplicate or stray event arrive before the count is trusted.
    for (let i = 0; i < 20; i++) {
      windows.pump();
      checkCallbacks();
      await Bun.sleep(5);
    }
    assert.equal(audioEvents.length, count);
  };
  await waitForDocument(1);
  assert.deepEqual(audioEvents, []);
  assert.deepEqual(webview.getAudioState(), {
    muted: false,
    playing: false,
  });
  webview.setAudioMuted(true);
  webview.setAudioMuted(true);
  assert.deepEqual(webview.getAudioState(), {
    muted: true,
    playing: false,
  });
  await waitForAudioEvents(1);
  assert.deepEqual(audioEvents[0], {
    muted: true,
    playing: false,
  });
  webview.navigate();
  await waitForDocument(2);
  await waitForAudioEvents(1);
  assert.deepEqual(webview.getAudioState(), {
    muted: true,
    playing: false,
  });
  webview.setAudioMuted(false);
  assert.deepEqual(webview.getAudioState(), {
    muted: false,
    playing: false,
  });
  await waitForAudioEvents(2);
  assert.deepEqual(audioEvents[1], {
    muted: false,
    playing: false,
  });
  verified = true;
} finally {
  if (webview) {
    webview.requestClose();
    assert.throws(() => webview?.getAudioState(), {
      code: "INVALID_ARGUMENT",
    });
    assert.throws(() => webview?.setAudioMuted(false), {
      code: "INVALID_ARGUMENT",
    });
    const deadline = Date.now() + 35_000;
    while (!webview.detach()) {
      assert(Date.now() < deadline, "Audio controller did not detach");
      windows.pump();
      await Bun.sleep(5);
    }
    windows.destroy(hwnd);
    hwnd = 0n;
    while (!webview.finish()) {
      assert(
        Date.now() < deadline,
        "Audio controller retained native resources",
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
  resolve(root, "build/windows-webview-audio-results.json"),
  JSON.stringify(
    {
      pass: true,
      browserVersion,
      mutedPersistedAcrossNavigation: true,
      audioChangeEvents: audioEvents.length,
      nativeCleanup: true,
      hardwarePlaybackVerified: false,
    },
    null,
    2,
  ),
);
console.log(
  "PASS actual WebView2 mute state, navigation persistence, readiness/closed guards and native cleanup; hardware playback remains unverified",
);
