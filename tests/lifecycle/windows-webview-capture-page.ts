import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { inflateSync } from "node:zlib";
import { checkHresult } from "@bunaway/plugin/win32";
import {
  MAX_PAGE_CAPTURE_BYTES,
  type NativePageCapture,
  PAGE_CAPTURE_TIMEOUT_MS,
} from "@bunaway/plugin-api/native";
import { checkCallbacks, disposeCom } from "#native/windows/bun/com";
import { WebView } from "#native/windows/bun/webview";
import { Windows } from "#native/windows/bun/win32";
import { disposeWin32Bindings, ole } from "#native/windows/bun/win32-bindings";
import { deadline } from "../fixtures/deadlines.ts";

assert.equal(process.platform, "win32");
const root = resolve(import.meta.dir, "../..");
const assets = resolve(root, "build/windows-webview-capture-page/assets");

// The page is scrolled to 1500 px when it loads: red above the document offset 1700, blue below.
// A region cut from the visible page must therefore be red near its top and blue at 300 px, which
// differs from the colors at the same offsets of the unscrolled document (red throughout).
const SCROLL_OFFSET = 1500;
const RED_UNTIL = 1700;
const PAGE = `<!doctype html><title>Page capture</title>
<style>html,body{margin:0}#red{height:${RED_UNTIL}px;background:#ff0000}#blue{height:1500px;background:#0000ff}</style>
<div id="red"></div><div id="blue"></div>
<script>scrollTo(0,${SCROLL_OFFSET})</script>`;

await mkdir(resolve(assets, "web"), {
  recursive: true,
});
await writeFile(resolve(assets, "web/index.html"), PAGE);

