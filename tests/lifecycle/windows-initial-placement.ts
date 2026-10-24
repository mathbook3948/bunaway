import { dlopen } from "bun:ffi";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type DesktopContext, defineApp } from "@bunaway/backend";
import {
  MAX_WINDOW_DIMENSION,
  type WindowSpec,
} from "@bunaway/plugin-api/native";
import windows from "@bunaway/plugin-windows";
import type { HostContext, Policy } from "@bunaway/protocol";
import { runWindowsApp } from "#native/windows/bun/entry";
import { Windows } from "#native/windows/bun/win32";
import {
  centerInWorkArea,
  type WorkArea,
} from "#native/windows/bun/window-placement";
import { physicalPixels } from "#native/windows/bun/window-size";
import { testAppMetadata } from "../fixtures/app-info.ts";
import { bundleNativeWorker } from "../fixtures/native-worker.ts";
import { windowPermissions } from "../fixtures/window-permissions.ts";

assert.equal(process.platform, "win32");
const root =
  process.env.BUNAWAY_PLACEMENT_ROOT ?? resolve(import.meta.dir, "../..");
const output = resolve(root, "build/windows-initial-placement");
const assets = resolve(output, "assets");
const reportPath = resolve(
  root,
  "build/windows-initial-placement-results.json",
);
const minimumWindow = {
  width: MAX_WINDOW_DIMENSION,
  height: MAX_WINDOW_DIMENSION,
  minWidth: MAX_WINDOW_DIMENSION,
  minHeight: MAX_WINDOW_DIMENSION,
  preventOverflow: true,
};

