import { dlopen, ptr } from "bun:ffi";
import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import dialog from "@bunaway/plugin-dialog";
import type { HostResponse, JsonValue } from "@bunaway/protocol";
import { Channel, type UIConfig } from "#native/windows/bun/channel";
import { bundleUIPluginFixture } from "../fixtures/native-worker.ts";

// The main test thread can observe and dismiss real modal dialogs while the UI STA is in Show.
test.skipIf(process.platform !== "win32")(
  "real UI STA file dialogs select paths, serialize, cancel and drain on shutdown",
  async () => {
    // Runner TEMP can contain an 8.3 alias; shell items return the resolved long path.
    const root = await realpath(
      await mkdtemp(resolve(tmpdir(), "bunaway-dialog-")),
    );
    let worker: Worker | undefined;
    let channel: Channel | undefined;
    let cleaned = false;
    let fatal: unknown;
    const pending = new Map<string, (response: HostResponse) => void>();
    const native = dlopen("user32.dll", {
      FindWindowW: {
        args: [
          "ptr",
          "ptr",
        ],
        returns: "u64",
      },
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
      IsWindowEnabled: {
        args: [
          "u64",
        ],
        returns: "i32",
      },
      GetDlgItem: {
        args: [
          "u64",
          "i32",
        ],
        returns: "u64",
      },
      PostMessageW: {
        args: [
          "u64",
          "u32",
          "u64",
          "i64",
        ],
        returns: "i32",
      },
    });
    const titles: string[] = [];
    const find = (title: string) => {
      const text = Buffer.from(`${title}\0`, "utf16le");
      return BigInt(native.symbols.FindWindowW(null, ptr(text)));
    };
    const buttonState = (title: string, id: 1 | 2) => {
      const hwnd = find(title);
      const control = BigInt(native.symbols.GetDlgItem(hwnd, id));
      return {
        hwnd: hwnd.toString(),
        dialogVisible: native.symbols.IsWindowVisible(hwnd),
        control: control.toString(),
        visible: native.symbols.IsWindowVisible(control),
        enabled: native.symbols.IsWindowEnabled(control),
      };
    };
    const until = async (condition: () => boolean, stage: string) => {
      const deadline = Date.now() + 10000;
      while (!condition()) {
        if (fatal || Date.now() > deadline) {
          throw new Error(`Dialog ${stage} failed: ${JSON.stringify(fatal)}`);
        }
        await Bun.sleep(10);
      }
    };
    try {
      const nativePath = resolve(
        import.meta.dir,
        "../../plugins/dialog/dist/native/windows.js",
      );
      await bundleUIPluginFixture(
        root,
        [
          {
            name: "dialog",
            version: dialog._definition.version,
            native: dialog._definition.native,
            thread: "ui",
          },
        ],
        `import plugin from ${JSON.stringify(nativePath)};
export const pluginImports = { dialog: { operations: async () => ({ createOperations(environment) {
  const services = environment.dialogs;
  return plugin._definition.nativePlatforms.windows.create({ ...environment, dialogs: {
    ...services,
    createWindow(receive) {
      let timerReported = false;
      return services.createWindow((...args) => {
        if (args[0] === 0x0113 && !timerReported) {
          timerReported = true;
          console.log(JSON.stringify({ event: "dialog-native-timer" }));
        }
        receive(...args);
      });
    },
    watchCancellation(requestId) {
      const watcher = services.watchCancellation(requestId);
      let reported = false;
      return { ...watcher, cancelled() {
        const value = watcher.cancelled();
        if (value && !reported) {
          reported = true;
          console.log(JSON.stringify({ event: "dialog-native-cancel-observed", requestId }));
        }
        return value;
      }};
    }
  }});
} }) } };`,
      );
      const config: UIConfig = {
        runtime: {
          id: "dialog-native",
          generation: crypto.randomUUID(),
        },
        backendContext: "backend" as UIConfig["backendContext"],
        windows: [],
        assets: root,
        dataRoot: root,
        loader: "",
        desktop: {
          closeBehavior: "keep-alive",
        },
        plugins: [
          dialog._definition,
        ],
        policy: {
          version: 1,
          views: [],
          backend: {
            permissions: [
              "dialog.openFile",
              "dialog.saveFile",
              "dialog.selectFolder",
            ],
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
      let ready = false;
      channel = new Channel(
        worker,
        config.runtime,
        "main",
        (packet) => {
          if (packet.kind === "ready") {
            ready = true;
          } else if (packet.kind === "prepare") {
            channel?.notify({
              kind: "grant",
              context: packet.context,
              requestId: packet.requestId,
              allowed: true,
            });
          } else if (packet.kind === "host-response") {
            pending.get(packet.requestId)?.(packet.response);
            pending.delete(packet.requestId);
          } else if (packet.kind === "cleaned") {
            cleaned = true;
          } else if (packet.kind === "fatal") {
            fatal = packet.error;
          }
        },
        (error) => {
          fatal = error;
        },
      );
      await until(() => ready, "startup");
      const invoke = (
        operation: string,
        payload: Record<string, JsonValue> = {},
      ) => {
        const requestId = crypto.randomUUID();
        const title = `Bunaway dialog ${requestId}`;
        titles.push(title);
        let response: HostResponse | undefined;
        pending.set(requestId, (value) => {
          response = value;
        });
        channel?.notify({
          kind: "operation",
          context: config.backendContext,
          requestId,
          source: "backend",
          call: {
            operation,
            payload: {
              ...payload,
              title,
            },
          },
        });
        return {
          title,
          requestId,
          result: async () => {
            try {
              await until(
                () => response !== undefined,
                `${operation} response`,
              );
            } catch (error) {
              throw new Error(
                `${operation} button state: ${JSON.stringify(buttonState(title, 1))}`,
                {
                  cause: error,
                },
              );
            }
            return response;
          },
        };
      };
      const dismiss = async (title: string, button: 1 | 2) => {
        await until(() => {
          const state = buttonState(title, button);
          return (
            state.control !== "0" &&
            state.dialogVisible !== 0 &&
            state.visible !== 0 &&
            state.enabled !== 0
          );
        }, `button ${button} readiness`);
        const hwnd = find(title);
        const control = BigInt(native.symbols.GetDlgItem(hwnd, button));
        expect(hwnd).not.toBe(0n);
        expect(control).not.toBe(0n);
        // BN_CLICKED carries the control HWND. A null lParam represents a menu command.
        // Native notification injection tests real OK/Cancel processing, not physical input.
        expect(
          native.symbols.PostMessageW(hwnd, 0x0111, BigInt(button), control),
        ).not.toBe(0);
        return hwnd;
      };
      const selected = resolve(root, "한글-open.txt");
      await writeFile(selected, "selected without granting storage permission");
      const open = invoke("dialog.openFile", {
        defaultDirectory: root,
        defaultFileName: "한글-open.txt",
        filters: [
          {
            name: "Text",
            extensions: [
              "txt",
            ],
          },
        ],
      });
      await dismiss(open.title, 1);
      expect(await open.result()).toEqual({
        kind: "result",
        payload: {
          cancelled: false,
          paths: [
            selected,
          ],
        },
      });
      const folder = invoke("dialog.selectFolder", {
        defaultDirectory: root,
      });
      await dismiss(folder.title, 1);
      expect(await folder.result()).toEqual({
        kind: "result",
        payload: {
          cancelled: false,
          paths: [
            root,
          ],
        },
      });
      const save = invoke("dialog.saveFile", {
        defaultDirectory: root,
        defaultFileName: "new-file",
        defaultExtension: "txt",
        filters: [
          {
            name: "Text",
            extensions: [
              "txt",
            ],
          },
        ],
      });
      await dismiss(save.title, 1);
      const savePath = resolve(root, "new-file.txt");
      expect(await save.result()).toEqual({
        kind: "result",
        payload: {
          cancelled: false,
          paths: [
            savePath,
          ],
        },
      });
      expect(await Bun.file(savePath).exists()).toBe(false);

      const first = invoke("dialog.openFile");
      await until(() => find(first.title) !== 0n, "first modal");
      const second = invoke("dialog.saveFile");
      await Bun.sleep(100);
      expect(find(second.title)).toBe(0n);
      await dismiss(first.title, 2);
      expect(await first.result()).toEqual({
        kind: "result",
        payload: {
          cancelled: true,
        },
      });
      await dismiss(second.title, 2);
      expect(await second.result()).toEqual({
        kind: "result",
        payload: {
          cancelled: true,
        },
      });

      const cancelled = invoke("dialog.openFile");
      await until(() => find(cancelled.title) !== 0n, "abort modal");
      const cancelledHwnd = find(cancelled.title);
      let cancelAcknowledged = false;
      void channel
        .send({
          kind: "cancel",
          context: config.backendContext,
          requestId: cancelled.requestId,
        })
        .then(() => {
          cancelAcknowledged = true;
        })
        .catch((error) => {
          fatal = error;
        });
      try {
        await until(
          () => native.symbols.IsWindow(cancelledHwnd) === 0,
          "abort cleanup",
        );
      } catch (error) {
        const state = {
          time: Date.now(),
          cancelAcknowledged,
          visible: native.symbols.IsWindowVisible(cancelledHwnd),
          current: buttonState(cancelled.title, 2),
        };
        // Unwind the failed modal call so deferred callback failures can be reported.
        await dismiss(cancelled.title, 2);
        await until(() => cancelAcknowledged || !!fatal, "failed abort unwind");
        console.error("Dialog abort after modal unwind", {
          fatal,
        });
        throw new Error(`Dialog abort state: ${JSON.stringify(state)}`, {
          cause: error,
        });
      }
      // Cancelled host responses are suppressed; a following call proves the STA and adapter recovered.
      pending.delete(cancelled.requestId);
      const recovered = invoke("dialog.openFile");
      await dismiss(recovered.title, 2);
      expect(await recovered.result()).toEqual({
        kind: "result",
        payload: {
          cancelled: true,
        },
      });

      const shutdown = invoke("dialog.selectFolder");
      await until(() => find(shutdown.title) !== 0n, "shutdown modal");
      const shutdownHwnd = find(shutdown.title);
      channel.notify({
        kind: "shutdown",
      });
      await until(() => cleaned, "shutdown cleanup");
      expect(await exited).toBe(0);
      expect(fatal).toBeUndefined();
      expect(native.symbols.IsWindow(shutdownHwnd)).toBe(0);
    } finally {
      for (const title of titles) {
        const hwnd = find(title);
        if (hwnd) {
          native.symbols.PostMessageW(
            hwnd,
            0x0111,
            2n,
            BigInt(native.symbols.GetDlgItem(hwnd, 2)),
          );
        }
      }
      channel?.close();
      await worker?.terminate();
      native.close();
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
    }
  },
  90000,
);
