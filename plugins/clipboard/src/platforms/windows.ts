import { setTimeout as delay } from "node:timers/promises";
import type { NativeEnvironment } from "@bunaway/plugin";
import { BunawayError } from "@bunaway/protocol";
import type { z } from "zod";
import type {
  ClipboardFormat,
  imageSchema,
  writeFormatsSchema,
} from "#clipboard/contract";
import { createClipboard } from "#clipboard/platforms/windows-bindings";
import { Win32ClipboardListener } from "#clipboard/platforms/windows-change-bindings";
import { ClipboardChanges } from "#clipboard/platforms/windows-changes";

const OPEN_TIMEOUT_MS = 250;
const OPEN_RETRY_MS = 10;

/** Own bounded, cancellable clipboard acquisition on the UI thread. */
export class WindowsClipboard {
  private readonly native = createClipboard();
  private readonly lifetime = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  private disposal: Promise<void> | undefined;

  constructor(private readonly changes: ClipboardChanges) {}

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

  /** Resolve with the next clipboard change, including writes made through this adapter. */
  waitForChange(signal?: AbortSignal) {
    return this.changes.wait(signal);
  }

  busy(): boolean {
    return this.pending.size > 0;
  }

  dispose(): Promise<void> {
    this.disposal ??= (async () => {
      this.lifetime.abort();
      // Stop notifications first so no event is published while operations drain.
      const errors: unknown[] = [];
      try {
        this.changes.dispose();
      } catch (error) {
        errors.push(error);
      }
      await Promise.allSettled([
        ...this.pending,
      ]);
      try {
        this.native.dispose();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length) {
        throw new AggregateError(errors, "Clipboard cleanup failed.");
      }
    })();
    return this.disposal;
  }
}

/**
 * Start change listening when the host offers UI-thread window services. A listener that
 * cannot start leaves the other operations usable and makes `waitForChange` fail.
 */
export function initialize(environment: NativeEnvironment): WindowsClipboard {
  const services = environment.shortcuts;
  let driver: Win32ClipboardListener | undefined;
  let unavailableCause: unknown;
  if (services) {
    try {
      driver = new Win32ClipboardListener(services);
    } catch (error) {
      // Documented degradation: no events, and waits report INTERNAL with this cause.
      unavailableCause = error;
    }
  }
  return new WindowsClipboard(
    new ClipboardChanges(
      driver,
      (event, payload) => services?.emit(event, payload),
      Date.now,
      unavailableCause,
    ),
  );
}

export function dispose(instance: WindowsClipboard): Promise<void> {
  return instance.dispose();
}

export function busy(instance: WindowsClipboard): boolean {
  return instance.busy();
}
