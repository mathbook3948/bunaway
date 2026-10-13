import { dlopen } from "bun:ffi";
import { expect, test } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { globalShortcutPlugin } from "@bunaway/plugin-global-shortcut";
import { menuPlugin } from "@bunaway/plugin-menu";
import { trayPlugin } from "@bunaway/plugin-tray";
import type { HostResponse, JsonValue } from "@bunaway/protocol";
import { Channel, type UIConfig } from "#native/windows/bun/channel";
import { bundleUIPluginFixture } from "../fixtures/native-worker.ts";
import { trayIco } from "../fixtures/tray-icon.ts";

test.skipIf(process.platform !== "win32").each([
  false,
  true,
])(
  "packaged global shortcut SDK runs in the real windowless UI Worker and cleans its HWND (combined services: %s)",
  async (combined) => {
    const root = await mkdtemp(resolve(tmpdir(), "bunaway-shortcut-ui-"));
    const hwndPath = resolve(root, "hwnd.txt");
    const pending = new Map<string, (response: HostResponse) => void>();
    let worker: Worker | undefined;
    let channel: Channel | undefined;
    let failure: unknown;
    let cleaned = false;
    let trayHwnd = 0n;
    const native = dlopen("user32.dll", {
      IsWindow: {
        args: [
          "u64",
        ],
        returns: "i32",
      },
      IsWindowVisible: {
        args: [
          "u64",
        ],
        returns: "i32",
      },
    });
    try {
      const entrypoint = resolve(
        import.meta.dir,
        "../../plugins/global-shortcut/dist/native/windows.js",
      );
      const plugins = combined
        ? [
            globalShortcutPlugin,
            menuPlugin,
            trayPlugin,
          ]
        : [
            globalShortcutPlugin,
          ];
      const extraImports = combined
        ? `import menu from ${JSON.stringify(resolve(import.meta.dir, "../../plugins/menu/dist/native/windows.js"))};
import tray from ${JSON.stringify(resolve(import.meta.dir, "../../plugins/tray/dist/native/windows.js"))};`
        : "";
      const extraFactories = combined
        ? `, menu: { operations: async () => ({ createOperations: menu.nativePlatforms.windows.create }) },
tray: { operations: async () => ({ createOperations: tray.nativePlatforms.windows.create }) }`
        : "";
      await bundleUIPluginFixture(
        root,
        plugins.map((plugin) => ({
          name: plugin.name,
          version: plugin.version,
          native: plugin.native,
          execution: "ui",
        })),
        `
import plugin from ${JSON.stringify(entrypoint)};
import { writeFileSync } from "node:fs";
${extraImports}
export const pluginImports = { globalShortcut: { operations: async () => ({ createOperations(environment) {
  const services = environment.shortcuts;
  return plugin.nativePlatforms.windows.create({ ...environment, shortcuts: { ...services,
    createWindow(receive) { const hwnd = services.createWindow(receive); writeFileSync(${JSON.stringify(hwndPath)}, hwnd.toString()); return hwnd; },
  } });
} }) } ${extraFactories} };`,
      );
      const config: UIConfig = {
        runtime: {
          id: "shortcut-native",
          generation: crypto.randomUUID(),
        },
        backendContext: "backend" as UIConfig["backendContext"],
        windows: [],
        assets: root,
        dataRoot: root,
        loader: "",
        desktop: {
          closeBehavior: "keep-alive",
          ...(combined
            ? {
                tray: {
                  tooltip: "Combined services",
                },
              }
            : {}),
        },
        plugins,
        policy: {
          version: 1,
          views: [],
          backend: {
            permissions: plugins.flatMap((plugin) =>
              plugin.native.operations.map((operation) => operation.name),
            ),
          },
        },
      };
      worker = new Worker(pathToFileURL(resolve(root, "ui.js")), {
        workerData: config,
      });
      const exited = new Promise<number>((done, reject) => {
        worker?.once("exit", done);
        worker?.once("error", reject);
      });
      let readyResolve = () => {};
      const ready = new Promise<void>((done) => {
        readyResolve = done;
      });
      channel = new Channel(
        worker,
        config.runtime,
        "main",
        (packet) => {
          if (packet.kind === "ready") {
            readyResolve();
          } else if (packet.kind === "prepare") {
            channel?.notify({
              kind: "grant",
              context: packet.context,
              requestId: packet.requestId,
              allowed: true,
            });
          } else if (packet.kind === "host-response") {
            pending.get(packet.requestId)?.(packet.response);
          } else if (packet.kind === "cleaned") {
            cleaned = true;
          } else if (packet.kind === "fatal") {
            failure = packet.error;
            readyResolve();
          } else if (
            packet.kind === "diagnostic" &&
            packet.event === "tray-created" &&
            typeof packet.fields.hwnd === "string"
          ) {
            trayHwnd = BigInt(packet.fields.hwnd);
          }
        },
        (error) => {
          failure = error;
          readyResolve();
        },
      );
      await Promise.race([
        ready,
        Bun.sleep(10000).then(() => {
          throw new Error("Shortcut worker startup timed out.");
        }),
      ]);
      expect(failure).toBeUndefined();
      const invoke = (
        operation: string,
        payload: JsonValue,
        plugin: "globalShortcut" | "menu" | "tray" = "globalShortcut",
      ) =>
        new Promise<JsonValue>((done, reject) => {
          const requestId = crypto.randomUUID();
          const timeout = setTimeout(() => {
            pending.delete(requestId);
            reject(
              new Error(
                `Shortcut call timed out: ${operation}; worker failure: ${String(failure)}`,
              ),
            );
          }, 5000);
          pending.set(requestId, (response) => {
            clearTimeout(timeout);
            pending.delete(requestId);
            if (response.kind === "result") {
              done(response.payload);
            } else {
              reject(response.error);
            }
          });
          channel?.notify({
            kind: "operation",
            context: config.backendContext,
            requestId,
            source: "backend",
            call: {
              operation: `${plugin}.${operation}`,
              payload,
            },
          });
        });
      const shortcut = {
        key: "F22",
        modifiers: [
          "Control",
          "Alt",
          "Shift",
        ],
      };
      await invoke("register", shortcut);
      const hwnd = BigInt(await readFile(hwndPath, "utf8"));
      expect(native.symbols.IsWindow(hwnd)).toBe(1);
      expect(native.symbols.IsWindowVisible(hwnd)).toBe(0);
      if (combined) {
        expect(trayHwnd).not.toBe(0n);
        expect(trayHwnd).not.toBe(hwnd);
        expect(native.symbols.IsWindow(trayHwnd)).toBe(1);
        expect(native.symbols.IsWindowVisible(trayHwnd)).toBe(0);
        await invoke(
          "create",
          {
            menuId: "combined",
            items: [
              {
                id: "open",
                type: "item",
                label: "Combined services",
              },
            ],
          },
          "menu",
        );
        await invoke(
          "setTrayMenu",
          {
            menuId: "combined",
          },
          "menu",
        );
        await invoke(
          "setTooltip",
          {
            tooltip: "Menu and shortcut active",
          },
          "tray",
        );
        await invoke(
          "setIcon",
          {
            ico: trayIco().toString("base64"),
          },
          "tray",
        );
        expect(await invoke("getTrayMenu", null, "menu")).toBe("combined");
        expect(await invoke("get", null, "tray")).toMatchObject({
          tooltip: "Menu and shortcut active",
          icon: "custom",
        });
      }
      expect(await invoke("isRegistered", shortcut)).toBe(true);
      const rejected = await invoke("register", shortcut).then(
        () => {
          throw new Error("Duplicate registration unexpectedly succeeded.");
        },
        (error: unknown) => error,
      );
      expect(rejected).toMatchObject({
        code: "BUSY",
      });
      await invoke("setSuspended", {
        suspended: true,
      });
      expect(await invoke("isSuspended", null)).toBe(true);
      expect(await invoke("isRegistered", shortcut)).toBe(true);
      await invoke("setSuspended", {
        suspended: false,
      });
      await channel.send({
        kind: "operation",
        context: config.backendContext,
        requestId: "pending-press",
        source: "backend",
        call: {
          operation: "globalShortcut.waitForPress",
          payload: null,
        },
      });
      expect(await invoke("list", null)).toEqual([
        shortcut,
      ]);
      if (combined) {
        for (const operation of [
          "menu.waitForClick",
          "tray.waitForEvent",
        ]) {
          await channel.send({
            kind: "operation",
            context: config.backendContext,
            requestId: `pending-${operation}`,
            source: "backend",
            call: {
              operation,
              payload: null,
            },
          });
        }
        // A completed call fences both additional wait registrations before shutdown.
        expect(await invoke("getTrayMenu", null, "menu")).toBe("combined");
      }
      channel.notify({
        kind: "shutdown",
      });
      expect(
        await Promise.race([
          exited,
          Bun.sleep(10000).then(() => {
            throw new Error("Shortcut worker cleanup timed out.");
          }),
        ]),
      ).toBe(0);
      expect(cleaned).toBe(true);
      expect(failure).toBeUndefined();
      expect(native.symbols.IsWindow(hwnd)).toBe(0);
      if (combined) {
        expect(native.symbols.IsWindow(trayHwnd)).toBe(0);
        console.log(
          "PASS real UI Worker menu/tray/shortcut coexistence, live resources, pending waits and HWND cleanup",
        );
      }
    } finally {
      channel?.close();
      await worker?.terminate();
      native.close();
      await rm(root, {
        recursive: true,
        force: true,
      });
    }
  },
  30000,
);
