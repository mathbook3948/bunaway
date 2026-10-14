import { setTimeout as delay } from "node:timers/promises";
import { BunawayError } from "@bunaway/protocol";
import type { z } from "zod";
import type {
  ClipboardFormat,
  imageSchema,
  writeFormatsSchema,
} from "../formats.ts";
import { createClipboard } from "../win32.ts";

const OPEN_TIMEOUT_MS = 250;
const OPEN_RETRY_MS = 10;

/** Own bounded, cancellable clipboard acquisition on the UI thread. */
export class WindowsClipboard {
  private readonly native = createClipboard();
  private readonly lifetime = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  private disposal: Promise<void> | undefined;

  private run<T>(execute: () => T, requestSignal?: AbortSignal): Promise<T> {
    const task = this.withOpen(execute, requestSignal);
    this.pending.add(task);
    // Both outcomes release the busy marker; the caller observes the error.
    void task.then(
      () => this.pending.delete(task),
      () => this.pending.delete(task),
    );
    return task;
  }

  private async withOpen<T>(
    execute: () => T,
    requestSignal?: AbortSignal,
  ): Promise<T> {
    const signal = requestSignal
      ? AbortSignal.any([
          this.lifetime.signal,
          requestSignal,
        ])
      : this.lifetime.signal;
    const deadline = performance.now() + OPEN_TIMEOUT_MS;
    while (true) {
      if (signal.aborted) {
        throw new BunawayError({
          code: "CANCELLED",
          message: "Clipboard operation cancelled.",
        });
      }
      if (this.native.open()) {
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
    // A synchronous commit cannot be cancelled or rolled back after it starts.
    try {
      return execute();
    } finally {
      this.native.close();
    }
  }

  readText(signal?: AbortSignal) {
    return this.run(() => this.native.read(), signal);
  }

  writeText(text: string, signal?: AbortSignal) {
    return this.run(() => {
      this.native.write(text);
      return null;
    }, signal);
  }

  clear(signal?: AbortSignal) {
    return this.run(() => {
      this.native.clear();
      return null;
    }, signal);
  }

  readImage(signal?: AbortSignal) {
    return this.run(() => this.native.readImage(), signal);
  }

  writeImage(image: z.output<typeof imageSchema>, signal?: AbortSignal) {
    return this.run(() => {
      this.native.writeFormats([
        {
          format: "image/bmp",
          data: image,
        },
      ]);
      return null;
    }, signal);
  }

  getFormats(signal?: AbortSignal) {
    return this.run(() => this.native.getFormats(), signal);
  }

  hasFormat(format: ClipboardFormat, signal?: AbortSignal) {
    return this.run(() => this.native.hasFormat(format), signal);
  }

  readFormats(formats: ClipboardFormat[], signal?: AbortSignal) {
    return this.run(() => this.native.readFormats(formats), signal);
  }

  writeFormats(
    items: z.output<typeof writeFormatsSchema>["items"],
    signal?: AbortSignal,
  ) {
    return this.run(() => {
      this.native.writeFormats(items);
      return null;
    }, signal);
  }

  busy(): boolean {
    return this.pending.size > 0;
  }

  dispose(): Promise<void> {
    this.disposal ??= (async () => {
      this.lifetime.abort();
      await Promise.allSettled([
        ...this.pending,
      ]);
      this.native.dispose();
    })();
    return this.disposal;
  }
}

export function initialize(): WindowsClipboard {
  return new WindowsClipboard();
}

export function dispose(instance: WindowsClipboard): Promise<void> {
  return instance.dispose();
}

export function busy(instance: WindowsClipboard): boolean {
  return instance.busy();
}
