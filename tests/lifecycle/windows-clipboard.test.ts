import { dlopen, ptr, toArrayBuffer } from "bun:ffi";
import { expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { bindCommandHost } from "@bunaway/plugin-api/host";
import clipboard from "@bunaway/plugin-clipboard";
import {
  BunawayError,
  type HostCall,
  type HostContext,
  type HostResponse,
  type JsonValue,
  NativeRegistry,
} from "@bunaway/protocol";
import { bindHostAPI } from "#core/host-api";
import { disposeAll } from "#native/host-api/bun/plugins";
import { Channel, type UIConfig } from "#native/windows/bun/channel";
import type { ClipboardItem } from "#plugins/clipboard/src/contract";
import {
  MAX_BINARY_BYTES,
  MAX_BOOKMARK_LENGTH,
  MAX_TEXT_LENGTH,
} from "#plugins/clipboard/src/contract";
import { createClipboard } from "#plugins/clipboard/src/platforms/windows-bindings";
import { bundleUIPluginFixture } from "../fixtures/native-worker.ts";

const PM_REMOVE = 1;
const GMEM_MOVEABLE = 0x0002;
const GMEM_ZEROINIT = 0x0040;
// Native writes are opt-in because the clipboard is shared with the user's desktop.
test.skipIf(
  process.platform !== "win32" || process.env.BUNAWAY_CLIPBOARD_NATIVE !== "1",
)(
  "public clipboard SDK round-trips through the Windows UI Worker and cancels occupied writes",
  async () => {
    const root = resolve(
      import.meta.dir,
      `../../build/windows-clipboard-${crypto.randomUUID()}`,
    );
    await mkdir(root, {
      recursive: true,
    });
    const owner = createClipboard();
    // Clipboard ownership notifications are synchronous window messages. The
    // parent also owns a fixture window, so pump it while the UI Worker runs.
    const pump = dlopen("user32.dll", {
      PeekMessageW: {
        args: [
          "ptr",
          "ptr",
          "u32",
          "u32",
          "u32",
        ],
        returns: "bool",
      },
      TranslateMessage: {
        args: [
          "ptr",
        ],
        returns: "bool",
      },
      DispatchMessageW: {
        args: [
          "ptr",
        ],
        returns: "i64",
      },
    });
    const message = Buffer.alloc(48);
    const pumping = setInterval(() => {
      while (pump.symbols.PeekMessageW(ptr(message), null, 0, 0, PM_REMOVE)) {
        pump.symbols.TranslateMessage(ptr(message));
        pump.symbols.DispatchMessageW(ptr(message));
      }
    }, 5);
    const registry = new NativeRegistry([
      clipboard._definition,
    ]);
    const permissions = {
      permissions: [
        ...registry.operations.keys(),
      ],
    };
    const contextId = "clipboard-native" as HostContext;
    const config: UIConfig = {
      runtime: {
        id: "clipboard-native",
        generation: "1",
      },
      policy: {
        version: 1,
        views: [],
        backend: permissions,
      },
      backendContext: contextId,
      windows: [],
      assets: root,
      dataRoot: root,
      loader: "",
      plugins: [
        clipboard._definition,
      ],
    };
    const pending = new Map<string, (response: HostResponse) => void>();
    let worker: Worker | undefined;
    let channel: Channel | undefined;
    let original: string | null = null;
    let captured = false;
    let cleaned = false;
    let fatal: unknown;
    let workerExitCode: number | undefined;
    let workerOutput = "";
    const packetTrace: string[] = [];
    async function restoreClipboard() {
      if (!captured) {
        return;
      }
      const deadline = Date.now() + 2000;
      while (!owner.open()) {
        if (Date.now() >= deadline) {
          throw new Error("Original clipboard text could not be restored.");
        }
        await Bun.sleep(10);
      }
      try {
        if (original === null) {
          owner.clear();
        } else {
          owner.write(original);
        }
      } finally {
        owner.close();
      }
    }
    try {
      const acquire = async () => {
        const deadline = Date.now() + 2000;
        while (!owner.open()) {
          if (Date.now() >= deadline) {
            throw new Error("Test clipboard acquisition timed out.");
          }
          await Bun.sleep(10);
        }
      };
      await acquire();
      try {
        original = owner.read();
        captured = true;
      } finally {
        owner.close();
      }
      const operationsPath = resolve(
        import.meta.dir,
        "../../plugins/clipboard/src/index.ts",
      );
      const disposedPath = resolve(root, "disposed.txt");
      await bundleUIPluginFixture(
        root,
        [
          {
            name: "clipboard",
            version: clipboard._definition.version,
            native: clipboard._definition.native,
            thread: "ui",
          },
        ],
        `
import definition from ${JSON.stringify(operationsPath)};
const createOperations = definition._definition.nativePlatforms.windows.create;
import { writeFileSync } from "node:fs";
export const pluginImports = { clipboard: { operations: async () => ({ createOperations(environment) {
  const adapter = createOperations(environment);
  // Keep the fixture's windowless UI host alive while the parent issues SDK calls.
  return { ...adapter, busy: () => true, async dispose() {
    await adapter.dispose(); writeFileSync(${JSON.stringify(disposedPath)}, "disposed");
  } };
} }) } };
`,
      );
      worker = new Worker(pathToFileURL(resolve(root, "ui.js")), {
        workerData: config,
        stdout: true,
        stderr: true,
      });
      const retainOutput = (bytes: Buffer) => {
        workerOutput = `${workerOutput}${bytes.toString()}`.slice(-16_384);
      };
      worker.stdout?.on("data", retainOutput);
      worker.stderr?.on("data", retainOutput);
      const exited = new Promise<number>((resolveExit, reject) => {
        worker?.once("exit", (code) => {
          workerExitCode = code;
          resolveExit(code);
        });
        worker?.once("error", (error) => {
          fatal = error;
          reject(error);
        });
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
          packetTrace.push(
            `${packet.kind}${"requestId" in packet ? `:${packet.requestId}` : ""}`,
          );
          if (packetTrace.length > 32) {
            packetTrace.shift();
          }
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
          }
        },
        (error) => {
          fatal = error;
          readyResolve();
        },
      );
      await Promise.race([
        ready,
        Bun.sleep(5000).then(() => {
          throw new Error("UI clipboard startup timed out.");
        }),
      ]);
      expect(fatal).toBeUndefined();
      const dispatch = (
        context: HostContext,
        call: HostCall,
        signal: AbortSignal,
      ): Promise<HostResponse> =>
        new Promise((done) => {
          const requestId = crypto.randomUUID();
          const aborted = () => {
            channel?.notify({
              kind: "cancel",
              context,
              requestId,
            });
            complete({
              kind: "error",
              error: {
                code: "CANCELLED",
                message: "Test call cancelled.",
              },
            });
          };
          const complete = (response: HostResponse) => {
            clearTimeout(timeout);
            pending.delete(requestId);
            signal.removeEventListener("abort", aborted);
            done(response);
          };
          const timeout = setTimeout(() => {
            // Retain the actual worker/channel failure instead of obscuring it behind a missing reply.
            console.error("Clipboard UI request timed out", {
              operation: call.operation,
              requestId,
              workerExitCode,
              cleaned,
              fatal:
                fatal instanceof Error
                  ? {
                      message: fatal.message,
                      stack: fatal.stack,
                    }
                  : fatal,
              packetTrace,
              workerOutput,
            });
            complete({
              kind: "error",
              error: {
                code: "TIMEOUT",
                message: `Native fixture timed out: ${call.operation}`,
              },
            });
          }, 5000);
          pending.set(requestId, complete);
          signal.addEventListener("abort", aborted, {
            once: true,
          });
          channel?.notify({
            kind: "operation",
            context,
            requestId,
            call,
            source: "backend",
          });
        });
      const invoke = async (
        run: () => Promise<JsonValue>,
        controller = new AbortController(),
      ) => {
        const host = bindHostAPI(
          contextId,
          controller.signal,
          (context, call) => dispatch(context, call, controller.signal),
          registry,
        );
        const command = bindCommandHost({
          input: {
            const: null,
          },
          // The real clipboard plugin validates each distinct result schema.
          output: {},
          run: (
            _input: unknown,
            _context: import("@bunaway/plugin-api").CommandContext,
          ) => run(),
        });
        return command.run(null, {
          signal: controller.signal,
          host,
          state: {
            get: () => undefined,
            set() {},
            delete: () => false,
          },
          events: {
            async emit() {},
          },
        });
      };
      for (const text of [
        "한글 😀\nsecond\r\nthird",
        "",
        "😀".repeat(MAX_TEXT_LENGTH),
      ]) {
        expect(
          await invoke(() =>
            clipboard.writeText({
              text,
            }),
          ),
        ).toBeNull();
        expect(await invoke(() => clipboard.readText(null))).toBe(text);
      }
      await invoke(() => clipboard.clear(null));
      expect(await invoke(() => clipboard.readText(null))).toBeNull();
      const image = {
        width: 2,
        height: 1,
        rgba: Buffer.from([
          255,
          0,
          0,
          128,
          0,
          255,
          0,
          255,
        ]).toString("base64"),
      };
      const items: ClipboardItem[] = [
        {
          format: "text/plain",
          data: "fallback 한글 😀",
        },
        {
          format: "text/html",
          data: "<p>한글 😀</p>",
        },
        {
          format: "text/rtf",
          data: "{\\rtf1 \\u54620?}",
        },
        {
          format: "application/x-bunaway-file-list",
          data: [
            "C:\\한글\\memo.txt",
            "\\\\server\\share\\memo.txt",
          ],
        },
        {
          format: "image/bmp",
          data: image,
        },
      ];
      await invoke(() =>
        clipboard.writeFormats({
          items,
        }),
      );
      expect(
        await invoke(() =>
          clipboard.readFormats({
            formats: items.map((item) => item.format),
          }),
        ),
      ).toEqual(items);
      expect(await invoke(() => clipboard.getFormats(null))).toEqual(
        items.map((item) => item.format),
      );
      expect(
        await invoke(() =>
          clipboard.hasFormat({
            format: "text/html",
          }),
        ),
      ).toBe(true);
      expect(await invoke(() => clipboard.readImage(null))).toEqual(image);
      await acquire();
      try {
        expect(owner.readImage()).toEqual(image);
        expect(owner.read()).toBe("fallback 한글 😀");
      } finally {
        owner.close();
      }
      await invoke(() => clipboard.writeImage(image));
      expect(await invoke(() => clipboard.readText(null))).toBeNull();
      expect(
        await invoke(() =>
          clipboard.hasFormat({
            format: "text/html",
          }),
        ),
      ).toBe(false);
      expect(
        await invoke(() =>
          clipboard.readFormats({
            formats: [
              "text/html",
              "image/bmp",
            ],
          }),
        ),
      ).toEqual([
        {
          format: "text/html",
          data: null,
        },
        {
          format: "image/bmp",
          data: image,
        },
      ]);
      const extended: ClipboardItem[] = [
        {
          format: "application/x-bunaway-bookmark",
          data: {
            url: "https://example.com/한글😀",
          },
        },
        {
          format: "application/x-bunaway-binary/native-fixture",
          data: "AP+A/w==",
        },
        {
          format: "text/plain",
          data: "URL fallback",
        },
      ];
      await invoke(() =>
        clipboard.writeFormats({
          items: extended,
        }),
      );
      expect(
        await invoke(() =>
          clipboard.readFormats({
            formats: extended.map((item) => item.format),
          }),
        ),
      ).toEqual(extended);
      expect(await invoke(() => clipboard.getFormats(null))).toEqual([
        "text/plain",
        "application/x-bunaway-bookmark",
      ]);
      await acquire();
      try {
        // A second owner resolves the same registered names and reads Windows-owned allocations.
        expect(owner.readFormats(extended.map((item) => item.format))).toEqual(
          extended,
        );
      } finally {
        owner.close();
      }
      for (const url of [
        "HTTPS://example.com/Path?Name=Value#Anchor",
        "HTTP://example.com/Path",
        "hTtPs://EXAMPLE.com/한글😀?a=%2F",
      ]) {
        const item: ClipboardItem = {
          format: "application/x-bunaway-bookmark",
          data: {
            url,
          },
        };
        await invoke(() =>
          clipboard.writeFormats({
            items: [
              item,
            ],
          }),
        );
        expect(
          await invoke(() =>
            clipboard.readFormats({
              formats: [
                item.format,
              ],
            }),
          ),
        ).toEqual([
          item,
        ]);
      }
      const bookmarkPrefix = "https://example.com/";
      const remainingBookmarkUnits =
        MAX_BOOKMARK_LENGTH - bookmarkPrefix.length;
      const maximumBookmarkURL = `${bookmarkPrefix}${"😀".repeat(Math.floor(remainingBookmarkUnits / 2))}${"x".repeat(remainingBookmarkUnits % 2)}`;
      const maximumBookmark: ClipboardItem = {
        format: "application/x-bunaway-bookmark",
        data: {
          url: maximumBookmarkURL,
        },
      };
      expect(maximumBookmarkURL.length).toBe(MAX_BOOKMARK_LENGTH);
      await invoke(() =>
        clipboard.writeFormats({
          items: [
            maximumBookmark,
          ],
        }),
      );
      expect(
        await invoke(() =>
          clipboard.readFormats({
            formats: [
              "application/x-bunaway-bookmark",
            ],
          }),
        ),
      ).toEqual([
        maximumBookmark,
      ]);
      for (const url of [
        `${maximumBookmarkURL}x`,
        `${bookmarkPrefix}${"😀".repeat(1024)}`,
      ]) {
        await expect(
          invoke(() =>
            clipboard.writeFormats({
              items: [
                {
                  format: "text/plain",
                  data: "must not replace the bookmark",
                },
                {
                  format: "application/x-bunaway-bookmark",
                  data: {
                    url,
                  },
                },
              ],
            }),
          ),
        ).rejects.toMatchObject({
          code: "INVALID_ARGUMENT",
        });
        expect(
          await invoke(() =>
            clipboard.readFormats({
              formats: [
                "application/x-bunaway-bookmark",
              ],
            }),
          ),
        ).toEqual([
          maximumBookmark,
        ]);
        expect(await invoke(() => clipboard.readText(null))).toBeNull();
      }
      for (const data of [
        "",
        Buffer.alloc(MAX_BINARY_BYTES, 255).toString("base64"),
      ]) {
        const items: ClipboardItem[] = [
          {
            format: "application/x-bunaway-binary/native-fixture",
            data,
          },
        ];
        await invoke(() =>
          clipboard.writeFormats({
            items,
          }),
        );
        expect(
          await invoke(() =>
            clipboard.readFormats({
              formats: [
                "application/x-bunaway-binary/native-fixture",
              ],
            }),
          ),
        ).toEqual(items);
      }
      // A custom, non-text format must produce null, without clearing its data.
      const user = dlopen("user32.dll", {
        RegisterClipboardFormatW: {
          args: [
            "ptr",
          ],
          returns: "u32",
        },
        SetClipboardData: {
          args: [
            "u32",
            "ptr",
          ],
          returns: "ptr",
        },
      });
      const kernel = dlopen("kernel32.dll", {
        GlobalAlloc: {
          args: [
            "u32",
            "u64",
          ],
          returns: "ptr",
        },
        GlobalLock: {
          args: [
            "ptr",
          ],
          returns: "ptr",
        },
        GlobalUnlock: {
          args: [
            "ptr",
          ],
          returns: "bool",
        },
        SetLastError: {
          args: [
            "u32",
          ],
          returns: "void",
        },
        GetLastError: {
          args: [],
          returns: "u32",
        },
        GlobalFree: {
          args: [
            "ptr",
          ],
          returns: "ptr",
        },
      });
      try {
        for (const url of [
          "HTTPS://example.com/Path?Name=Value#Anchor",
          "HTTP://example.com/Path",
          "hTtPs://EXAMPLE.com/한글😀?a=%2F",
        ]) {
          await acquire();
          try {
            const name = Buffer.from("UniformResourceLocatorW\0", "utf16le");
            const format = user.symbols.RegisterClipboardFormatW(ptr(name));
            expect(format).toBeGreaterThan(0);
            const bytes = Buffer.from(`${url}\0`, "utf16le");
            const handle = kernel.symbols.GlobalAlloc(
              GMEM_MOVEABLE | GMEM_ZEROINIT,
              bytes.byteLength,
            );
            expect(handle).not.toBeNull();
            let transferred = false;
            try {
              const address = kernel.symbols.GlobalLock(handle);
              expect(address).not.toBeNull();
              try {
                if (!address) {
                  throw new Error(
                    "External bookmark allocation could not be locked.",
                  );
                }
                new Uint8Array(toArrayBuffer(address, 0, bytes.byteLength)).set(
                  bytes,
                );
              } finally {
                kernel.symbols.SetLastError(0);
                if (!kernel.symbols.GlobalUnlock(handle)) {
                  expect(kernel.symbols.GetLastError()).toBe(0);
                }
              }
              owner.clear();
              if (!user.symbols.SetClipboardData(format, handle)) {
                throw new Error("External bookmark could not be installed.");
              }
              transferred = true;
            } finally {
              if (!transferred) {
                expect(kernel.symbols.GlobalFree(handle)).toBeNull();
              }
            }
          } finally {
            owner.close();
          }
          expect(
            await invoke(() =>
              clipboard.readFormats({
                formats: [
                  "application/x-bunaway-bookmark",
                ],
              }),
            ),
          ).toEqual([
            {
              format: "application/x-bunaway-bookmark",
              data: {
                url,
              },
            },
          ]);
        }
        await acquire();
        try {
          owner.clear();
          const name = Buffer.from("bunaway.clipboard.test\0", "utf16le");
          const format = user.symbols.RegisterClipboardFormatW(ptr(name));
          expect(format).toBeGreaterThan(0);
          const handle = kernel.symbols.GlobalAlloc(
            GMEM_MOVEABLE | GMEM_ZEROINIT,
            8,
          );
          expect(handle).not.toBeNull();
          if (!user.symbols.SetClipboardData(format, handle)) {
            kernel.symbols.GlobalFree(handle);
            throw new Error("Could not install non-text fixture.");
          }
        } finally {
          owner.close();
        }
        expect(await invoke(() => clipboard.readText(null))).toBeNull();
      } finally {
        kernel.close();
        user.close();
      }
      await invoke(() =>
        clipboard.writeText({
          text: "keep after cancellation",
        }),
      );
      const holderPath = resolve(root, "holder.ts");
      await Bun.write(
        holderPath,
        `import { createClipboard } from ${JSON.stringify(resolve(import.meta.dir, "../../plugins/clipboard/src/platforms/windows-bindings.ts"))};
const owner = createClipboard();
try {
  const deadline = Date.now() + 2000;
  while (!owner.open()) { if (Date.now() > deadline) throw new Error("Lock failed"); await Bun.sleep(10); }
  console.log("locked");
  await Bun.stdin.text();
} finally { owner.close(); owner.dispose(); }
`,
      );
      const holder = Bun.spawn(
        [
          process.execPath,
          holderPath,
        ],
        {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      try {
        const reader = holder.stdout.getReader();
        const lock = await reader.read();
        reader.releaseLock();
        expect(new TextDecoder().decode(lock.value)).toContain("locked");
        await expect(invoke(() => clipboard.clear(null))).rejects.toMatchObject(
          {
            code: "BUSY",
          },
        );
        await expect(
          invoke(() =>
            clipboard.writeFormats({
              items: extended,
            }),
          ),
        ).rejects.toMatchObject({
          code: "BUSY",
        });
        const binaryController = new AbortController();
        const binaryCancelled = invoke(
          () =>
            clipboard.writeFormats({
              items: extended,
            }),
          binaryController,
        );
        await Bun.sleep(40);
        binaryController.abort();
        await expect(binaryCancelled).rejects.toMatchObject({
          code: "CANCELLED",
        });
        const controller = new AbortController();
        const cancelled = invoke(() => clipboard.clear(null), controller);
        await Bun.sleep(40);
        controller.abort();
        await expect(cancelled).rejects.toBeInstanceOf(BunawayError);
        await Bun.sleep(40);
        // Context revocation must also stop an already granted retry, even
        // without an individual cancel packet or a caller waiting for its result.
        channel.notify({
          kind: "operation",
          context: contextId,
          requestId: crypto.randomUUID(),
          call: {
            operation: "clipboard.clear",
            payload: null,
          },
          source: "backend",
        });
        await Bun.sleep(40);
        channel.notify({
          kind: "cancel-context",
          context: contextId,
        });
        await Bun.sleep(40);
      } finally {
        holder.stdin.end();
        expect(await holder.exited).toBe(0);
      }
      // If cancellation only suppressed the response, the queued clear would destroy this text.
      await Bun.sleep(40);
      expect(await invoke(() => clipboard.readText(null))).toBe(
        "keep after cancellation",
      );
      channel.notify({
        kind: "shutdown",
      });
      expect(await exited).toBe(0);
      expect(fatal).toBeUndefined();
      expect(cleaned).toBe(true);
      expect(await Bun.file(disposedPath).text()).toBe("disposed");
    } finally {
      channel?.close();
      await worker?.terminate();
      await disposeAll([
        restoreClipboard,
        () => owner.dispose(),
        () => {
          clearInterval(pumping);
          pump.close();
        },
        () =>
          rm(root, {
            recursive: true,
            force: true,
          }),
      ]);
    }
  },
  20000,
);
