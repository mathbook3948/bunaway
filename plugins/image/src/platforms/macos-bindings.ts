import { dlopen, type Pointer, ptr, read } from "bun:ffi";

const CORE_FOUNDATION =
  "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation";
const CORE_GRAPHICS =
  "/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics";
const IMAGE_IO = "/System/Library/Frameworks/ImageIO.framework/ImageIO";
const ACCELERATE = "/System/Library/Frameworks/Accelerate.framework/Accelerate";

/** Load only system frameworks. Every FFI wrapper and explicit dlopen handle belongs to the codec. */
export function openImageBindings() {
  const cleanup: (() => void)[] = [];
  try {
    const system = dlopen("/usr/lib/libSystem.B.dylib", {
      dlopen: {
        args: [
          "cstring",
          "i32",
        ],
        returns: "ptr",
      },
      dlsym: {
        args: [
          "ptr",
          "cstring",
        ],
        returns: "ptr",
      },
      dlclose: {
        args: [
          "ptr",
        ],
        returns: "i32",
      },
    } as const);
    cleanup.push(() => system.close());
    function global(path: string, name: string): Pointer {
      const handle = system.symbols.dlopen(ptr(Buffer.from(`${path}\0`)), 1);
      if (!handle) {
        throw new Error(`Cannot load image framework: ${path}`);
      }
      cleanup.push(() => {
        system.symbols.dlclose(handle);
      });
      const address = system.symbols.dlsym(
        handle,
        ptr(Buffer.from(`${name}\0`)),
      );
      if (!address) {
        throw new Error(`Missing image framework constant: ${name}`);
      }
      // Framework globals are immutable CF object pointers, borrowed until the handle closes.
      const value = read.ptr(address);
      if (!value) {
        throw new Error(`Invalid image framework constant: ${name}`);
      }
      return value as Pointer;
    }
    const cf = dlopen(CORE_FOUNDATION, {
      CFRelease: {
        args: [
          "ptr",
        ],
        returns: "void",
      },
      CFEqual: {
        args: [
          "ptr",
          "ptr",
        ],
        returns: "bool",
      },
      CFStringCreateWithCString: {
        args: [
          "ptr",
          "cstring",
          "u32",
        ],
        returns: "ptr",
      },
      CFDataCreate: {
        args: [
          "ptr",
          "ptr",
          "i64",
        ],
        returns: "ptr",
      },
      CFDataCreateMutable: {
        args: [
          "ptr",
          "i64",
        ],
        returns: "ptr",
      },
      CFDataGetLength: {
        args: [
          "ptr",
        ],
        returns: "i64",
      },
      CFDataGetBytePtr: {
        args: [
          "ptr",
        ],
        returns: "ptr",
      },
      CFDictionaryCreate: {
        args: [
          "ptr",
          "ptr",
          "ptr",
          "i64",
          "ptr",
          "ptr",
        ],
        returns: "ptr",
      },
      CFDictionaryGetValue: {
        args: [
          "ptr",
          "ptr",
        ],
        returns: "ptr",
      },
      CFNumberGetValue: {
        args: [
          "ptr",
          "i32",
          "ptr",
        ],
        returns: "bool",
      },
    } as const);
    cleanup.push(() => cf.close());
    const cg = dlopen(CORE_GRAPHICS, {
      CGColorSpaceCreateDeviceRGB: {
        args: [],
        returns: "ptr",
      },
      CGDataProviderCreateWithCFData: {
        args: [
          "ptr",
        ],
        returns: "ptr",
      },
      CGImageCreate: {
        args: [
          "usize",
          "usize",
          "usize",
          "usize",
          "usize",
          "ptr",
          "u32",
          "ptr",
          "ptr",
          "bool",
          "i32",
        ],
        returns: "ptr",
      },
      CGImageGetWidth: {
        args: [
          "ptr",
        ],
        returns: "usize",
      },
      CGImageGetHeight: {
        args: [
          "ptr",
        ],
        returns: "usize",
      },
      CGBitmapContextCreate: {
        args: [
          "ptr",
          "usize",
          "usize",
          "usize",
          "usize",
          "ptr",
          "u32",
        ],
        returns: "ptr",
      },
      CGContextSetInterpolationQuality: {
        args: [
          "ptr",
          "i32",
        ],
        returns: "void",
      },
      CGContextSetBlendMode: {
        args: [
          "ptr",
          "i32",
        ],
        returns: "void",
      },
      // On arm64 CGRect is a homogeneous aggregate in d0-d3, with the image in x1.
      // This flattened declaration is not the x86_64 CGRect ABI; the codec rejects that target.
      CGContextDrawImage: {
        args: [
          "ptr",
          "f64",
          "f64",
          "f64",
          "f64",
          "ptr",
        ],
        returns: "void",
      },
    } as const);
    cleanup.push(() => cg.close());
    const io = dlopen(IMAGE_IO, {
      CGImageSourceCreateWithData: {
        args: [
          "ptr",
          "ptr",
        ],
        returns: "ptr",
      },
      CGImageSourceGetType: {
        args: [
          "ptr",
        ],
        returns: "ptr",
      },
      CGImageSourceGetCount: {
        args: [
          "ptr",
        ],
        returns: "usize",
      },
      CGImageSourceGetStatus: {
        args: [
          "ptr",
        ],
        returns: "i32",
      },
      CGImageSourceGetStatusAtIndex: {
        args: [
          "ptr",
          "usize",
        ],
        returns: "i32",
      },
      CGImageSourceCopyPropertiesAtIndex: {
        args: [
          "ptr",
          "usize",
          "ptr",
        ],
        returns: "ptr",
      },
      CGImageSourceCreateImageAtIndex: {
        args: [
          "ptr",
          "usize",
          "ptr",
        ],
        returns: "ptr",
      },
      CGImageDestinationCreateWithData: {
        args: [
          "ptr",
          "ptr",
          "usize",
          "ptr",
        ],
        returns: "ptr",
      },
      CGImageDestinationAddImage: {
        args: [
          "ptr",
          "ptr",
          "ptr",
        ],
        returns: "void",
      },
      CGImageDestinationFinalize: {
        args: [
          "ptr",
        ],
        returns: "bool",
      },
    } as const);
    cleanup.push(() => io.close());
    const accelerate = dlopen(ACCELERATE, {
      vImageBuffer_InitWithCGImage: {
        args: [
          "ptr",
          "ptr",
          "ptr",
          "ptr",
          "u32",
        ],
        returns: "i64",
      },
    } as const);
    cleanup.push(() => accelerate.close());
    const keys = {
      width: global(IMAGE_IO, "kCGImagePropertyPixelWidth"),
      height: global(IMAGE_IO, "kCGImagePropertyPixelHeight"),
      cache: global(IMAGE_IO, "kCGImageSourceShouldCache"),
      false: global(CORE_FOUNDATION, "kCFBooleanFalse"),
    };
    return {
      cf: cf.symbols,
      cg: cg.symbols,
      io: io.symbols,
      accelerate: accelerate.symbols,
      keys,
      close() {
        for (const action of cleanup.splice(0).reverse()) {
          action();
        }
      },
    };
  } catch (error) {
    for (const action of cleanup.reverse()) {
      action();
    }
    throw error;
  }
}
