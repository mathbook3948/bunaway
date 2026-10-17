import {
  CFunction,
  dlopen,
  type FFIType,
  type Pointer,
  ptr,
  read,
} from "bun:ffi";
import { OLE32, pick } from "@bunaway/plugin/win32";
import { BunawayError } from "@bunaway/protocol";
import {
  type ImageInterpolation,
  type ImageMime,
  MAX_ENCODED_BYTES,
  MAX_IMAGE_BYTES,
  type Pixels,
} from "#image/contract";
import {
  assertResizeDimensions,
  resizeNearestPixels,
} from "#image/platforms/resize";

type Argument = number | bigint | null;
type Abi = FFIType | "ptr" | "i32" | "u32" | "f64";
type NativeCall = ((...args: Argument[]) => number) & {
  close(): void;
};
const COINIT_APARTMENTTHREADED = 2;
const CLSCTX_INPROC_SERVER = 1;
const WIC_METADATA_ON_DEMAND = 0;
const WIC_ENCODER_NO_CACHE = 2;
const WIC_DITHER_NONE = 0;
const WIC_PALETTE_CUSTOM = 0;
const WIC_INTERPOLATION_LINEAR = 1;
const containers: Record<ImageMime, string> = {
  "image/png": "1b7cfaf4-713f-473c-bbcd-6137425faeaf",
  "image/jpeg": "19e4a5aa-5662-4fc5-a0c0-1758028e1057",
  "image/bmp": "0af1d87e-fcfe-4188-bdeb-a7906471cbe3",
};
const factoryClass = "cacaf262-9370-4615-a13b-9f5539da4c0a";
const factoryInterface = "ec5ec8a9-c395-4314-9c77-54d7a935ff70";
const bgraFormat = "6fddc324-4e03-4bfe-b185-3d77768dc90f";
const premultipliedBgraFormat = "6fddc324-4e03-4bfe-b185-3d77768dc910";
const rgbaFormat = "f5c7ad2d-6a8d-43dd-a7a8-a29935261ae9";
const bgrFormat = "6fddc324-4e03-4bfe-b185-3d77768dc90c";

function guid(value: string): Buffer {
  const bytes = Buffer.from(value.replaceAll("-", ""), "hex");
  bytes.subarray(0, 4).reverse();
  bytes.subarray(4, 6).reverse();
  bytes.subarray(6, 8).reverse();
  return bytes;
}
function check(result: number, input = false): void {
  if (result < 0) {
    throw new BunawayError({
      code: input ? "INVALID_ARGUMENT" : "INTERNAL",
      message: input
        ? "Image data is invalid or unsupported."
        : "Windows image operation failed.",
    });
  }
}
/** Collect the native encoder's exact container length from a fixed-capacity WIC memory stream. */
function encodedLength(bytes: Buffer, mime: ImageMime): number {
  if (mime === "image/bmp") {
    const size = bytes.readUInt32LE(2);
    if (
      bytes.toString("ascii", 0, 2) === "BM" &&
      size >= 14 &&
      size <= bytes.length
    ) {
      return size;
    }
  } else if (mime === "image/jpeg") {
    const end = bytes.lastIndexOf(
      Buffer.from([
        0xff,
        0xd9,
      ]),
    );
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && end >= 2) {
      return end + 2;
    }
  } else if (
    bytes.subarray(0, 8).equals(
      Buffer.from([
        137,
        80,
        78,
        71,
        13,
        10,
        26,
        10,
      ]),
    )
  ) {
    let offset = 8;
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset);
      const end = offset + 12 + length;
      if (end > bytes.length) {
        break;
      }
      if (
        bytes.toString("ascii", offset + 4, offset + 8) === "IEND" &&
        length === 0
      ) {
        return end;
      }
      offset = end;
    }
  }
  throw new BunawayError({
    code: "INTERNAL",
    message: "Windows image encoder returned incomplete data.",
  });
}

