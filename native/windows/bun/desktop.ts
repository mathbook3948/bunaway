import { win32 } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  DesktopContext,
  DesktopOptions,
  OpenRequest,
  QuitReason,
} from "@bunaway/core";
import {
  AUTOSTART_ARGUMENT,
  AUTOSTART_HIDDEN_ARGUMENT,
} from "@bunaway/protocol";
import type { WindowSpec } from "@bunaway/runtime-bun/window-config";
import type { LaunchArguments } from "./instance.ts";

/** Consume only the registration prefix; later and positional marker strings remain app input. */
export function desktopLaunch(argv: readonly string[]) {
  const hidden = argv[0] === AUTOSTART_HIDDEN_ARGUMENT;
  const autostart = hidden || argv[0] === AUTOSTART_ARGUMENT;
  return {
    launchReason: autostart ? ("autostart" as const) : ("manual" as const),
    hidden,
    argv: autostart ? argv.slice(1) : argv,
  };
}

/** Reject a windowless start without an explicit lifetime owner before starting native resources. */
export function validateDesktopStartup(
  windows: readonly WindowSpec[],
  options: DesktopOptions | undefined,
  hidden = false,
): void {
  if (hidden && !options?.tray) {
    throw new Error(
      "Hidden autostart requires desktop.tray in the app definition.",
    );
  }
  if (
    !windows.some((spec) => spec.startup !== false) &&
    !options?.tray &&
    options?.closeBehavior !== "keep-alive"
  ) {
    throw new Error(
      "app.windows has no startup window; configure desktop.tray or desktop.closeBehavior: keep-alive in the app definition.",
    );
  }
}

/**
 * Splits launch arguments into an immutable request.
 * In files-and-urls mode, relative files resolve against the launch directory
 * and arguments after -- are positional. Raw mode skips metadata derivation.
 */
export function openRequest(
  input: LaunchArguments,
  source: OpenRequest["source"],
  mode: NonNullable<DesktopOptions["openArguments"]> = "files-and-urls",
): OpenRequest {
  const urls: string[] = [];
  const files: string[] = [];
  const launch = desktopLaunch(input.argv);
  let positional = false;
  for (const arg of mode === "raw" ? [] : launch.argv) {
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
    launchReason: launch.launchReason,
    argv: Object.freeze([
      ...launch.argv,
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
    if (
      options !== undefined &&
      (!options || typeof options !== "object" || Array.isArray(options))
    ) {
      throw new Error("desktop must be an options object");
    }
    if (options?.closeBehavior === "hide" && !options.tray) {
      throw new Error("desktop.closeBehavior hide requires a tray");
    }
    if (
      options?.closeBehavior !== undefined &&
      ![
        "quit",
        "hide",
        "keep-alive",
      ].includes(options.closeBehavior)
    ) {
      throw new Error("Invalid desktop.closeBehavior");
    }
    if (
      options?.openArguments !== undefined &&
      options.openArguments !== "files-and-urls" &&
      options.openArguments !== "raw"
    ) {
      throw new Error("Invalid desktop.openArguments");
    }
    if (
      options?.tray !== undefined &&
      (!options.tray ||
        typeof options.tray !== "object" ||
        Array.isArray(options.tray) ||
        typeof options.tray.tooltip !== "string" ||
        !options.tray.tooltip ||
        options.tray.tooltip.length > 127 ||
        /[\0\uD800-\uDFFF]/u.test(options.tray.tooltip))
    ) {
      throw new Error("Invalid desktop.tray.tooltip");
    }
    for (const name of [
      "onOpen",
      "beforeQuit",
    ] as const) {
      if (
        options?.[name] !== undefined &&
        typeof options[name] !== "function"
      ) {
        throw new Error(`desktop.${name} must be a function`);
      }
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
        if (source === "second-instance" && !desktopLaunch(input.argv).hidden) {
          await this.context.show();
        }
        await this.options?.onOpen?.(
          openRequest(input, source, this.options?.openArguments),
          this.context,
        );
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
