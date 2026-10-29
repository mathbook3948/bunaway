import { dlopen, ptr } from "bun:ffi";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { checkHresult } from "@bunaway/plugin/win32";
import type { JsonValue } from "@bunaway/protocol";
import { AppearanceWindows } from "#native/windows/bun/appearance";
import { checkCallbacks, disposeCom } from "#native/windows/bun/com";
import { SystemEvents } from "#native/windows/bun/system-events";
import { WebView } from "#native/windows/bun/webview";
import { Windows } from "#native/windows/bun/win32";
import { disposeWin32Bindings, ole } from "#native/windows/bun/win32-bindings";
import { createAppearanceController } from "#plugins/appearance/src/platforms/windows-controller";
import { initialize } from "#plugins/appearance/src/platforms/windows-preferences";
import { waitFor } from "../fixtures/deadlines.ts";

assert.equal(process.platform, "win32");
const SPI_GETHIGHCONTRAST = 0x42;
const SPI_SETHIGHCONTRAST = 0x43;
/** Broadcast the change to running windows; no SPIF_UPDATEINIFILE, so nothing is persisted. */
const SPIF_SENDCHANGE = 0x2;
const HCF_HIGHCONTRASTON = 0x1;
const HCF_AVAILABLE = 0x2;
const HIGHCONTRASTW_SIZE = 16;
const SCHEME_BYTES = 1024;
/** The page's own body background, which forced colors override. */
const PAGE_BACKGROUND = "rgb(255, 0, 255)";
const DEFAULT_SCHEME = "High Contrast Black";
const root = resolve(import.meta.dir, "../..");
const output = resolve(root, "build/windows-webview-high-contrast");
const assets = resolve(output, "assets");
await mkdir(resolve(assets, "web"), {
  recursive: true,
});
// The body sets its own background; forced colors replace it with the system window color.
await writeFile(
  resolve(assets, "web/index.html"),
  `<!doctype html><title>Forced colors</title>
  <body style="background-color: ${PAGE_BACKGROUND}"><h1>Forced colors</h1>
  <script>
    const query = matchMedia("(forced-colors: active)");
    const report = (kind) => chrome.webview.postMessage({
      kind,
      forced: query.matches,
      background: getComputedStyle(document.body).backgroundColor,
    });
    query.addEventListener("change", () => report("change"));
    addEventListener("load", () => report("load"));
    // The computed colors can settle after the media query flips, so report when they change.
    let last = getComputedStyle(document.body).backgroundColor;
    setInterval(() => {
      const now = getComputedStyle(document.body).backgroundColor;
      if (now !== last) {
        last = now;
        report("style");
      }
    }, 25);
  </script>`,
);
const user = dlopen("user32.dll", {
  SystemParametersInfoW: {
    args: [
      "u32",
      "u32",
      "ptr",
      "u32",
    ],
    returns: "i32",
  },
});

const dwm = dlopen("dwmapi.dll", {
  DwmGetColorizationColor: {
    args: [
      "ptr",
      "ptr",
    ],
    returns: "i32",
  },
});
/** The accent query that appearance.get depends on; it fails while DWM composition is unavailable. */
function accentQueryWorks(): boolean {
  const color = Buffer.alloc(4);
  const opaque = Buffer.alloc(4);
  return dwm.symbols.DwmGetColorizationColor(ptr(color), ptr(opaque)) >= 0;
}

type HighContrast = {
  flags: number;
  scheme: string;
};

/** HIGHCONTRASTW { cbSize, dwFlags, lpszDefaultScheme }; the scheme buffer outlives the call. */
function readHighContrast(): HighContrast {
  const scheme = Buffer.alloc(SCHEME_BYTES);
  const info = Buffer.alloc(HIGHCONTRASTW_SIZE);
  info.writeUInt32LE(HIGHCONTRASTW_SIZE);
  info.writeBigUInt64LE(BigInt(ptr(scheme)), 8);
  assert.notEqual(
    user.symbols.SystemParametersInfoW(
      SPI_GETHIGHCONTRAST,
      HIGHCONTRASTW_SIZE,
      ptr(info),
      0,
    ),
    0,
    "SPI_GETHIGHCONTRAST",
  );
  let end = 0;
  while (end + 1 < SCHEME_BYTES && scheme.readUInt16LE(end) !== 0) {
    end += 2;
  }
  return {
    flags: info.readUInt32LE(4),
    scheme: scheme.toString("utf16le", 0, end),
  };
}