/** Decode the pixel at (x, y) of an 8-bit RGB or RGBA non-interlaced PNG. */
function pngPixel(png: Buffer, x: number, y: number) {
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  assert.equal(png[24], 8, "PNG bit depth");
  const bytesPerPixel = (
    {
      2: 3,
      6: 4,
    } as Record<number, number>
  )[png[25] ?? 0];
  assert(bytesPerPixel, `PNG color type ${png[25]}`);
  assert.equal(png[28], 0, "PNG must not be interlaced");
  const data: Buffer[] = [];
  for (let offset = 8; offset < png.length; ) {
    const length = png.readUInt32BE(offset);
    if (png.toString("ascii", offset + 4, offset + 8) === "IDAT") {
      data.push(png.subarray(offset + 8, offset + 8 + length));
    }
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * bytesPerPixel;
  const pixels = Buffer.alloc(stride * height);
  for (let row = 0; row < height; row++) {
    const filter = raw[row * (stride + 1)] ?? 0;
    for (let column = 0; column < stride; column++) {
      const input = raw[row * (stride + 1) + 1 + column] ?? 0;
      const left: number =
        column >= bytesPerPixel
          ? (pixels[row * stride + column - bytesPerPixel] ?? 0)
          : 0;
      const up: number =
        row > 0 ? (pixels[(row - 1) * stride + column] ?? 0) : 0;
      const upLeft: number =
        row > 0 && column >= bytesPerPixel
          ? (pixels[(row - 1) * stride + column - bytesPerPixel] ?? 0)
          : 0;
      const paeth = (): number => {
        const estimate = left + up - upLeft;
        const fromLeft = Math.abs(estimate - left);
        const fromUp = Math.abs(estimate - up);
        const fromUpLeft = Math.abs(estimate - upLeft);
        if (fromLeft <= fromUp && fromLeft <= fromUpLeft) {
          return left;
        }
        return fromUp <= fromUpLeft ? up : upLeft;
      };
      const predictor: number | undefined = [
        0,
        left,
        up,
        (left + up) >> 1,
        paeth(),
      ][filter];
      assert(predictor !== undefined, `PNG filter ${filter}`);
      pixels[row * stride + column] = (input + predictor) & 0xff;
    }
  }
  const at = y * stride + x * bytesPerPixel;
  return {
    r: pixels[at],
    g: pixels[at + 1],
    b: pixels[at + 2],
  };
}

checkHresult(ole.symbols.CoInitializeEx(null, 2), "CoInitializeEx(STA)");
const windows = new Windows(() => {});
let hwnd = 0n;
let webview: WebView | undefined;
let documentReady = false;
let browserVersion = "";

/** Pump messages until the promise settles, so COM completions and timers can run. */
async function settled<T>(promise: Promise<T>, label: string) {
  let outcome: PromiseSettledResult<T> | undefined;
  void promise.then(
    (value) => {
      outcome = {
        status: "fulfilled",
        value,
      };
    },
    (reason) => {
      outcome = {
        status: "rejected",
        reason,
      };
    },
  );
  // The capture's own timeout fires first; this bound only catches a pump that stopped delivering.
  const limit = Date.now() + PAGE_CAPTURE_TIMEOUT_MS + deadline("childStep");
  while (!outcome) {
    assert(Date.now() < limit, `${label} did not settle`);
    windows.pump();
    checkCallbacks();
    if (webview?.failure) {
      throw webview.failure;
    }
    await Bun.sleep(5);
  }
  return outcome;
}

async function capture(
  options: Parameters<WebView["capturePage"]>[0],
  label: string,
): Promise<NativePageCapture> {
  assert(webview);
  const outcome = await settled(webview.capturePage(options), label);
  if (outcome.status === "rejected") {
    throw outcome.reason;
  }
  return outcome.value;
}

async function failure(
  options: Parameters<WebView["capturePage"]>[0],
  label: string,
) {
  assert(webview);
  const outcome = await settled(webview.capturePage(options), label);
  assert.equal(outcome.status, "rejected", `${label} must fail`);
  return outcome.status === "rejected" ? outcome.reason : undefined;
}

const results: Record<string, unknown> = {};
try {
  hwnd = windows.create("Page capture", 640, 480, () => {});
  webview = new WebView(
    hwnd,
    {
      view: "main",
      title: "Page capture",
      home: "https://app.bunaway.local/index.html",
      window: {
        width: 640,
        height: 480,
      },
    },
    assets,
    resolve(root, `build/windows-webview-capture-page/data-${process.pid}`),
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
  const loadLimit = Date.now() + deadline("nativeFixture");
  while (!documentReady) {
    assert(Date.now() < loadLimit, "Capture document did not become ready");
    windows.pump();
    checkCallbacks();
    if (webview.failure) {
      throw webview.failure;
    }
    await Bun.sleep(5);
  }
  windows.show(hwnd, true);

  // Whole visible page as PNG and as JPEG: encoded bytes, matching mime type and header size.
  const full = await capture(
    {
      format: "png",
      region: null,
    },
    "full png",
  );
  const fullPng = Buffer.from(full.data, "base64");
  assert.equal(full.mime, "image/png");
  assert.equal(fullPng.subarray(1, 4).toString("ascii"), "PNG");
  assert.equal(fullPng.readUInt32BE(16), full.width);
  assert.equal(fullPng.readUInt32BE(20), full.height);
  assert(fullPng.length <= MAX_PAGE_CAPTURE_BYTES);
  const jpeg = await capture(
    {
      format: "jpeg",
      region: null,
    },
    "full jpeg",
  );
  const jpegBytes = Buffer.from(jpeg.data, "base64");
  assert.equal(jpeg.mime, "image/jpeg");
  assert.deepEqual(
    [
      ...jpegBytes.subarray(0, 2),
    ],
    [
      0xff,
      0xd8,
    ],
  );
  assert.deepEqual(
    [
      jpeg.width,
      jpeg.height,
    ],
    [
      full.width,
      full.height,
    ],
  );

  // A region is measured from the visible page: its size scales with the page's pixel density.
  const small = await capture(
    {
      format: "png",
      region: {
        x: 10,
        y: 10,
        width: 100,
        height: 50,
      },
    },
    "region png",
  );
  const density = small.width / 100;
  assert(density >= 1, `pixel density ${density}`);
  assert(Math.abs(small.height - 50 * density) <= 1, "region height");
  assert(full.width >= small.width && full.height >= small.height);

  // The scroll offset is part of the region: near the top the page shows red, 300 px lower blue.
  const color = async (y: number) => {
    const image = await capture(
      {
        format: "png",
        region: {
          x: 10,
          y,
          width: 20,
          height: 20,
        },
      },
      `color at ${y}`,
    );
    return pngPixel(
      Buffer.from(image.data, "base64"),
      image.width >> 1,
      image.height >> 1,
    );
  };
  const top = await color(10);
  const lower = await color(300);
  assert.deepEqual(
    top,
    {
      r: 255,
      g: 0,
      b: 0,
    },
    "top of the scrolled page",
  );
  assert.deepEqual(
    lower,
    {
      r: 0,
      g: 0,
      b: 255,
    },
    "below the red band",
  );

  // A region cut at the page edge keeps the part inside; one entirely outside is refused.
  const edge = await capture(
    {
      format: "png",
      region: {
        x: 0,
        y: 0,
        width: 16384,
        height: 16384,
      },
    },
    "oversized region",
  );
  assert.deepEqual(
    [
      edge.width,
      edge.height,
    ],
    [
      full.width,
      full.height,
    ],
  );
  const outside = await failure(
    {
      format: "png",
      region: {
        x: 16000,
        y: 0,
        width: 10,
        height: 10,
      },
    },
    "outside region",
  );
  assert.equal(outside.code, "INVALID_ARGUMENT");

  // One capture at a time per view.
  const first = webview.capturePage({
    format: "png",
    region: null,
  });
  assert.throws(
    () =>
      webview?.capturePage({
        format: "png",
        region: null,
      }),
    /already running/,
  );
  const firstOutcome = await settled(first, "first of two");
  assert.equal(firstOutcome.status, "fulfilled");

  // Measure what a minimized and a hidden window produce; the call must end either way.
  const hiddenOutcomes: Record<string, unknown> = {};
  for (const [state, enter, leave] of [
    [
      "minimized",
      () => windows.minimize(hwnd),
      () => windows.restore(hwnd),
    ],
    [
      "hidden",
      () => windows.show(hwnd, false),
      () => windows.show(hwnd, true),
    ],
  ] as const) {
    enter();
    const startedAt = Date.now();
    const outcome = await settled(
      webview.capturePage({
        format: "png",
        region: null,
      }),
      `${state} capture`,
    );
    hiddenOutcomes[state] =
      outcome.status === "fulfilled"
        ? {
            result: "image",
            width: outcome.value.width,
            height: outcome.value.height,
            ms: Date.now() - startedAt,
          }
        : {
            result: "error",
            code: outcome.reason?.code,
            ms: Date.now() - startedAt,
          };
    leave();
  }

  // Closing the view rejects a capture that is still pending.
  const pending = webview.capturePage({
    format: "png",
    region: null,
  });
  webview.requestClose();
  const closed = await settled(pending, "capture during close");
  assert.equal(closed.status, "rejected");
  assert.equal(
    closed.status === "rejected" ? closed.reason?.code : undefined,
    "INVALID_ARGUMENT",
  );
  results.pass = true;
  results.browserVersion = browserVersion;
  results.fullPng = {
    width: full.width,
    height: full.height,
    bytes: fullPng.length,
  };
  results.fullJpegBytes = jpegBytes.length;
  results.pixelDensity = density;
  results.scrolledColors = {
    top,
    lower,
  };
  results.hiddenOutcomes = hiddenOutcomes;
} finally {
  if (webview) {
    webview.requestClose();
    const cleanupLimit = Date.now() + deadline("nativeFixture");
    while (!webview.detach()) {
      assert(Date.now() < cleanupLimit, "Capture controller did not detach");
      windows.pump();
      await Bun.sleep(5);
    }
    windows.destroy(hwnd);
    hwnd = 0n;
    while (!webview.finish()) {
      assert(
        Date.now() < cleanupLimit,
        "Page capture retained native resources after close",
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
await writeFile(
  resolve(root, "build/windows-webview-capture-page-results.json"),
  JSON.stringify(results, null, 2),
);
console.log(
  `PASS actual WebView2 page capture: png and jpeg headers, region size, scroll-relative region colors, single flight, close rejection and native cleanup; minimized and hidden outcomes: ${JSON.stringify(results.hiddenOutcomes)}`,
);
