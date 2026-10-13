import { dlopen, linkSymbols, ptr } from "bun:ffi";
import { BunawayError } from "@bunaway/protocol";

const OBJC = "/usr/lib/libobjc.A.dylib";
const APPKIT = "/System/Library/Frameworks/AppKit.framework/AppKit";
const RTLD_LAZY = 1;

/** Synchronous NSWorkspace request acceptance, without launching a shell. */
export type MacosWorkspace = {
  openUrl(url: string): void;
  openFile(path: string): void;
  revealFile(path: string): void;
  dispose(): void;
};

/** Own only opener's bindings; no application delegate or host run loop is installed. */
export function createWorkspace(): MacosWorkspace {
  const system = dlopen("/usr/lib/libSystem.B.dylib", {
    dlopen: {
      args: [
        "ptr",
        "i32",
      ],
      returns: "ptr",
    },
    dlclose: {
      args: [
        "ptr",
      ],
      returns: "i32",
    },
    dlsym: {
      args: [
        "ptr",
        "ptr",
      ],
      returns: "ptr",
    },
  });
  const runtime = (() => {
    try {
      return dlopen(OBJC, {
        objc_getClass: {
          args: [
            "ptr",
          ],
          returns: "u64",
        },
        sel_registerName: {
          args: [
            "ptr",
          ],
          returns: "ptr",
        },
      });
    } catch (error) {
      system.close();
      throw error;
    }
  })();
  const appkit = system.symbols.dlopen(
    ptr(Buffer.from(`${APPKIT}\0`)),
    RTLD_LAZY,
  );
  const objc = system.symbols.dlopen(ptr(Buffer.from(`${OBJC}\0`)), RTLD_LAZY);
  const close = () => {
    if (appkit) {
      system.symbols.dlclose(appkit);
    }
    if (objc) {
      system.symbols.dlclose(objc);
    }
    runtime.close();
    system.close();
  };
  const address =
    objc && system.symbols.dlsym(objc, ptr(Buffer.from("objc_msgSend\0")));
  if (!appkit || !address) {
    close();
    throw new BunawayError({
      code: "INTERNAL",
      message: "Opener could not load NSWorkspace.",
    });
  }
  const messages = (() => {
    try {
      return linkSymbols({
        // Cocoa objects, including tagged NSStrings, keep all 64 address bits.
        object: {
          ptr: address,
          args: [
            "u64",
            "ptr",
            "u64",
          ],
          returns: "u64",
        },
        boolean: {
          ptr: address,
          args: [
            "u64",
            "ptr",
            "u64",
            "u64",
          ],
          returns: "bool",
        },
        void: {
          ptr: address,
          args: [
            "u64",
            "ptr",
          ],
          returns: "void",
        },
      });
    } catch (error) {
      close();
      throw error;
    }
  })();
  const selector = (name: string) =>
    runtime.symbols.sel_registerName(ptr(Buffer.from(`${name}\0`)));
  const object = (receiver: bigint, name: string, argument = 0n) =>
    messages.symbols.object(receiver, selector(name), argument);
  const type = (name: string) =>
    runtime.symbols.objc_getClass(ptr(Buffer.from(`${name}\0`)));
  const string = (value: string) => {
    const result = object(
      type("NSString"),
      "stringWithUTF8String:",
      BigInt(ptr(Buffer.from(`${value}\0`))),
    );
    if (!result) {
      throw new BunawayError({
        code: "INTERNAL",
        message: "Opener could not encode its input.",
      });
    }
    return result;
  };
  let disposed = false;
  const request = (work: (workspace: bigint) => boolean) => {
    if (disposed) {
      throw new BunawayError({
        code: "CANCELLED",
        message: "Opener has been disposed.",
      });
    }
    const pool = object(object(type("NSAutoreleasePool"), "alloc"), "init");
    if (!pool) {
      throw new BunawayError({
        code: "INTERNAL",
        message: "Opener could not prepare its autorelease pool.",
      });
    }
    try {
      const workspace = object(type("NSWorkspace"), "sharedWorkspace");
      if (!workspace || !work(workspace)) {
        throw new BunawayError({
          code: "INTERNAL",
          message: "NSWorkspace did not accept the opener request.",
        });
      }
    } finally {
      messages.symbols.void(pool, selector("drain"));
    }
  };
  return {
    openUrl(url) {
      request((workspace) => {
        const target = object(type("NSURL"), "URLWithString:", string(url));
        return (
          target !== 0n &&
          messages.symbols.boolean(workspace, selector("openURL:"), target, 0n)
        );
      });
    },
    openFile(path) {
      request((workspace) => {
        const target = object(type("NSURL"), "fileURLWithPath:", string(path));
        return (
          target !== 0n &&
          messages.symbols.boolean(workspace, selector("openURL:"), target, 0n)
        );
      });
    },
    revealFile(path) {
      request((workspace) =>
        messages.symbols.boolean(
          workspace,
          selector("selectFile:inFileViewerRootedAtPath:"),
          string(path),
          string(""),
        ),
      );
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      messages.close();
      close();
    },
  };
}
