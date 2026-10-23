import { dlopen, ptr } from "bun:ffi";
import { ResourceOwner } from "@bunaway/plugin";
import { OBJC_PATH, OBJC_RUNTIME } from "@bunaway/plugin/darwin";
import { pick } from "@bunaway/plugin/win32";
import { BunawayError } from "@bunaway/protocol";
import { FILE_TYPE_ICON_PIXELS } from "#image/contract";
import type { FileTypeIconSource, Pixels } from "#image/platforms/codec";

const APPKIT = "/System/Library/Frameworks/AppKit.framework/AppKit";
/** NSRect is four doubles: x, y, width, height. */
const NS_RECT_BYTES = 32;
const NS_RECT_WIDTH_OFFSET = 16;
const NS_RECT_HEIGHT_OFFSET = 24;

/** The part of the macOS codec that scales a borrowed CGImage into exact square RGBA. */
type Rasterizer = {
  rasterize(source: bigint, edge: number): Pixels;
};

function failed(message: string): never {
  throw new BunawayError({
    code: "INTERNAL",
    message,
  });
}

function assertNotCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new BunawayError({
      code: "CANCELLED",
      message: "Image creation cancelled.",
    });
  }
}

/**
 * Resolve file type icons through `NSWorkspace iconForFileType:`, which maps an extension to the
 * icon of its registered type without opening any file, so the app needs no storage permission.
 * An unregistered extension gets the generic document icon. The NSImage is drawn at the requested
 * pixel size by `rasterizer`, which returns straight RGBA. Call `dispose` to close the libraries.
 */
export function createFileTypeIconSource(
  rasterizer: Rasterizer,
): FileTypeIconSource {
  const owner = new ResourceOwner("macOS file type icon cleanup failed.");
  // Bun requires a nonempty symbol table even when a framework is only loaded. A failed
  // acquisition disposes the owner, so no library stays open.
  owner.acquire(
    () =>
      dlopen(APPKIT, {
        NSApplicationLoad: {
          args: [],
          returns: "bool",
        },
      } as const),
    (library) => library.close(),
  );
  const runtime = owner.acquire(openRuntime, (library) => library.close());
  // `ptr` returns only an address, so each buffer stays referenced until the call that uses it ends.
  const pinned: Buffer[] = [];
  const cstring = (value: string) => {
    const buffer = Buffer.from(`${value}\0`);
    pinned.push(buffer);
    return ptr(buffer);
  };
  const selector = (name: string) =>
    BigInt(runtime.symbols.sel_registerName(cstring(name)) ?? 0);
  const send = (receiver: bigint, name: string, ...args: bigint[]) =>
    runtime.symbols.objc_msgSend(
      receiver,
      selector(name),
      args[0] ?? 0n,
      args[1] ?? 0n,
      args[2] ?? 0n,
      0n,
    );
  const classOf = (name: string) =>
    BigInt(runtime.symbols.objc_getClass(cstring(name)) ?? 0) ||
    failed(`Objective-C class ${name} is unavailable.`);

  /** Run native work inside an autorelease pool; the NSImage and its CGImage live until it drains. */
  function inPool<T>(work: () => T): T {
    const pool = send(send(classOf("NSAutoreleasePool"), "alloc"), "init");
    try {
      return work();
    } finally {
      send(pool, "drain");
      pinned.length = 0;
    }
  }

  return {
    render(extension, size, signal): Pixels {
      if (owner.disposed) {
        throw new BunawayError({
          code: "CANCELLED",
          message: "File type icon source is closed.",
        });
      }
      assertNotCancelled(signal);
      const edge = FILE_TYPE_ICON_PIXELS[size];
      return inPool(() => {
        // The contract guarantees a leading dot, and the API takes the extension without it.
        const name = send(
          classOf("NSString"),
          "stringWithUTF8String:",
          BigInt(cstring(extension.slice(1))),
        );
        const workspace = send(classOf("NSWorkspace"), "sharedWorkspace");
        const icon =
          name && workspace && send(workspace, "iconForFileType:", name);
        if (!icon) {
          failed("macOS file type icon lookup failed.");
        }
        // The proposed rectangle picks the best representation for the size; the image is borrowed.
        const rect = Buffer.alloc(NS_RECT_BYTES);
        rect.writeDoubleLE(edge, NS_RECT_WIDTH_OFFSET);
        rect.writeDoubleLE(edge, NS_RECT_HEIGHT_OFFSET);
        pinned.push(rect);
        const image = send(
          icon,
          "CGImageForProposedRect:context:hints:",
          BigInt(ptr(rect)),
        );
        if (!image) {
          failed("macOS file type icon image is unavailable.");
        }
        assertNotCancelled(signal);
        return rasterizer.rasterize(image, edge);
      });
    },
    dispose() {
      owner.dispose();
    },
  };
}

function openRuntime() {
  return dlopen(OBJC_PATH, {
    ...pick(OBJC_RUNTIME, "objc_getClass", "sel_registerName"),
    objc_msgSend: {
      args: [
        "u64",
        "u64",
        "u64",
        "u64",
        "u64",
        "u64",
      ],
      returns: "u64",
    },
  } as const);
}