if (!process.argv.includes("--child")) {
  await rm(assets, {
    recursive: true,
    force: true,
  });
  await rm(reportPath, {
    force: true,
  });
  await mkdir(resolve(assets, "web"), {
    recursive: true,
  });
  await writeFile(
    resolve(assets, "web/index.html"),
    "<!doctype html><title>Initial placement</title>",
  );
  const native = new Windows(() => {});
  const area = native.getWorkArea(native.getPlacementMonitor());
  const metrics = dlopen("user32.dll", {
    GetSystemMetrics: {
      args: [
        "i32",
      ],
      returns: "i32",
    },
  });
  const SM_CMONITORS = 80;
  const displays = metrics.symbols.GetSystemMetrics(SM_CMONITORS);
  metrics.close();
  let minimumFits = false;
  try {
    for (const useContentSize of [
      true,
      false,
    ]) {
      const spec = {
        width: 600,
        height: 400,
        useContentSize,
        center: true,
        preventOverflow: true,
      };
      native.validateCreation(spec);
      const hwnd = native.create(
        "Initial placement HWND",
        600,
        400,
        () => {},
        false,
        spec,
      );
      try {
        const outer = native.getBounds(hwnd, "outer");
        const center = centerInWorkArea(area, outer.width, outer.height);
        assert.equal(outer.x, center.x);
        assert.equal(outer.y, center.y);
        const measured = native.getBounds(
          hwnd,
          useContentSize ? "content" : "outer",
        );
        assert(
          Math.abs(measured.width - physicalPixels(600, measured.dpi)) <= 1,
        );
        assert(
          Math.abs(measured.height - physicalPixels(400, measured.dpi)) <= 1,
        );
        assert.equal(native.isVisible(hwnd), false);
        assert.equal(native.failure, undefined);
        if (useContentSize) {
          // A large work area can fit even the largest supported minimum.
          // Measure the current DPI and frame instead of assuming rejection.
          const minimumWidth =
            physicalPixels(MAX_WINDOW_DIMENSION, measured.dpi) +
            outer.width -
            measured.width;
          const minimumHeight =
            physicalPixels(MAX_WINDOW_DIMENSION, measured.dpi) +
            outer.height -
            measured.height;
          minimumFits =
            minimumWidth <= area.width && minimumHeight <= area.height;
        }
      } finally {
        native.destroy(hwnd);
      }
    }
    // Exercise native default tracking limits with a rectangle larger than
    // typical CI displays. Initial content/outer sizing must remain centered.
    for (const useContentSize of [
      true,
      false,
    ]) {
      const spec = {
        width: MAX_WINDOW_DIMENSION,
        height: MAX_WINDOW_DIMENSION,
        center: true,
        useContentSize,
      };
      const hwnd = native.create(
        "Oversized initial placement HWND",
        spec.width,
        spec.height,
        () => {},
        false,
        spec,
      );
      try {
        const outer = native.getBounds(hwnd, "outer");
        const center = centerInWorkArea(area, outer.width, outer.height);
        assert.equal(outer.x, center.x);
        assert.equal(outer.y, center.y);
        const measured = native.getBounds(
          hwnd,
          useContentSize ? "content" : "outer",
        );
        assert(
          Math.abs(measured.width - physicalPixels(spec.width, measured.dpi)) <=
            1,
        );
        assert(
          Math.abs(
            measured.height - physicalPixels(spec.height, measured.dpi),
          ) <= 1,
        );
        assert.equal(native.isVisible(hwnd), false);
        assert.equal(native.failure, undefined);
      } finally {
        native.destroy(hwnd);
      }
    }
    if (minimumFits) {
      assert.doesNotThrow(() => native.validateCreation(minimumWindow));
    } else {
      assert.throws(() => native.validateCreation(minimumWindow), {
        code: "INVALID_ARGUMENT",
      });
    }
  } finally {
    native.dispose();
  }
  await writeFile(
    resolve(output, "display.json"),
    JSON.stringify({
      area,
      displays,
      minimumFits,
    }),
  );
  const entry = await bundleNativeWorker(
    "windows-initial-placement",
    assets,
    import.meta.path,
  );
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      fileURLToPath(entry),
      "--child",
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        BUNAWAY_PLACEMENT_ROOT: root,
      },
    },
  );
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  const timer = setTimeout(() => child.kill(), 90_000);
  try {
    assert.equal(await child.exited, 0, `${await stderr}\n${await stdout}`);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    assert.equal(report.pass, true);
    console.log(
      `PASS initial placement: HWND + WebView2 startup, create/recreate overrides, preflight and declaration restoration (${displays} displays)`,
    );
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) {
      child.kill();
    }
    await child.exited;
  }
} else {
  const {
    area,
    displays,
    minimumFits,
  }: {
    area: WorkArea;
    displays: number;
    minimumFits: boolean;
  } = JSON.parse(await readFile(resolve(output, "display.json"), "utf8"));
  const specSize = {
    width: 600,
    height: 400,
  };
  const specs: WindowSpec[] = [
    {
      view: "main",
      title: "Placement startup",
      home: "https://app.bunaway.local/index.html",
      visible: false,
      window: {
        ...specSize,
        center: true,
        preventOverflow: true,
      },
    },
  ];
  const original = JSON.stringify(specs);
  const policy: Policy = {
    version: 1,
    backend: {
      permissions: windowPermissions(),
    },
    views: specs.map(({ view }) => ({
      id: view,
      origins: [
        "https://app.bunaway.local",
      ],
      commands: [],
      events: [],
      host: {
        permissions: [],
      },
    })),
  };
  let task: Promise<void> | undefined;
  let desktop: DesktopContext | undefined;
  let failure: unknown;
  let completed = false;
  async function currentWindowId() {
    return (await windows.getReadiness()).windowId;
  }
  async function checkCentered() {
    await waitForDocument();
    const outer = await windows.getOuterBounds();
    assert.deepEqual(
      {
        x: outer.x,
        y: outer.y,
      },
      centerInWorkArea(area, outer.width, outer.height),
    );
    assert.equal(await windows.isVisible(), false);
  }
  async function waitForDocument() {
    const deadline = Date.now() + 15_000;
    while ((await windows.getReadiness()).document !== "ready") {
      assert(Date.now() < deadline, "Placement document did not load.");
      await Bun.sleep(5);
    }
  }
  async function checkMinimumContent() {
    await waitForDocument();
    const content = await windows.getContentBounds();
    assert.equal(
      content.width,
      physicalPixels(MAX_WINDOW_DIMENSION, content.dpi),
    );
    assert.equal(
      content.height,
      physicalPixels(MAX_WINDOW_DIMENSION, content.dpi),
    );
  }
  async function exercise() {
    const deadline = Date.now() + 15_000;
    while (!(await windows.isOpen())) {
      assert(Date.now() < deadline, "Startup window did not arrive.");
      await Bun.sleep(5);
    }
    await checkCentered();
    const startup = await currentWindowId();
    await windows.recreate({
      options: {
        window: {
          center: false,
          x: area.x + 40,
          y: area.y + 40,
          useContentSize: false,
        },
      },
    });
    await waitForDocument();
    const declared = await windows.getOuterBounds({});
    assert.equal(declared.x, area.x + 40);
    assert.equal(declared.y, area.y + 40);
    assert(Math.abs(declared.width - physicalPixels(600, declared.dpi)) <= 1);
    assert.notEqual(await currentWindowId(), startup);
    await windows.recreate({
      options: {
        window: {
          x: null,
          y: null,
          center: true,
        },
      },
    });
    await checkCentered();
    const replacement = await currentWindowId();
    // The declaration is centered, so a position without `center: false` conflicts with it.
    for (const window of [
      {
        x: 0,
      },
      {
        center: true,
        x: 1,
        y: 1,
      },
      ...(minimumFits
        ? []
        : [
            minimumWindow,
          ]),
    ]) {
      await assert.rejects(
        windows.recreate({
          options: {
            window,
          },
        }),
        {
          code: "INVALID_ARGUMENT",
        },
      );
      assert.equal(await currentWindowId(), replacement);
    }
    if (minimumFits) {
      await windows.recreate({
        options: {
          window: minimumWindow,
        },
      });
      await checkMinimumContent();
    }
    await windows.recreate({});
    await checkCentered();
    const position = {
      x: area.x - 80,
      y: area.y - 60,
    };
    await windows.recreate({
      options: {
        window: {
          ...position,
          center: false,
          useContentSize: false,
          // The declaration keeps the window inside the work area; this position is outside it.
          preventOverflow: false,
        },
      },
    });
    await waitForDocument();
    const positioned = await windows.getOuterBounds();
    assert.equal(positioned.x, position.x);
    assert.equal(positioned.y, position.y);
    const positionedId = await currentWindowId();
    for (const window of [
      {
        x: 0,
      },
      ...(minimumFits
        ? []
        : [
            minimumWindow,
          ]),
    ]) {
      await assert.rejects(
        windows.recreate({
          options: {
            window,
          },
        }),
        {
          code: "INVALID_ARGUMENT",
        },
      );
      assert.equal(await currentWindowId(), positionedId);
    }
    await windows.recreate({
      options: {
        window: {
          width: MAX_WINDOW_DIMENSION,
          height: MAX_WINDOW_DIMENSION,
          center: false,
          x: area.x + area.width - 10,
          y: area.y + area.height - 10,
          preventOverflow: true,
        },
      },
    });
    await waitForDocument();
    const bounds = await windows.getOuterBounds();
    assert(bounds.x >= area.x && bounds.y >= area.y);
    assert(bounds.x + bounds.width <= area.x + area.width);
    assert(bounds.y + bounds.height <= area.y + area.height);
    await windows.recreate({});
    await checkCentered();
    assert.equal(JSON.stringify(specs), original);
    await writeFile(
      reportPath,
      JSON.stringify({
        pass: true,
        displays,
        minimumFits,
        dpi: bounds.dpi,
        area,
        bounds,
      }),
    );
    completed = true;
    await windows.destroy();
    assert(desktop);
    await desktop.quit();
  }
  const app = defineApp({
    modules: [],
    desktop: {
      closeBehavior: "keep-alive",
      onOpen(_request, context) {
        desktop = context;
      },
    },
    plugins: [
      windows,
      {
        name: "initial-placement-test",
        version: "1.0.0",
        setup() {
          task = exercise().catch(async (error) => {
            if (
              completed &&
              error instanceof Error &&
              "code" in error &&
              error.code === "CANCELLED"
            ) {
              return;
            }
            failure = error;
            console.error(error);
            assert(desktop);
            await desktop.quit();
          });
        },
      },
    ],
    commands: {},
  });
  await runWindowsApp(
    app,
    {
      appMetadata: testAppMetadata,
      runtime: {
        id: "initial-placement",
        generation: crypto.randomUUID(),
      },
      backendContext: `backend-${crypto.randomUUID()}` as HostContext,
      policy,
      windows: specs,
      assets,
      dataRoot: resolve(output, `data-${process.pid}`),
      loader: resolve(
        root,
        "build/cache/webview2/sdk/build/native/x64/WebView2Loader.dll",
      ),
    },
    {
      argv: [],
      cwd: root,
    },
  );
  await task;
  if (failure) {
    throw failure;
  }
  assert(completed);
}
