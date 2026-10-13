import type { NativeAdapter, NativeEnvironment } from "@bunaway/plugin";
import { BunawayError, type JsonValue } from "@bunaway/protocol";
import { clipboardOperations, validateClipboardInput } from "../contract.ts";
import { type ClipboardFormat, fitsFormatBudget } from "../formats.ts";
import { createPasteboard, type Pasteboard } from "../macos-pasteboard.ts";
import { invalidPasteboardData } from "../macos-tiff.ts";

const formats: ClipboardFormat[] = [
  "text/plain",
  "text/html",
  "text/rtf",
  "image/bmp",
];

/** Own a synchronous main-thread pasteboard adapter, with an explicit fixture dependency. */
export function pasteboardOperations(native: Pasteboard): NativeAdapter {
  let disposed = false;
  return {
    execute() {
      throw new BunawayError({
        code: "UNSUPPORTED",
        message: "Clipboard requires UI execution.",
      });
    },
    executeUI(name, input, _source, context): JsonValue {
      validateClipboardInput(name, input);
      if (!context.permissions.permissions.includes(name)) {
        throw new BunawayError({
          code: "PERMISSION_DENIED",
          message: "Clipboard permission denied.",
        });
      }
      if (disposed || context.signal?.aborted) {
        throw new BunawayError({
          code: "CANCELLED",
          message: "Clipboard operation cancelled.",
        });
      }
      // A synchronous commit cannot be cancelled or rolled back after it starts.
      switch (name) {
        case "clipboard.readText":
          return native.read("text/plain").data;
        case "clipboard.writeText":
          native.write([
            {
              format: "text/plain",
              data: clipboardOperations.writeText.input.parse(input).text,
            },
          ]);
          break;
        case "clipboard.clear":
          native.clear();
          break;
        case "clipboard.readImage":
          return native.read("image/bmp").data;
        case "clipboard.writeImage":
          native.write([
            {
              format: "image/bmp",
              data: clipboardOperations.writeImage.input.parse(input),
            },
          ]);
          break;
        case "clipboard.getFormats":
          return formats.filter((format) => native.has(format));
        case "clipboard.hasFormat":
          return native.has(
            clipboardOperations.hasFormat.input.parse(input).format,
          );
        case "clipboard.readFormats": {
          const result = native.readMany(
            clipboardOperations.readFormats.input.parse(input).formats,
          );
          if (!fitsFormatBudget(result)) {
            invalidPasteboardData();
          }
          return result;
        }
        case "clipboard.writeFormats":
          native.write(
            clipboardOperations.writeFormats.input.parse(input).items,
          );
          break;
      }
      return null;
    },
    busy: () => false,
    dispose() {
      if (!disposed) {
        disposed = true;
        native.dispose();
      }
    },
  };
}

/** Registering the declaration allocates nothing; the owning UI host creates bindings. */
export function createOperations(
  _environment: NativeEnvironment,
): NativeAdapter {
  return pasteboardOperations(createPasteboard());
}