/** Own one balanced STA initialization, WIC factory and vtable bindings; no native object escapes a call. */
export function createWIC() {
  const ole = dlopen("ole32.dll", {
    ...pick(OLE32, "CoInitializeEx", "CoUninitialize", "CoCreateInstance"),
  });
  const methods = new Map<string, NativeCall>();
  // Native memory streams borrow their backing arrays. Keep those arrays rooted
  // until Release, including across later COM calls and any Bun GC they trigger.
  const storage = new Map<Pointer, Buffer>();
  function invoke(
    object: Pointer,
    slot: number,
    args: Abi[],
    values: Argument[],
    returns: Abi = "i32",
  ): number {
    const address = read.ptr(read.ptr(object), slot * 8);
    if (!address) {
      throw new BunawayError({
        code: "INTERNAL",
        message: "Windows image interface is unavailable.",
      });
    }
    const key = `${address}:${args}:${returns}`;
    let method = methods.get(key);
    if (!method) {
      // WIC x64 COM methods receive this first and return HRESULT/ULONG only.
      method = CFunction({
        ptr: address as Pointer,
        args: [
          "ptr",
          ...args,
        ],
        returns,
      }) as NativeCall;
      methods.set(key, method);
    }
    return method(object, ...values);
  }
  const release = (object: Pointer) => {
    invoke(object, 2, [], [], "u32");
    storage.delete(object);
  };
  function acquire(action: (out: Pointer) => number, input = false): Pointer {
    const out = new BigUint64Array(1);
    const result = action(ptr(out));
    // An out interface, including one returned alongside failure, belongs to this caller.
    const object = Number(out[0]) as Pointer;
    if (result < 0 || !object) {
      if (object) {
        release(object);
      }
      check(result, input);
      throw new BunawayError({
        code: "INTERNAL",
        message: "Windows image interface is unavailable.",
      });
    }
    return object;
  }
  let initialized = false;
  let factory: Pointer;
  try {
    check(ole.symbols.CoInitializeEx(null, COINIT_APARTMENTTHREADED));
    initialized = true;
    const clsid = guid(factoryClass);
    const iid = guid(factoryInterface);
    factory = acquire((out) =>
      ole.symbols.CoCreateInstance(
        ptr(clsid),
        null,
        CLSCTX_INPROC_SERVER,
        ptr(iid),
        out,
      ),
    );
  } catch (error) {
    for (const method of methods.values()) {
      method.close();
    }
    if (initialized) {
      ole.symbols.CoUninitialize();
    }
    ole.close();
    throw error;
  }
  let disposed = false;
  function stream(bytes: Buffer): Pointer {
    const object = acquire((out) =>
      invoke(
        factory,
        14,
        [
          "ptr",
        ],
        [
          out,
        ],
      ),
    );
    storage.set(object, bytes);
    try {
      check(
        invoke(
          object,
          16,
          [
            "ptr",
            "u32",
          ],
          [
            ptr(bytes),
            bytes.length,
          ],
        ),
      );
      return object;
    } catch (error) {
      release(object);
      throw error;
    }
  }
  /** Keep backing BGRA bytes rooted until the native bitmap's Release. */
  function bitmapFromPixels(pixels: Pixels): Pointer {
    const bgra = Buffer.from(pixels.rgba);
    for (let index = 0; index < bgra.length; index += 4) {
      const red = bgra[index] ?? 0;
      bgra[index] = bgra[index + 2] ?? 0;
      bgra[index + 2] = red;
    }
    const format = guid(bgraFormat);
    const bitmap = acquire((out) =>
      invoke(
        factory,
        20,
        [
          "u32",
          "u32",
          "ptr",
          "u32",
          "u32",
          "ptr",
          "ptr",
        ],
        [
          pixels.width,
          pixels.height,
          ptr(format),
          pixels.width * 4,
          bgra.length,
          ptr(bgra),
          out,
        ],
      ),
    );
    storage.set(bitmap, bgra);
    return bitmap;
  }
  function convert(
    source: Pointer,
    formatId: string,
    owned: Pointer[],
  ): Pointer {
    const converter = acquire((out) =>
      invoke(
        factory,
        10,
        [
          "ptr",
        ],
        [
          out,
        ],
      ),
    );
    owned.push(converter);
    const format = guid(formatId);
    check(
      invoke(
        converter,
        8,
        [
          "ptr",
          "ptr",
          "u32",
          "ptr",
          "f64",
          "u32",
        ],
        [
          source,
          ptr(format),
          WIC_DITHER_NONE,
          null,
          0,
          WIC_PALETTE_CUSTOM,
        ],
      ),
    );
    return converter;
  }
  function assertActive(): void {
    if (disposed) {
      throw new BunawayError({
        code: "CANCELLED",
        message: "Image codec is closed.",
      });
    }
  }
  return {
    decode(bytes: Buffer, mime: ImageMime): Pixels {
      assertActive();
      const input = stream(bytes);
      const owned: Pointer[] = [
        input,
      ];
      try {
        const container = guid(containers[mime]);
        const decoder = acquire((out) =>
          invoke(
            factory,
            7,
            [
              "ptr",
              "ptr",
              "ptr",
            ],
            [
              ptr(container),
              null,
              out,
            ],
          ),
        );
        owned.push(decoder);
        check(
          invoke(
            decoder,
            4,
            [
              "ptr",
              "u32",
            ],
            [
              input,
              WIC_METADATA_ON_DEMAND,
            ],
          ),
          true,
        );
        const count = new Uint32Array(1);
        check(
          invoke(
            decoder,
            12,
            [
              "ptr",
            ],
            [
              ptr(count),
            ],
          ),
          true,
        );
        if (count[0] !== 1) {
          throw new BunawayError({
            code: "INVALID_ARGUMENT",
            message: "Only single-frame images are supported.",
          });
        }
        const frame = acquire(
          (out) =>
            invoke(
              decoder,
              13,
              [
                "u32",
                "ptr",
              ],
              [
                0,
                out,
              ],
            ),
          true,
        );
        owned.push(frame);
        const size = new Uint32Array(2);
        check(
          invoke(
            frame,
            3,
            [
              "ptr",
              "ptr",
            ],
            [
              ptr(size),
              ptr(size, 4),
            ],
          ),
          true,
        );
        const width = size[0] ?? 0;
        const height = size[1] ?? 0;
        if (
          width < 1 ||
          width > 4096 ||
          height < 1 ||
          height > 4096 ||
          width * height * 4 > MAX_IMAGE_BYTES
        ) {
          throw new BunawayError({
            code: "INVALID_ARGUMENT",
            message: "Decoded image exceeds the pixel limit.",
          });
        }
        const converter = acquire((out) =>
          invoke(
            factory,
            10,
            [
              "ptr",
            ],
            [
              out,
            ],
          ),
        );
        owned.push(converter);
        const format = guid(bgraFormat);
        check(
          invoke(
            converter,
            8,
            [
              "ptr",
              "ptr",
              "u32",
              "ptr",
              "f64",
              "u32",
            ],
            [
              frame,
              ptr(format),
              WIC_DITHER_NONE,
              null,
              0,
              WIC_PALETTE_CUSTOM,
            ],
          ),
          true,
        );
        const rgba = Buffer.alloc(width * height * 4);
        check(
          invoke(
            converter,
            7,
            [
              "ptr",
              "u32",
              "u32",
              "ptr",
            ],
            [
              null,
              width * 4,
              rgba.length,
              ptr(rgba),
            ],
          ),
          true,
        );
        for (let index = 0; index < rgba.length; index += 4) {
          const blue = rgba[index] ?? 0;
          rgba[index] = rgba[index + 2] ?? 0;
          rgba[index + 2] = blue;
        }
        return {
          width,
          height,
          rgba,
        };
      } finally {
        for (const object of owned.reverse()) {
          release(object);
        }
      }
    },
    /** Copy nearest pixels exactly; WIC linear filtering uses premultiplied channels on the STA. */
    resize(
      pixels: Pixels,
      width: number,
      height: number,
      interpolation: ImageInterpolation,
    ): Pixels {
      assertActive();
      if (interpolation === "nearest") {
        return resizeNearestPixels(pixels, width, height);
      }
      assertResizeDimensions(pixels, width, height);
      const bitmap = bitmapFromPixels(pixels);
      const owned: Pointer[] = [
        bitmap,
      ];
      try {
        const source = convert(bitmap, premultipliedBgraFormat, owned);
        const scaler = acquire((out) =>
          invoke(
            factory,
            11,
            [
              "ptr",
            ],
            [
              out,
            ],
          ),
        );
        owned.push(scaler);
        check(
          invoke(
            scaler,
            8,
            [
              "ptr",
              "u32",
              "u32",
              "u32",
            ],
            [
              source,
              width,
              height,
              WIC_INTERPOLATION_LINEAR,
            ],
          ),
        );
        const result = convert(scaler, bgraFormat, owned);
        const rgba = Buffer.alloc(width * height * 4);
        check(
          invoke(
            result,
            7,
            [
              "ptr",
              "u32",
              "u32",
              "ptr",
            ],
            [
              null,
              width * 4,
              rgba.length,
              ptr(rgba),
            ],
          ),
        );
        for (let index = 0; index < rgba.length; index += 4) {
          const blue = rgba[index] ?? 0;
          rgba[index] = rgba[index + 2] ?? 0;
          rgba[index + 2] = blue;
        }
        return {
          width,
          height,
          rgba,
        };
      } finally {
        for (const object of owned.reverse()) {
          release(object);
        }
      }
    },
    encode(pixels: Pixels, mime: ImageMime): Buffer {
      assertActive();
      if (pixels.width === 0) {
        throw new BunawayError({
          code: "INVALID_ARGUMENT",
          message: "Empty images cannot be encoded.",
        });
      }
      if (mime !== "image/png") {
        for (let index = 3; index < pixels.rgba.length; index += 4) {
          if (pixels.rgba[index] !== 255) {
            throw new BunawayError({
              code: "INVALID_ARGUMENT",
              message:
                "JPEG and BMP export require opaque pixels. Use PNG to preserve alpha.",
            });
          }
        }
      }
      const output = Buffer.alloc(MAX_ENCODED_BYTES);
      const target = stream(output);
      const owned: Pointer[] = [
        target,
      ];
      try {
        const bitmap = bitmapFromPixels(pixels);
        owned.push(bitmap);
        const container = guid(containers[mime]);
        const encoder = acquire((out) =>
          invoke(
            factory,
            8,
            [
              "ptr",
              "ptr",
              "ptr",
            ],
            [
              ptr(container),
              null,
              out,
            ],
          ),
        );
        owned.push(encoder);
        check(
          invoke(
            encoder,
            3,
            [
              "ptr",
              "u32",
            ],
            [
              target,
              WIC_ENCODER_NO_CACHE,
            ],
          ),
        );
        const options = new BigUint64Array(1);
        let frame: Pointer;
        try {
          frame = acquire((out) =>
            invoke(
              encoder,
              10,
              [
                "ptr",
                "ptr",
              ],
              [
                out,
                ptr(options),
              ],
            ),
          );
          owned.push(frame);
        } finally {
          if (options[0]) {
            release(Number(options[0]) as Pointer);
          }
        }
        check(
          invoke(
            frame,
            3,
            [
              "ptr",
            ],
            [
              null,
            ],
          ),
        );
        check(
          invoke(
            frame,
            4,
            [
              "u32",
              "u32",
            ],
            [
              pixels.width,
              pixels.height,
            ],
          ),
        );
        const negotiated = guid(mime === "image/png" ? bgraFormat : bgrFormat);
        check(
          invoke(
            frame,
            6,
            [
              "ptr",
            ],
            [
              ptr(negotiated),
            ],
          ),
        );
        if (
          mime === "image/png" &&
          !negotiated.equals(guid(bgraFormat)) &&
          !negotiated.equals(guid(rgbaFormat))
        ) {
          throw new BunawayError({
            code: "INTERNAL",
            message: "Windows PNG encoder cannot preserve RGBA pixels.",
          });
        }
        check(
          invoke(
            frame,
            11,
            [
              "ptr",
              "ptr",
            ],
            [
              bitmap,
              null,
            ],
          ),
        );
        check(invoke(frame, 12, [], []));
        check(invoke(encoder, 11, [], []));
        // Memory streams are fixed-size. Native write failure cannot grow beyond this buffer.
        return Buffer.from(output.subarray(0, encodedLength(output, mime)));
      } finally {
        for (const object of owned.reverse()) {
          release(object);
        }
      }
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      release(factory);
      for (const method of methods.values()) {
        method.close();
      }
      methods.clear();
      storage.clear();
      ole.symbols.CoUninitialize();
      ole.close();
    },
  };
}
