import type { NativeAdapter, NativeEnvironment } from "@bunaway/plugin";
import { BunawayError, type JsonValue } from "@bunaway/protocol";
import {
  bytesSchema,
  imageOperations,
  validateImageInput,
} from "../contract.ts";
import { cropPixels } from "../crop.ts";
import { createImageIO } from "../image-io.ts";
import { ImageResources } from "../resources.ts";

/** Own app pixel resources on the macOS I/O worker, with permission and cancellation checks before native work. */
export function createOperations(
  _environment: NativeEnvironment,
): NativeAdapter {
  const codec = createImageIO();
  const resources = new ImageResources();
  let disposed = false;
  return {
    // Context-free execution cannot safely publish app resources or reclaim cancelled creations.
    execute() {
      throw new BunawayError({
        code: "UNSUPPORTED",
        message: "Images require contextual host execution.",
      });
    },
    executeUI(name, input, _source, context): JsonValue {
      validateImageInput(name, input);
      if (disposed || context.signal?.aborted) {
        throw new BunawayError({
          code: "CANCELLED",
          message: "Image operation cancelled.",
        });
      }
      if (!context.permissions.permissions.includes(name)) {
        throw new BunawayError({
          code: "PERMISSION_DENIED",
          message: "Image permission denied.",
        });
      }
      context.beforeExecute?.();
      if (context.signal?.aborted) {
        throw new BunawayError({
          code: "CANCELLED",
          message: "Image operation cancelled.",
        });
      }
      switch (name) {
        case "image.createRGBA": {
          const pixels = imageOperations.createRGBA.input.parse(input);
          return resources.create(
            {
              ...pixels,
              rgba: Buffer.from(pixels.rgba, "base64"),
            },
            context.signal,
          );
        }
        case "image.createBytes": {
          resources.assertCapacity();
          const bytes = imageOperations.createBytes.input.parse(input);
          return resources.create(
            codec.decode(Buffer.from(bytes.data, "base64"), bytes.mime),
            context.signal,
          );
        }
        case "image.createDataURL": {
          resources.assertCapacity();
          const { url } = imageOperations.createDataURL.input.parse(input);
          const separator = url.indexOf(",");
          const bytes = bytesSchema.parse({
            mime: url.slice(5, url.indexOf(";")),
            data: url.slice(separator + 1),
          });
          return resources.create(
            codec.decode(Buffer.from(bytes.data, "base64"), bytes.mime),
            context.signal,
          );
        }
        case "image.getInfo":
          return resources.info(imageOperations.getInfo.input.parse(input).id);
        case "image.getPixels": {
          const pixels = resources.get(
            imageOperations.getPixels.input.parse(input).id,
          );
          return {
            width: pixels.width,
            height: pixels.height,
            rgba: pixels.rgba.toString("base64"),
          };
        }
        case "image.exportBytes":
        case "image.exportDataURL": {
          const { id, format } = imageOperations.exportBytes.input.parse(input);
          const data = codec
            .encode(resources.get(id), format)
            .toString("base64");
          return name === "image.exportBytes"
            ? {
                mime: format,
                data,
              }
            : `data:${format};base64,${data}`;
        }
        case "image.dispose":
          return resources.remove(
            imageOperations.dispose.input.parse(input).id,
          );
        case "image.crop": {
          const request = imageOperations.crop.input.parse(input);
          const source = resources.get(request.id);
          resources.assertCapacity();
          return resources.create(cropPixels(source, request), context.signal);
        }
        case "image.resize": {
          const request = imageOperations.resize.input.parse(input);
          const source = resources.get(request.id);
          resources.assertCapacity();
          return resources.create(
            codec.resize(
              source,
              request.width,
              request.height,
              request.interpolation ?? "linear",
            ),
            context.signal,
          );
        }
      }
      throw new BunawayError({
        code: "UNSUPPORTED",
        message: "Image operation is not registered.",
      });
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      resources.dispose();
      codec.dispose();
    },
  };
}
