import { setTimeout as delay } from "node:timers/promises";
import type { NativeAdapter, NativeEnvironment } from "@bunaway/plugin";
import { BunawayError, type JsonValue, validateValue } from "@bunaway/protocol";
import { clipboardOperations, validateClipboardInput } from "../contract.ts";
import { writeTextSchema } from "../text.ts";
import { createClipboard } from "../win32.ts";

const OPEN_TIMEOUT_MS = 250;
const OPEN_RETRY_MS = 10;
type UIContext = Parameters<NonNullable<NativeAdapter["executeUI"]>>[3];

/** Run bounded, cancellable acquisition on the UI thread without holding a handle across awaits. */
export function createOperations(
  _environment: NativeEnvironment,
): NativeAdapter {
  const native = createClipboard();
  const lifetime = new AbortController();
  const pending = new Set<Promise<JsonValue>>();
  let disposal: Promise<void> | undefined;

  async function run(
    name: string,
    input: JsonValue,
    context: UIContext,
  ): Promise<JsonValue> {
    validateClipboardInput(name, input);
    if (!context.permissions.permissions.includes(name)) {
      throw new BunawayError({
        code: "PERMISSION_DENIED",
        message: "Clipboard permission denied.",
      });
    }
    const signal = context.signal
      ? AbortSignal.any([
          lifetime.signal,
          context.signal,
        ])
      : lifetime.signal;
    const deadline = performance.now() + OPEN_TIMEOUT_MS;
    while (true) {
      if (signal.aborted) {
        throw new BunawayError({
          code: "CANCELLED",
          message: "Clipboard operation cancelled.",
        });
      }
      if (native.open()) {
        break;
      }
      if (performance.now() >= deadline) {
        throw new BunawayError({
          code: "BUSY",
          message: "Windows clipboard is occupied.",
        });
      }
      try {
        await delay(OPEN_RETRY_MS, undefined, {
          signal,
        });
      } catch {
        throw new BunawayError({
          code: "CANCELLED",
          message: "Clipboard operation cancelled.",
        });
      }
    }
    // The synchronous commit cannot be interrupted. Cancellation never rolls it back.
    try {
      if (name === "clipboard.readText") {
        return native.read();
      }
      switch (name) {
        case "clipboard.writeText":
          native.write(writeTextSchema.parse(validateValue({}, input)).text);
          break;
        case "clipboard.clear":
          native.clear();
          break;
        case "clipboard.readImage":
          return native.readImage();
        case "clipboard.writeImage":
          native.writeFormats([
            {
              format: "image/bmp",
              data: clipboardOperations.writeImage.input.parse(input),
            },
          ]);
          break;
        case "clipboard.getFormats":
          return native.getFormats();
        case "clipboard.hasFormat":
          return native.hasFormat(
            clipboardOperations.hasFormat.input.parse(input).format,
          );
        case "clipboard.readFormats":
          return native.readFormats(
            clipboardOperations.readFormats.input.parse(input).formats,
          );
        case "clipboard.writeFormats":
          native.writeFormats(
            clipboardOperations.writeFormats.input.parse(input).items,
          );
          break;
      }
      return null;
    } finally {
      native.close();
    }
  }
  return {
    execute() {
      throw new BunawayError({
        code: "UNSUPPORTED",
        message: "Clipboard requires UI execution.",
      });
    },
    executeUI(name, input, _source, context) {
      const task = run(name, input, context);
      pending.add(task);
      // Both outcomes release the busy marker; the caller owns the operation error.
      void task.then(
        () => pending.delete(task),
        () => pending.delete(task),
      );
      return task;
    },
    busy: () => pending.size > 0,
    dispose() {
      disposal ??= (async () => {
        lifetime.abort();
        await Promise.allSettled([
          ...pending,
        ]);
        native.dispose();
      })();
      return disposal;
    },
  };
}
