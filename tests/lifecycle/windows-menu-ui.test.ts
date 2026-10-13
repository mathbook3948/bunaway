import { dlopen } from "bun:ffi";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { menuPlugin } from "@bunaway/plugin-menu";
import type { HostResponse, JsonValue } from "@bunaway/protocol";
import { Channel, type UIConfig } from "#native/windows/bun/channel";
import { bundleUIPluginFixture } from "../fixtures/native-worker.ts";

test.skipIf(process.platform !== "win32")(
  "real windowless tray accepts menu mutations and releases its hidden HWND on shutdown",
  async () => {
    const root = await mkdtemp(resolve(tmpdir(), "bunaway-menu-ui-"));
    let worker: Worker | undefined;
    let channel: Channel | undefined;
    let trayHwnd = 0n;
    let cleaned = false;
    let fatal: unknown;
    const pending = new Map<string, (value: HostResponse) => void>();
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
      const operationPath = resolve(
        import.meta.dir,
        "../../plugins/menu/dist/native/windows.js",
      );
      await bundleUIPluginFixture(
        root,
        [
          {
            name: menuPlugin.name,
            version: menuPlugin.version,
            native: menuPlugin.native,
            execution: "ui",
          },
        ],
        `import plugin from ${JSON.stringify(operationPath)};
const createOperations = plugin.nativePlatforms.windows.create;
export const pluginImports = { menu: { operations: async () => ({ createOperations }) } };`,
      );
      const config: UIConfig = {
        runtime: {
          id: "menu-native",
          generation: crypto.randomUUID(),
        },
        backendContext: "backend" as UIConfig["backendContext"],
        windows: [],
        assets: root,
        dataRoot: root,
        loader: "",
        desktop: {
          closeBehavior: "keep-alive",
          tray: {
            tooltip: "Native menu regression",
          },
        },
        plugins: [
          menuPlugin,
        ],
        policy: {
          version: 1,
          views: [],
          backend: {
            permissions: menuPlugin.native.operations.map(
              (operation) => operation.name,
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
            fatal = packet.error;
            readyResolve();
          } else if (
            packet.kind === "diagnostic" &&
            packet.event === "tray-created" &&
            packet.fields &&
            typeof packet.fields === "object" &&
            !Array.isArray(packet.fields) &&
            typeof packet.fields.hwnd === "string"
          ) {
            trayHwnd = BigInt(packet.fields.hwnd);
          }
        },
        (error) => {
          fatal = error;
          readyResolve();
        },
      );
      await Promise.race([
        ready,
        Bun.sleep(10000).then(() => {
          throw new Error("Menu UI startup timed out.");
        }),
      ]);
      expect(fatal).toBeUndefined();
      expect(trayHwnd).not.toBe(0n);
      expect(native.symbols.IsWindowVisible(trayHwnd)).toBe(0);
      const invoke = (operation: string, payload: JsonValue) =>
        new Promise<JsonValue>((done, reject) => {
          const requestId = crypto.randomUUID();
          const timeout = setTimeout(() => {
            pending.delete(requestId);
            reject(
              new Error(
                `Menu call timed out: ${operation}; worker failure: ${String(fatal)}`,
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
              operation,
              payload,
            },
          });
        });
      await invoke("menu.create", {
        menuId: "tray",
        items: [
          {
            id: "a",
            type: "checkbox",
            label: "한글 😀",
            checked: true,
          },
        ],
      });
      await invoke("menu.setTrayMenu", {
        menuId: "tray",
      });
      expect(await invoke("menu.getTrayMenu", null)).toBe("tray");
      await invoke("menu.updateItem", {
        menuId: "tray",
        itemId: "a",
        changes: {
          checked: false,
          label: "Changed",
        },
      });
      expect(
        await invoke("menu.get", {
          menuId: "tray",
        }),
      ).toMatchObject({
        items: [
          {
            id: "a",
            checked: false,
            label: "Changed",
          },
        ],
      });
      // Await the MessagePort response before entering Bun's rejection matcher on Windows.
      const rejected = await invoke("menu.replace", {
        menuId: "tray",
        items: [
          {
            id: "duplicate",
            type: "item",
            label: "A",
          },
          {
            id: "duplicate",
            type: "item",
            label: "B",
          },
        ],
      }).then(
        () => {
          throw new Error("Invalid menu replacement unexpectedly succeeded.");
        },
        (error: unknown) => error,
      );
      expect(rejected).toMatchObject({
        code: "INVALID_ARGUMENT",
      });
      expect(
        await invoke("menu.get", {
          menuId: "tray",
        }),
      ).toMatchObject({
        items: [
          {
            id: "a",
          },
        ],
      });
      expect(
        await invoke("menu.remove", {
          menuId: "tray",
        }),
      ).toBe(true);
      expect(await invoke("menu.getTrayMenu", null)).toBeNull();
      expect(native.symbols.IsWindow(trayHwnd)).toBe(1);
      expect(native.symbols.IsWindowVisible(trayHwnd)).toBe(0);
      await channel.send({
        kind: "operation",
        context: config.backendContext,
        requestId: "pending-click",
        source: "backend",
        call: {
          operation: "menu.waitForClick",
          payload: null,
        },
      });
      expect(await invoke("menu.list", null)).toEqual([]);
      channel.notify({
        kind: "shutdown",
      });
      expect(
        await Promise.race([
          exited,
          Bun.sleep(10000).then(() => {
            throw new Error("Menu UI cleanup timed out.");
          }),
        ]),
      ).toBe(0);
      expect(cleaned).toBe(true);
      expect(fatal).toBeUndefined();
      expect(native.symbols.IsWindow(trayHwnd)).toBe(0);
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