/** Returns whether the system accepted the new state. */
function writeHighContrast(value: HighContrast): boolean {
  const scheme = Buffer.from(`${value.scheme}\0`, "utf16le");
  const info = Buffer.alloc(HIGHCONTRASTW_SIZE);
  info.writeUInt32LE(HIGHCONTRASTW_SIZE);
  info.writeUInt32LE(value.flags, 4);
  info.writeBigUInt64LE(BigInt(ptr(scheme)), 8);
  return (
    user.symbols.SystemParametersInfoW(
      SPI_SETHIGHCONTRAST,
      HIGHCONTRASTW_SIZE,
      ptr(info),
      SPIF_SENDCHANGE,
    ) !== 0
  );
}

type Report = {
  kind: string;
  forced: boolean;
  background: string;
};
type PublishedPreferences = {
  highContrast?: boolean;
  forcedColors?: boolean;
};

checkHresult(ole.symbols.CoInitializeEx(null, 2), "CoInitializeEx(STA)");
const windows = new Windows(() => {});
const service = new AppearanceWindows();
const reader = initialize();
const published: {
  event: string;
  payload: JsonValue;
}[] = [];
const systemEvents = new SystemEvents({
  open: (receive) => {
    const owner = windows.create(
      "Bunaway high contrast notifications",
      200,
      200,
      receive,
      false,
    );
    return () => windows.destroy(owner);
  },
  sessions: () => {},
  publish: (event, payload) => {
    published.push({
      event,
      payload,
    });
  },
  report: (error) => failures.push(error),
});
const controller = createAppearanceController(reader, {
  appearance: service,
  systemEvents,
});
const original = readHighContrast();
let hwnd = 0n;
let webview: WebView | undefined;
let documents = 0;
let browserVersion = "";
let verified = false;
let skipped: string | undefined;
let changed = false;
const reports: Report[] = [];
const measured: Record<string, unknown> = {};
const failures: unknown[] = [];
const pump = (done: () => boolean, what: string) =>
  waitFor(
    () => {
      windows.pump();
      systemEvents.flush();
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
/** Wait for a report after `count` that matches, which proves the page observed the new state. */
const reportAfter = async (
  count: number,
  what: string,
  matches: (report: Report) => boolean,
) => {
  await pump(() => reports.slice(count).some(matches), what);
  return reports.slice(count).find(matches);
};
const appearanceChanges = () =>
  published.filter((entry) => entry.event === "appearance.changed");
/** `#rrggbb` as the `rgb(r, g, b)` text a page reports. */
const asRgb = (hex: string) =>
  `rgb(${[
    1,
    3,
    5,
  ]
    .map((at) => Number.parseInt(hex.slice(at, at + 2), 16))
    .join(", ")})`;
try {
  hwnd = windows.create("Forced colors regression", 640, 480, () => {});
  service.attach("main", hwnd);
  webview = new WebView(
    hwnd,
    {
      view: "main",
      title: "Forced colors regression",
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
      },
    },
  );
  await pump(() => documents >= 1 && reports.length >= 1, "first document");
  measured.original = original;
  if (original.flags & HCF_HIGHCONTRASTON) {
    // The session already shows high contrast; changing it would not prove the transition.
    skipped = "already-high-contrast";
  } else {
    assert.equal(reader.read().highContrast, false);
    assert.equal(reports[0]?.kind, "load");
    assert.equal(reports[0]?.forced, false, "forced-colors before the change");
    const changesBefore = appearanceChanges().length;
    const reportsBefore = reports.length;
    changed = true;
    const accepted = writeHighContrast({
      flags: original.flags | HCF_HIGHCONTRASTON | HCF_AVAILABLE,
      scheme: original.scheme || DEFAULT_SCHEME,
    });
    const afterSet = readHighContrast();
    measured.accepted = accepted;
    measured.afterSet = afterSet;
    if (!accepted || !(afterSet.flags & HCF_HIGHCONTRASTON)) {
      // The runner refused the setting, so there is nothing to compare the page and the plugin with.
      skipped = "runner-rejected-high-contrast";
    } else {
      const preferences = reader.read();
      assert.equal(preferences.highContrast, true);
      assert.equal(preferences.forcedColors, true);
      measured.window = preferences.colors.window;
      const windowColor = asRgb(preferences.colors.window);
      // The page's own report, not the host's state, proves what the document saw.
      const firstForced = await reportAfter(
        reportsBefore,
        "forced-colors active",
        (report) => report.forced,
      );
      // Recorded so the documentation states what the first report showed, not an assumption.
      measured.firstForcedBackground = firstForced?.background;
      await reportAfter(
        reportsBefore,
        "forced colors replace the page background with the window color",
        (report) => report.forced && report.background === windowColor,
      );
      await pump(
        () => appearanceChanges().length > changesBefore,
        "appearance.changed for high contrast",
      );
      const latest = appearanceChanges().at(-1)
        ?.payload as PublishedPreferences;
      assert.equal(latest.highContrast, true);
      assert.equal(latest.forcedColors, true);
      measured.changesOnEnable = appearanceChanges().length - changesBefore;
      // Turning it off returns both the page and the plugin to the normal state.
      const offReports = reports.length;
      const offChanges = appearanceChanges().length;
      assert.equal(writeHighContrast(original), true);
      await reportAfter(
        offReports,
        "forced-colors reset with the page's own background",
        (report) => !report.forced && report.background === PAGE_BACKGROUND,
      );
      await pump(
        () => appearanceChanges().length > offChanges,
        "appearance.changed for the restore",
      );
      const restored = appearanceChanges().at(-1)
        ?.payload as PublishedPreferences;
      assert.equal(restored.highContrast, false);
      assert.equal(restored.forcedColors, false);
      measured.changesOnDisable = appearanceChanges().length - offChanges;
    }
  }
  verified = true;
} catch (error) {
  failures.push(error);
} finally {
  // Put the system setting back first: a stuck teardown below must not leave the runner in high contrast.
  if (changed) {
    try {
      assert.equal(writeHighContrast(original), true, "restore high contrast");
      assert.equal(
        readHighContrast().flags & HCF_HIGHCONTRASTON,
        0,
        "restored flags",
      );
      // Later tests in this job query the accent color, so record whether DWM recovered.
      const started = Date.now();
      measured.accentQueryAfterRestore = accentQueryWorks();
      if (!measured.accentQueryAfterRestore) {
        try {
          await waitFor(() => accentQueryWorks() || undefined, {
            deadline: "nativeFixture",
            what: "accent color query after restoring high contrast",
            intervalMs: 100,
          });
        } catch (error) {
          failures.push(error);
        }
        measured.accentRecoveredAfterMs = Date.now() - started;
      }
    } catch (error) {
      failures.push(
        new Error(
          `Restoring the original high contrast setting failed: ${error}`,
        ),
      );
    }
  }
  try {
    if (webview) {
      webview.requestClose();
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
  } catch (error) {
    failures.push(error);
  }
  service.detach("main");
  controller.dispose();
  systemEvents.dispose();
  if (hwnd) {
    windows.destroy(hwnd);
  }
  disposeCom();
  windows.dispose();
  ole.symbols.CoUninitialize();
  user.close();
  dwm.close();
  disposeWin32Bindings();
}
if (failures.length) {
  console.log(`MEASURED ${JSON.stringify(measured)}`);
  throw failures.length === 1
    ? failures[0]
    : new AggregateError(failures, "High contrast regression failed.");
}
assert(verified);
await writeFile(
  resolve(root, "build/windows-webview-high-contrast-results.json"),
  JSON.stringify(
    {
      pass: true,
      contentVerified: skipped === undefined,
      browserVersion,
      skipped: skipped ?? null,
      measured,
    },
    null,
    2,
  ),
);
console.log(
  skipped
    ? `SKIP forced colors not verified (${skipped}); measured ${JSON.stringify(measured)}`
    : `PASS actual WebView2 forced-colors follows Windows high contrast and appearance reports it (${JSON.stringify(measured)})`,
);
