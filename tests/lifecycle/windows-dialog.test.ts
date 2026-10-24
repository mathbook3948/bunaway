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
import { testAppMetadata } from "../fixtures/app-info.ts";
import { bundleUIPluginFixture } from "../fixtures/native-worker.ts";

// Win32 and TaskDialog message and key constants used to drive real dialogs.
const WM_COMMAND = 0x0111;
const WM_KEYDOWN = 0x0100;
const VK_ESCAPE = 0x1b;
const VK_RETURN = 0x0d;
const TDM_CLICK_BUTTON = 0x0466;
const TDM_CLICK_VERIFICATION = 0x0471;
const IDOK = 1n;
const IDCANCEL = 2n;
// TaskDialog assigns custom button ids starting here, in button order.
const FIRST_CUSTOM_BUTTON_ID = 1000n;

// The main test thread can observe and dismiss real modal dialogs while the UI STA is in Show.
test.skipIf(process.platform !== "win32")(
  "real UI STA file dialogs select paths, serialize, cancel and drain on shutdown",
  async () => {
    // Shell can retain process-wide COM helpers after the UI STA has released its own references.
    // Isolate this fixture so later tests can still assert their initial apartment state.
    if (process.env.BUNAWAY_DIALOG_FIXTURE !== "1") {
      const child = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          "test",
          import.meta.path,
        ],
        {
          env: {
            ...process.env,
            BUNAWAY_DIALOG_FIXTURE: "1",
          },
          stdout: "pipe",
          stderr: "pipe",
          // Leave cleanup time inside the existing 90-second test deadline.
          timeout: 85000,
          killSignal: "SIGKILL",
        },
      );
      try {
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect(code, `${stdout}\n${stderr}`).toBe(0);
      } finally {
        if (child.exitCode === null) {
          child.kill();
          await child.exited;
        }
      }
      return;
    }
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
    const messageTitles = new Set<string>();
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
export const pluginImports = { dialog: { operations: async () => ({ createOperations: plugin._definition.nativePlatforms.windows.create }) } };`,
      );
      const config: UIConfig = {
        appMetadata: testAppMetadata,
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
              "dialog.showAbout",
              "dialog.showMessage",
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
        if (
          operation === "dialog.showMessage" ||
          operation === "dialog.showAbout"
        ) {
          messageTitles.add(title);
        }
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

      const unrelated = invoke("dialog.openFile");
      await until(() => find(unrelated.title) !== 0n, "unrelated cancel modal");
      channel.notify({
        kind: "cancel",
        context: "unrelated-context" as UIConfig["backendContext"],
        requestId: unrelated.requestId,
      });
      await Bun.sleep(100);
      expect(native.symbols.IsWindowVisible(find(unrelated.title))).not.toBe(0);
      await dismiss(unrelated.title, 2);
      expect(await unrelated.result()).toEqual({
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

      // Message dialogs (TaskDialog). Posted TDM_* messages are processed by the dialog's own loop.
      const openMessage = async (payload: Record<string, JsonValue>) => {
        const call = invoke("dialog.showMessage", {
          message: "Proceed?",
          ...payload,
        });
        await until(
          () => native.symbols.IsWindowVisible(find(call.title)) !== 0,
          "message dialog visibility",
        );
        return call;
      };
      const customButtons = [
        "Keep",
        "Delete",
        "Later",
      ];
      const clicked = await openMessage({
        buttons: customButtons,
        defaultButton: 1,
      });
      native.symbols.PostMessageW(
        find(clicked.title),
        TDM_CLICK_BUTTON,
        1002n,
        0n,
      );
      expect(await clicked.result()).toEqual({
        kind: "result",
        payload: {
          button: 2,
          checkboxChecked: false,
        },
      });
      const checked = await openMessage({
        buttons: customButtons,
        checkbox: {
          label: "Remember",
        },
      });
      const checkedHwnd = find(checked.title);
      native.symbols.PostMessageW(checkedHwnd, TDM_CLICK_VERIFICATION, 1n, 0n);
      native.symbols.PostMessageW(checkedHwnd, TDM_CLICK_BUTTON, 1001n, 0n);
      expect(await checked.result()).toEqual({
        kind: "result",
        payload: {
          button: 1,
          checkboxChecked: true,
        },
      });
      const escaped = await openMessage({
        buttons: customButtons,
        cancelButton: 0,
      });
      native.symbols.PostMessageW(find(escaped.title), WM_COMMAND, 2n, 0n);
      expect(await escaped.result()).toEqual({
        kind: "result",
        payload: {
          button: 0,
          checkboxChecked: false,
        },
      });
      // The About panel is a single-button TaskDialog that Escape dismisses.
      const about = invoke("dialog.showAbout", {
        name: "Demo",
        version: "1.2.3",
        copyright: "Copyright 2026",
      });
      await until(
        () => native.symbols.IsWindowVisible(find(about.title)) !== 0,
        "about panel visibility",
      );
      native.symbols.PostMessageW(find(about.title), WM_COMMAND, 2n, 0n);
      expect(await about.result()).toEqual({
        kind: "result",
        payload: {},
      });
      const abortedMessage = await openMessage({});
      const abortedHwnd = find(abortedMessage.title);
      void channel
        .send({
          kind: "cancel",
          context: config.backendContext,
          requestId: abortedMessage.requestId,
        })
        .catch((error) => {
          fatal = error;
        });
      await until(
        () => native.symbols.IsWindow(abortedHwnd) === 0,
        "message abort cleanup",
      );
      pending.delete(abortedMessage.requestId);
      // A following call proves the STA and adapter recovered. IDOK is the common OK button.
      const afterAbort = await openMessage({});
      native.symbols.PostMessageW(
        find(afterAbort.title),
        TDM_CLICK_BUTTON,
        1n,
        0n,
      );
      expect(await afterAbort.result()).toEqual({
        kind: "result",
        payload: {
          button: 0,
          checkboxChecked: false,
        },
      });
      // Without TDF_ALLOW_DIALOG_CANCELLATION (several buttons, no cancelButton), IDCANCEL is ignored.
      const uncancellable = await openMessage({
        buttons: customButtons,
      });
      const uncancellableHwnd = find(uncancellable.title);
      native.symbols.PostMessageW(uncancellableHwnd, WM_COMMAND, IDCANCEL, 0n);
      // The IDCANCEL above and the click below land in the same dialog thread queue and run FIFO.
      // Had IDCANCEL been accepted, the dialog would have closed with the cancel result before the
      // click, so the result would not be button 0. The result assertion is the actual check; the
      // brief sleep and IsWindow check only confirm the dialog is still open before clicking.
      await Bun.sleep(50);
      expect(native.symbols.IsWindow(uncancellableHwnd)).not.toBe(0);
      native.symbols.PostMessageW(
        uncancellableHwnd,
        TDM_CLICK_BUTTON,
        FIRST_CUSTOM_BUTTON_ID,
        0n,
      );
      expect(await uncancellable.result()).toEqual({
        kind: "result",
        payload: {
          button: 0,
          checkboxChecked: false,
        },
      });
      // Injected keyboard message processing, not physical input: the dialog loop's IsDialogMessage
      // translates Escape into IDCANCEL, which maps to the non-default cancel button.
      const escapeKey = await openMessage({
        buttons: customButtons,
        cancelButton: 2,
      });
      native.symbols.PostMessageW(
        find(escapeKey.title),
        WM_KEYDOWN,
        BigInt(VK_ESCAPE),
        0n,
      );
      expect(await escapeKey.result()).toEqual({
        kind: "result",
        payload: {
          button: 2,
          checkboxChecked: false,
        },
      });

      // Injected Enter: IsDialogMessage translates it into the default button's command.
      const enterKey = await openMessage({
        buttons: customButtons,
        cancelButton: 2,
        defaultButton: 1,
      });
      native.symbols.PostMessageW(
        find(enterKey.title),
        WM_KEYDOWN,
        BigInt(VK_RETURN),
        0n,
      );
      expect(await enterKey.result()).toEqual({
        kind: "result",
        payload: {
          button: 1,
          checkboxChecked: false,
        },
      });

      const shutdown = invoke("dialog.selectFolder");
      const queuedAtShutdown = invoke("dialog.openFile");
      await until(() => find(shutdown.title) !== 0n, "shutdown modal");
      expect(find(queuedAtShutdown.title)).toBe(0n);
      const shutdownHwnd = find(shutdown.title);
      channel.notify({
        kind: "shutdown",
      });
      await until(() => cleaned, "shutdown cleanup");
      expect(await exited).toBe(0);
      expect(fatal).toBeUndefined();
      expect(native.symbols.IsWindow(shutdownHwnd)).toBe(0);
      expect(find(queuedAtShutdown.title)).toBe(0n);
    } finally {
      for (const title of titles) {
        const hwnd = find(title);
        if (hwnd) {
          native.symbols.PostMessageW(
            hwnd,
            WM_COMMAND,
            IDCANCEL,
            BigInt(native.symbols.GetDlgItem(hwnd, 2)),
          );
          // Message dialogs without a cancel button ignore IDCANCEL, so also click the first custom
          // button and the common OK button to close multi-button and common-button dialogs.
          // TDM_* is a TaskDialog message (the same value means something else to file dialogs),
          // so it is sent only to message dialogs.
          if (messageTitles.has(title)) {
            native.symbols.PostMessageW(
              hwnd,
              TDM_CLICK_BUTTON,
              FIRST_CUSTOM_BUTTON_ID,
              0n,
            );
            native.symbols.PostMessageW(hwnd, TDM_CLICK_BUTTON, IDOK, 0n);
          }
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
