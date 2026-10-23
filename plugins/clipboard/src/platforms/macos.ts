import type { NativeEnvironment } from "@bunaway/plugin";
import { attemptAll, failWithCleanup } from "@bunaway/plugin";
import { BunawayError } from "@bunaway/protocol";
import type { z } from "zod";
import {
  type ClipboardFormat,
  fitsFormatBudget,
  imageSchema,
  type macosWriteFormatsSchema,
  nullableTextSchema,
} from "#clipboard/contract";
import { ClipboardChanges } from "#clipboard/platforms/changes";
import { pollPasteboard } from "#clipboard/platforms/macos-changes";
import {
  createPasteboard,
  type Pasteboard,
} from "#clipboard/platforms/macos-pasteboard";
import { invalidPasteboardData } from "#clipboard/platforms/macos-tiff";

const formats = [
  "text/plain",
  "text/html",
  "text/rtf",
  "application/x-bunaway-file-list",
  "image/bmp",
] as const;

/** Own one main-thread pasteboard binding, its synchronous commits and its change notifications. */
export class MacosClipboard {
  private disposed = false;

  /** Without `changes`, `waitForChange` fails and no event is published. */
  constructor(
    private readonly native: Pasteboard,
    private readonly changes: ClipboardChanges = new ClipboardChanges(
      undefined,
      () => {},
    ),
  ) {}

  private active(): void {
    if (this.disposed) {
      throw new BunawayError({
        code: "CANCELLED",
        message: "Clipboard operation cancelled.",
      });
    }
  }

  readText() {
    this.active();
    const result = nullableTextSchema.safeParse(
      this.native.read("text/plain").data,
    );
    return result.success ? result.data : invalidPasteboardData();
  }

  writeText(text: string): null {
    this.active();
    this.native.write([
      {
        format: "text/plain",
        data: text,
      },
    ]);
    return null;
  }

  clear(): null {
    this.active();
    this.native.clear();
    return null;
  }

  readImage() {
    this.active();
    const result = imageSchema
      .nullable()
      .safeParse(this.native.read("image/bmp").data);
    return result.success ? result.data : invalidPasteboardData();
  }

  writeImage(image: z.output<typeof imageSchema>): null {
    this.active();
    this.native.write([
      {
        format: "image/bmp",
        data: image,
      },
    ]);
    return null;
  }

  getFormats() {
    this.active();
    return formats.filter((format) => this.native.has(format));
  }

  hasFormat(format: ClipboardFormat): boolean {
    this.active();
    return this.native.has(format);
  }

  readFormats(formats: ClipboardFormat[]) {
    this.active();
    const result = this.native.readMany(formats);
    if (!fitsFormatBudget(result)) {
      invalidPasteboardData();
    }
    return result;
  }

  writeFormats(items: z.output<typeof macosWriteFormatsSchema>["items"]): null {
    this.active();
    this.native.write(items);
    return null;
  }

  /** Resolve with the next clipboard change, including writes made through this adapter. */
  waitForChange(signal?: AbortSignal) {
    this.active();
    return this.changes.wait(signal);
  }

  /** Stop notifications first so no event is published while the pasteboard binding is released. */
  dispose(): void {
    if (!this.disposed) {
      this.disposed = true;
      attemptAll(
        [
          () => this.changes.dispose(),
          () => this.native.dispose(),
        ],
        "Clipboard cleanup failed.",
      );
    }
  }
}

/** Poll the pasteboard counter when the host can deliver events; otherwise `waitForChange` fails. */
export function initialize(environment?: NativeEnvironment): MacosClipboard {
  const native = createPasteboard();
  const events = environment?.events;
  if (!events) {
    return new MacosClipboard(native);
  }
  try {
    return new MacosClipboard(
      native,
      new ClipboardChanges(
        pollPasteboard(() => native.changeCount()),
        (event, payload) => events.emit(event, payload),
      ),
    );
  } catch (error) {
    // No caller receives the adapter, so release the pasteboard binding here.
    failWithCleanup(error, () => native.dispose(), "Clipboard cleanup failed.");
  }
}

export function dispose(instance: MacosClipboard): void {
  instance.dispose();
}
