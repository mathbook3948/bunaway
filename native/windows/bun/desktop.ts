import { win32 } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  DesktopContext,
  DesktopOptions,
  OpenRequest,
  QuitReason,
} from "../../../packages/core/src/index.ts";
import type { LaunchArguments } from "./instance.ts";

/**
 * Splits launch arguments into an immutable request.
 * Relative files resolve against the launch directory.
 * Arguments after -- are positional.
 */
export function openRequest(
  input: LaunchArguments,
  source: OpenRequest["source"],
): OpenRequest {
  const urls: string[] = [];
  const files: string[] = [];
  let positional = false;
  for (const arg of input.argv) {
    if (!positional && arg === "--") {
      positional = true;
      continue;
    }
    if (!positional && arg.startsWith("-")) {
      continue;
    }
    // Drive paths are files, including drive-relative paths such as C:notes.txt.
    if (!/^[a-z]:/i.test(arg) && /^[a-z][a-z0-9+.-]*:/i.test(arg)) {
      const url = new URL(arg);
      if (url.protocol === "file:") {
        const path = fileURLToPath(url, {
          windows: true,
        });
        if (path.includes("\0")) {
          throw new Error("File URL must not contain NUL");
        }
        files.push(path);
      } else {
        urls.push(url.href);
      }
    } else {
      files.push(win32.resolve(input.cwd, arg));
    }
  }
  return Object.freeze({
    source,
    argv: Object.freeze([
      ...input.argv,
    ]),
    cwd: input.cwd,
    urls: Object.freeze(urls),
    files: Object.freeze(files),
  });
}

/** Serializes open callbacks and runs the app's before-quit shutdown gate. */
export class DesktopLifecycle {
  readonly context: DesktopContext;
  private quitting: Promise<boolean> | undefined;
  private stopped = false;
  private opens = Promise.resolve();
  private pending = 0;
  constructor(
    readonly options: DesktopOptions | undefined,
    control: (action: "show" | "hide") => Promise<void>,
    private readonly stop: () => void,
    private readonly report: (error: unknown) => void,
  ) {
    if (options?.closeBehavior === "hide" && !options.tray) {
      throw new Error("desktop.closeBehavior hide requires a tray");
    }
    if (
      options?.closeBehavior !== undefined &&
      ![
        "quit",
        "hide",
      ].includes(options.closeBehavior)
    ) {
      throw new Error("Invalid desktop.closeBehavior");
    }
    if (
      options?.tray &&
      (!options.tray.tooltip ||
        options.tray.tooltip.length > 127 ||
        options.tray.tooltip.includes("\0"))
    ) {
      throw new Error("Invalid desktop.tray.tooltip");
    }
    this.context = Object.freeze({
      show: () => (this.stopped ? Promise.resolve() : control("show")),
      hide: () => {
        if (!options?.tray) {
          return Promise.reject(new Error("Hiding requires a tray"));
        }
        return this.stopped ? Promise.resolve() : control("hide");
      },
      quit: () => this.quit("api"),
    });
  }
  /**
   * Queues an open callback, showing the app first for second instances.
   * Reports callback errors and keeps processing later opens.
   * Throws if stopped or full.
   */
  open(input: LaunchArguments, source: OpenRequest["source"]): void {
    if (this.stopped || this.pending >= 64) {
      throw new Error("Desktop open queue unavailable");
    }
    this.pending++;
    this.opens = this.opens
      .then(async () => {
        if (this.stopped) {
          return;
        }
        if (source === "second-instance") {
          await this.context.show();
        }
        await this.options?.onOpen?.(openRequest(input, source), this.context);
      })
      .catch(this.report)
      .finally(() => {
        this.pending--;
      });
  }
  /**
   * Shares concurrent quit checks.
   * Returns false if before-quit vetoes or fails.
   */
  quit(reason: QuitReason): Promise<boolean> {
    if (this.stopped) {
      return Promise.resolve(true);
    }
    if (this.quitting) {
      return this.quitting;
    }
    this.quitting = Promise.resolve()
      .then(async () => {
        try {
          if ((await this.options?.beforeQuit?.(reason)) === false) {
            return false;
          }
          if (!this.stopped) {
            this.stopped = true;
            this.stop();
          }
          return true;
        } catch (error) {
          this.report(error);
          return false;
        }
      })
      .finally(() => {
        this.quitting = undefined;
      });
    return this.quitting;
  }
  /** Prevents a pending before-quit check from initiating another shutdown. */
  dispose() {
    this.stopped = true;
  }
}
