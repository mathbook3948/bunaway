import { type Pointer, ptr, toArrayBuffer } from "bun:ffi";
import { BunawayError } from "@bunaway/protocol";
import {
  type ImageInterpolation,
  type ImageMime,
  MAX_ENCODED_BYTES,
  MAX_IMAGE_BYTES,
  type Pixels,
} from "#image/contract";
import { openImageBindings } from "#image/platforms/macos-bindings";
import {
  assertResizeDimensions,
  resizeNearestPixels,
} from "#image/platforms/resize";

// CF and CG objects are ordinary pointers; Bun may return either numeric or bigint pointers.
type NativePointer = Pointer | bigint;
const UTF8_ENCODING = 0x08000100;
const CF_NUMBER_SINT64 = 4;
const IMAGE_STATUS_COMPLETE = 0;
const ALPHA_LAST = 3;
const ALPHA_PREMULTIPLIED_LAST = 1;
const BYTE_ORDER_32_BIG = 4 << 12;
const VIMAGE_NO_ALLOCATE = 1 << 9;
const INTERPOLATION_LOW = 2;
const BLEND_COPY = 17;
const types: Record<ImageMime, string> = {
  "image/png": "public.png",
  "image/jpeg": "public.jpeg",
  "image/bmp": "com.microsoft.bmp",
};
function invalid(message = "Image data is invalid or unsupported."): never {
  throw new BunawayError({
    code: "INVALID_ARGUMENT",
    message,
  });
}
function assertDimensions(width: number, height: number): void {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 4096 ||
    height > 4096 ||
    width * height * 4 > MAX_IMAGE_BYTES
  ) {
    invalid("Image dimensions exceed the pixel limit.");
  }
}

