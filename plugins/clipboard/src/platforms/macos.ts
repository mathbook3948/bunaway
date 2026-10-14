import { BunawayError } from "@bunaway/protocol";
import type { z } from "zod";
import { nullableTextSchema } from "../contract.ts";
import {
  type ClipboardFormat,
  fitsFormatBudget,
  imageSchema,
  type writeFormatsSchema,
} from "../formats.ts";
import { createPasteboard, type Pasteboard } from "../macos-pasteboard.ts";
import { invalidPasteboardData } from "../macos-tiff.ts";

const formats: ClipboardFormat[] = [
  "text/plain",
  "text/html",
  "text/rtf",
  "image/bmp",
];

/** Own one main-thread pasteboard binding and its synchronous commits. */
export class MacosClipboard {
  private disposed = false;

  constructor(private readonly native: Pasteboard) {}

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

  writeFormats(items: z.output<typeof writeFormatsSchema>["items"]): null {
    this.active();
    this.native.write(items);
    return null;
  }

  dispose(): void {
    if (!this.disposed) {
      this.disposed = true;
      this.native.dispose();
    }
  }
}

export function initialize(): MacosClipboard {
  return new MacosClipboard(createPasteboard());
}

export function dispose(instance: MacosClipboard): void {
  instance.dispose();
}
