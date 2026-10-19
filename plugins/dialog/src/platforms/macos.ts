import { BunawayError } from "@bunaway/protocol";
import type {
  DialogInput,
  DialogKind,
  DialogResult,
  FileDialogInstance,
} from "#dialog/contract";
import {
  createFilePanelFactory,
  type FilePanelFactory,
  type PanelSettings,
} from "#dialog/platforms/macos-bindings";

/** A file name's extension begins at a dot that is neither first nor last. */
const hasExtension = (name: string) => /.\.[^.]/u.test(name);

/**
 * Reduce the shared dialog input to what an NSOpenPanel or NSSavePanel is configured with.
 *
 * The panels have no filter drop-down, so every filter's extensions form one accepted set, and a
 * `*` entry accepts every file. `defaultExtension` completes a default file name that has none; a
 * save panel already appends the first accepted extension to a name typed without one. The "replace
 * existing file" prompt of a save panel cannot be turned off, so `confirmOverwrite` never weakens it.
 */
export function panelSettings(
  kind: DialogKind,
  input: DialogInput,
): PanelSettings {
  const save = kind === "saveFile";
  const extensions =
    kind === "selectFolder"
      ? []
      : (input.filters?.flatMap((filter) => filter.extensions) ?? []);
  const fileName =
    save && input.defaultFileName !== undefined ? input.defaultFileName : null;
  return {
    canChooseFiles: kind === "openFile",
    canChooseDirectories: kind === "selectFolder",
    multiple: !save && input.multiple === true,
    canCreateDirectories: kind !== "openFile",
    showHidden: input.showHiddenFiles === true,
    title: input.title ?? null,
    directory: input.defaultDirectory ?? null,
    fileName:
      fileName !== null && input.defaultExtension && !hasExtension(fileName)
        ? `${fileName}.${input.defaultExtension}`
        : fileName,
    extensions:
      extensions.length === 0 || extensions.includes("*")
        ? null
        : [
            ...new Set(extensions.map((extension) => extension.toLowerCase())),
          ],
    save,
  };
}

/**
 * File and folder pickers on macOS, shown application-modal on the main thread. The modal loop
 * blocks this thread until the user answers, so a host cancellation or a closed owner window
 * cannot dismiss an open panel; it is honored before the panel opens and, when it arrived during
 * the panel, replaces the user's answer with CANCELLED.
 */
export class MacosDialogs implements FileDialogInstance {
  private disposed = false;
  private active = false;

  constructor(
    private readonly panels: FilePanelFactory = createFilePanelFactory(),
  ) {}

  show(
    kind: DialogKind,
    input: DialogInput,
    _source: string,
    signal?: AbortSignal,
  ): DialogResult {
    this.checkCancelled(signal);
    if (this.active) {
      throw new BunawayError({
        code: "BUSY",
        message: "A dialog is already open.",
      });
    }
    this.active = true;
    try {
      const panel = this.panels.create(panelSettings(kind, input));
      try {
        const paths = panel.run();
        this.checkCancelled(signal);
        return paths === null
          ? {
              cancelled: true,
            }
          : {
              cancelled: false,
              paths,
            };
      } finally {
        panel.dispose();
      }
    } finally {
      this.active = false;
    }
  }

  private checkCancelled(signal: AbortSignal | undefined): void {
    if (this.disposed || signal?.aborted) {
      throw new BunawayError({
        code: "CANCELLED",
        message: "Dialog call was cancelled.",
      });
    }
  }

  busy(): boolean {
    return this.active;
  }

  /** Safe to repeat; the factory releases its libraries once. */
  dispose(): void {
    this.disposed = true;
    this.panels.dispose();
  }
}

export function initialize(): MacosDialogs {
  return new MacosDialogs();
}

export function dispose(instance: MacosDialogs): void {
  instance.dispose();
}

export function busy(instance: MacosDialogs): boolean {
  return instance.busy();
}