/** Own ImageIO/CoreGraphics wrappers; keep only detached straight RGBA buffers between calls. */
export function createImageIO() {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new BunawayError({
      code: "UNSUPPORTED",
      message: "ImageIO requires macOS arm64.",
    });
  }
  const binding = openImageBindings();
  const { cf, cg, io, accelerate, keys } = binding;
  let disposed = false;
  function assertActive(): void {
    if (disposed) {
      throw new BunawayError({
        code: "CANCELLED",
        message: "Image codec is closed.",
      });
    }
  }
  /** Balance all Create/Copy references in reverse order, including a failure partway through setup. */
  function using<T>(
    run: (
      own: (object: NativePointer | null, input?: boolean) => NativePointer,
    ) => T,
  ): T {
    const owned: NativePointer[] = [];
    try {
      return run((object, input = false) => {
        if (!object) {
          if (input) {
            invalid();
          }
          throw new BunawayError({
            code: "INTERNAL",
            message: "macOS image resource allocation failed.",
          });
        }
        owned.push(object);
        return object;
      });
    } finally {
      for (const object of owned.reverse()) {
        cf.CFRelease(object);
      }
    }
  }
  function typeString(
    mime: ImageMime,
    own: (object: NativePointer | null) => NativePointer,
  ) {
    return own(
      cf.CFStringCreateWithCString(
        null,
        ptr(Buffer.from(`${types[mime]}\0`)),
        UTF8_ENCODING,
      ),
    );
  }
  function image(
    pixels: Pixels,
    own: (object: NativePointer | null) => NativePointer,
    interpolate = false,
  ): NativePointer {
    assertDimensions(pixels.width, pixels.height);
    if (pixels.rgba.length !== pixels.width * pixels.height * 4) {
      invalid("Image dimensions do not match pixels.");
    }
    // CFDataCreate copies the pixels, so no native provider borrows movable JS memory.
    const data = own(
      cf.CFDataCreate(null, ptr(pixels.rgba), pixels.rgba.length),
    );
    const provider = own(cg.CGDataProviderCreateWithCFData(data));
    const space = own(cg.CGColorSpaceCreateDeviceRGB());
    return own(
      cg.CGImageCreate(
        pixels.width,
        pixels.height,
        8,
        32,
        pixels.width * 4,
        space,
        BYTE_ORDER_32_BIG | ALPHA_LAST,
        provider,
        null,
        interpolate,
        0,
      ),
    );
  }
  /** vImage converts directly to straight RGBA without a lossy premultiplied CGContext round trip. */
  function pixelsFromImage(
    source: NativePointer,
    width: number,
    height: number,
    own: (object: NativePointer | null) => NativePointer,
  ): Pixels {
    assertDimensions(width, height);
    const rgba = Buffer.alloc(width * height * 4);
    const space = own(cg.CGColorSpaceCreateDeviceRGB());
    // LP64 vImage_Buffer: data, height, width, rowBytes. NoAllocate retains our bounded buffer.
    const buffer = new BigUint64Array([
      BigInt(ptr(rgba)),
      BigInt(height),
      BigInt(width),
      BigInt(width * 4),
    ]);
    // LP64 vImage_CGImageFormat has two u32s, CF pointer, two u32s, decode pointer, intent + padding.
    const format = Buffer.alloc(40);
    format.writeUInt32LE(8, 0);
    format.writeUInt32LE(32, 4);
    format.writeBigUInt64LE(BigInt(space), 8);
    format.writeUInt32LE(BYTE_ORDER_32_BIG | ALPHA_LAST, 16);
    const result = accelerate.vImageBuffer_InitWithCGImage(
      ptr(buffer),
      ptr(format),
      null,
      source,
      VIMAGE_NO_ALLOCATE,
    );
    if (result !== 0n) {
      invalid("Image pixels cannot be converted to RGBA.");
    }
    return {
      width,
      height,
      rgba,
    };
  }
  return {
    decode(bytes: Buffer, mime: ImageMime): Pixels {
      assertActive();
      if (bytes.length === 0 || bytes.length > MAX_ENCODED_BYTES) {
        invalid();
      }
      return using((own) => {
        const data = own(cf.CFDataCreate(null, ptr(bytes), bytes.length));
        const optionKeys = new BigUint64Array([
          BigInt(keys.cache),
        ]);
        const optionValues = new BigUint64Array([
          BigInt(keys.false),
        ]);
        // Borrowed framework constants remain alive; NULL callbacks need no retain/release.
        const options = own(
          cf.CFDictionaryCreate(
            null,
            ptr(optionKeys),
            ptr(optionValues),
            1,
            null,
            null,
          ),
        );
        const source = own(io.CGImageSourceCreateWithData(data, options), true);
        const actualType = io.CGImageSourceGetType(source);
        if (
          !actualType ||
          !cf.CFEqual(actualType, typeString(mime, own)) ||
          Number(io.CGImageSourceGetCount(source)) !== 1 ||
          io.CGImageSourceGetStatus(source) !== IMAGE_STATUS_COMPLETE
        ) {
          invalid();
        }
        const properties = own(
          io.CGImageSourceCopyPropertiesAtIndex(source, 0, null),
          true,
        );
        function dimension(key: NativePointer): number {
          const number = cf.CFDictionaryGetValue(properties, key);
          const value = new BigInt64Array(1);
          if (
            !number ||
            !cf.CFNumberGetValue(number, CF_NUMBER_SINT64, ptr(value))
          ) {
            invalid();
          }
          return Number(value[0]);
        }
        const width = dimension(keys.width);
        const height = dimension(keys.height);
        // Reject decompression bombs from metadata before creating the native image or pixel buffer.
        assertDimensions(width, height);
        const decoded = own(
          io.CGImageSourceCreateImageAtIndex(source, 0, options),
          true,
        );
        if (
          Number(cg.CGImageGetWidth(decoded)) !== width ||
          Number(cg.CGImageGetHeight(decoded)) !== height ||
          io.CGImageSourceGetStatusAtIndex(source, 0) !== IMAGE_STATUS_COMPLETE
        ) {
          invalid();
        }
        const pixels = pixelsFromImage(decoded, width, height, own);
        if (
          io.CGImageSourceGetStatusAtIndex(source, 0) !== IMAGE_STATUS_COMPLETE
        ) {
          invalid();
        }
        return pixels;
      });
    },
    encode(pixels: Pixels, mime: ImageMime): Buffer {
      assertActive();
      assertDimensions(pixels.width, pixels.height);
      if (mime !== "image/png") {
        for (let index = 3; index < pixels.rgba.length; index += 4) {
          if (pixels.rgba[index] !== 255) {
            invalid(
              "JPEG and BMP export require opaque pixels. Use PNG to preserve alpha.",
            );
          }
        }
      }
      return using((own) => {
        const source = image(pixels, own);
        const data = own(cf.CFDataCreateMutable(null, 0));
        const destination = own(
          io.CGImageDestinationCreateWithData(
            data,
            typeString(mime, own),
            1,
            null,
          ),
        );
        io.CGImageDestinationAddImage(destination, source, null);
        if (!io.CGImageDestinationFinalize(destination)) {
          throw new BunawayError({
            code: "INTERNAL",
            message: "macOS image encoding failed.",
          });
        }
        const length = Number(cf.CFDataGetLength(data));
        if (length < 1 || length > MAX_ENCODED_BYTES) {
          invalid("Encoded image exceeds the byte limit.");
        }
        const address = cf.CFDataGetBytePtr(data);
        if (!address) {
          throw new BunawayError({
            code: "INTERNAL",
            message: "macOS image encoder returned no bytes.",
          });
        }
        // Copy before releasing the native CFData and destination.
        return Buffer.from(new Uint8Array(toArrayBuffer(address, 0, length)));
      });
    },
    resize(
      source: Pixels,
      width: number,
      height: number,
      interpolation: ImageInterpolation,
    ): Pixels {
      assertActive();
      assertResizeDimensions(source, width, height);
      if (interpolation === "nearest") {
        return resizeNearestPixels(source, width, height);
      }
      return using((own) => {
        // Enable the image's interpolation hint as well as the context's bilinear quality.
        const input = image(source, own, true);
        const rgba = Buffer.alloc(width * height * 4);
        const space = own(cg.CGColorSpaceCreateDeviceRGB());
        const context = own(
          cg.CGBitmapContextCreate(
            ptr(rgba),
            width,
            height,
            8,
            width * 4,
            space,
            BYTE_ORDER_32_BIG | ALPHA_PREMULTIPLIED_LAST,
          ),
        );
        cg.CGContextSetBlendMode(context, BLEND_COPY);
        cg.CGContextSetInterpolationQuality(context, INTERPOLATION_LOW);
        cg.CGContextDrawImage(context, 0, 0, width, height, input);
        // CoreGraphics draws into premultiplied RGBA. Return the contract's straight RGBA.
        for (let index = 0; index < rgba.length; index += 4) {
          const alpha = rgba[index + 3] ?? 0;
          for (let channel = 0; channel < 3; channel++) {
            rgba[index + channel] =
              alpha === 0
                ? 0
                : Math.min(
                    255,
                    Math.round(((rgba[index + channel] ?? 0) * 255) / alpha),
                  );
          }
        }
        return {
          width,
          height,
          rgba,
        };
      });
    },
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      binding.close();
    },
  };
}
