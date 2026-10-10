import { setTimeout as delay } from "node:timers/promises";
import type { NativeAdapter, NativeEnvironment } from "@bunaway/plugin";
import {
  BunawayError,
  type JsonValue,
  NativeRegistry,
  validateValue,
} from "@bunaway/protocol";
import { clipboardPlugin } from "./index.ts";
import { writeTextSchema } from "./text.ts";
import { createClipboard } from "./win32.ts";

const OPEN_TIMEOUT_MS = 250;
const OPEN_RETRY_MS = 10;
type UIContext = Parameters<NonNullable<NativeAdapter["executeUI"]>>[3];

/** Run bounded, cancellable acquisition on the UI thread without holding a handle across awaits. */
export function createOperations(
  _environment: NativeEnvironment,
): NativeAdapter {
  const registry = new NativeRegistry([
    clipboardPlugin,
  ]);
  const native = createClipboard();
  const lifetime = new AbortController();
  const pending = new Set<Promise<string | null>>();
  let disposal: Promise<void> | undefined;

  async function run(name: string, input: JsonValue, context: UIContext) {
    const call = registry.validateCall({
      operation: name,
      payload: input,
    });
    if (!registry.allowed(context.permissions, call, () => false)) {
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
      if (name === "clipboard.writeText") {
        native.write(validateValue(writeTextSchema, input).text);
      } else {
        native.clear();
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
