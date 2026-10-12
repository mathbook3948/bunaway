import assert from "node:assert/strict";
import { dlopen } from "bun:ffi";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type DesktopContext, defineApp } from "@bunaway/backend";
import type { WindowSpec } from "@bunaway/plugin-api/native";
import { windows, windowsPlugin } from "@bunaway/plugin-windows";
import type { HostContext, Policy } from "@bunaway/protocol";
import { runWindowsApp } from "#native/windows/bun/entry";
import { Windows } from "#native/windows/bun/win32";
import {
  centerInWorkArea,
  type WorkArea,
} from "#native/windows/bun/window-placement";
import { physicalPixels } from "#native/windows/bun/window-size";
import { bundleNativeWorker } from "../fixtures/native-worker.ts";
import { windowPermissions } from "../fixtures/window-permissions.ts";

assert.equal(process.platform, "win32");
const root =
  process.env.BUNAWAY_PLACEMENT_ROOT ?? resolve(import.meta.dir, "../..");
const output = resolve(root, "build/windows-initial-placement");
const assets = resolve(output, "assets");
const reportPath = resolve(output, "report.json");

if (!process.argv.includes("--child")) {
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
      } finally {
        native.destroy(hwnd);
      }
    }
    assert.throws(
      () =>
        native.validateCreation({
          width: 4096,
          height: 4096,
          minWidth: 4096,
          minHeight: 4096,
          preventOverflow: true,
        }),
      {
        code: "INVALID_ARGUMENT",
      },
    );
  } finally {
    native.dispose();
  }
  await writeFile(
    resolve(output, "display.json"),
    JSON.stringify({
      area,
      displays,
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
      `PASS initial placement: HWND + WebView2 startup, single/multiple create/recreate, preflight and declaration restoration (${displays} displays)`,
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
  }: {
    area: WorkArea;
    displays: number;
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
    {
      view: "single",
      title: "Placement single",
      home: "https://app.bunaway.local/index.html",
      visible: false,
      startup: false,
      window: {
        ...specSize,
        x: area.x + 40,
        y: area.y + 40,
        useContentSize: false,
      },
    },
    {
      view: "multiple",
      title: "Placement multiple",
      home: "https://app.bunaway.local/index.html",
      visible: false,
      startup: false,
      instances: "multiple",
      maxInstances: 2,
      profile: "isolated",
      window: {
        ...specSize,
        center: true,
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
  async function getByView(target: { view: string }) {
    return (
      (await windows.listInstances()).find(
        ({ viewId }) => viewId === target.view,
      ) ?? null
    );
  }
  async function checkCentered(target: { view: string; windowId?: string }) {
    await waitForDocument(target);
    const outer = await windows.getOuterBounds({
      ...target,
    });
    assert.deepEqual(
      {
        x: outer.x,
        y: outer.y,
      },
      centerInWorkArea(area, outer.width, outer.height),
    );
    assert.equal(await windows.isVisible(target), false);
  }
  async function waitForDocument(target: { view: string; windowId?: string }) {
    const deadline = Date.now() + 15_000;
    while ((await windows.getReadiness(target)).document !== "ready") {
      assert(Date.now() < deadline, "Placement document did not load.");
      await Bun.sleep(5);
    }
  }
  async function exercise() {
    const deadline = Date.now() + 15_000;
    while (
      (await getByView({
        view: "main",
      })) === null
    ) {
      assert(Date.now() < deadline, "Startup window did not arrive.");
      await Bun.sleep(5);
    }
    await checkCentered({
      view: "main",
    });
    await windows.create({
      view: "single",
    });
    const single = await getByView({
      view: "single",
    });
    assert(single);
    await waitForDocument({
      view: "single",
    });
    const declared = await windows.getOuterBounds({
      view: "single",
    });
    assert.equal(declared.x, area.x + 40);
    assert.equal(declared.y, area.y + 40);
    assert(Math.abs(declared.width - physicalPixels(600, declared.dpi)) <= 1);
    await windows.recreate({
      view: "single",
      options: {
        window: {
          x: null,
          y: null,
          center: true,
        },
      },
    });
    await checkCentered({
      view: "single",
    });
    const replacement = await getByView({
      view: "single",
    });
    assert(replacement);
    assert.notEqual(replacement.windowId, single.windowId);
    for (const window of [
      {
        x: null,
      },
      {
        center: true,
        x: 1,
        y: 1,
      },
      {
        minWidth: 4096,
        minHeight: 4096,
        preventOverflow: true,
      },
    ]) {
      await assert.rejects(
        windows.recreate({
          view: "single",
          options: {
            window,
          },
        }),
        {
          code: "INVALID_ARGUMENT",
        },
      );
      assert.equal(
        (
          await getByView({
            view: "single",
          })
        )?.windowId,
        replacement.windowId,
      );
    }
    await windows.recreate({
      view: "single",
    });
    const restored = await windows.getOuterBounds({
      view: "single",
    });
    assert.equal(restored.x, declared.x);
    assert.equal(restored.y, declared.y);
    assert.equal(restored.width, declared.width);
    const first = await windows.createInstance({
      view: "multiple",
    });
    await checkCentered({
      view: "multiple",
      windowId: first.windowId,
    });
    const position = {
      x: area.x - 80,
      y: area.y - 60,
    };
    const second = await windows.createInstance({
      view: "multiple",
      options: {
        window: {
          ...position,
          center: false,
          useContentSize: false,
        },
      },
    });
    const target = {
      view: "multiple",
      windowId: second.windowId,
    };
    const positioned = await windows.getOuterBounds({
      ...target,
    });
    await waitForDocument(target);
    assert.equal(positioned.x, position.x);
    assert.equal(positioned.y, position.y);
    for (const window of [
      {
        x: 0,
      },
      {
        width: 4096,
        height: 4096,
        minWidth: 4096,
        minHeight: 4096,
        preventOverflow: true,
      },
    ]) {
      await assert.rejects(
        windows.recreateInstance({
          ...target,
          options: {
            window,
          },
        }),
        {
          code: "INVALID_ARGUMENT",
        },
      );
      assert.equal(
        (
          await windows.getById({
            windowId: target.windowId,
          })
        )?.windowId,
        target.windowId,
      );
    }
    const fitted = await windows.recreateInstance({
      ...target,
      options: {
        window: {
          width: 4096,
          height: 4096,
          center: false,
          x: area.x + area.width - 10,
          y: area.y + area.height - 10,
          preventOverflow: true,
        },
      },
    });
    const fittedTarget = {
      view: "multiple",
      windowId: fitted.windowId,
    };
    await waitForDocument(fittedTarget);
    const bounds = await windows.getOuterBounds({
      ...fittedTarget,
    });
    assert(bounds.x >= area.x && bounds.y >= area.y);
    assert(bounds.x + bounds.width <= area.x + area.width);
    assert(bounds.y + bounds.height <= area.y + area.height);
    assert.equal(
      (
        await windows.getById({
          windowId: first.windowId,
        })
      )?.windowId,
      first.windowId,
    );
    const reset = await windows.recreateInstance(fittedTarget);
    await checkCentered({
      view: "multiple",
      windowId: reset.windowId,
    });
    assert.equal(JSON.stringify(specs), original);
    await writeFile(
      reportPath,
      JSON.stringify({
        pass: true,
        displays,
        dpi: bounds.dpi,
        area,
        bounds,
      }),
    );
    completed = true;
    await windows.destroy({
      view: "multiple",
      windowId: reset.windowId,
    });
    await windows.destroy({
      view: "multiple",
      windowId: first.windowId,
    });
    await windows.destroy({
      view: "single",
    });
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
      windowsPlugin,
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
