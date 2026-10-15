import {
  CString,
  dlopen,
  JSCallback,
  linkSymbols,
  type Pointer,
  ptr,
} from "bun:ffi";
import { BunawayError } from "@bunaway/protocol";
import type { AppearancePreferences } from "#appearance/contract";

const APPKIT = "/System/Library/Frameworks/AppKit.framework/AppKit";
const OBJC = "/usr/lib/libobjc.A.dylib";
const SYSTEM = "/usr/lib/libSystem.B.dylib";
const AQUA = "NSAppearanceNameAqua";
const DARK_AQUA = "NSAppearanceNameDarkAqua";
const RTLD_DEFAULT = BigInt.asUintN(64, -2n);

function failure(message: string): never {
  throw new BunawayError({
    code: "INTERNAL",
    message,
  });
}

/**
 * Own plugin-local AppKit bindings on the main thread. Every read drains temporary
 * Cocoa objects and restores the thread's drawing appearance. No settings or
 * Accessibility authorization are changed. Only copied JS values escape a read.
 */
export function initialize() {
  const libraries: {
    close(): void;
  }[] = [];
  try {
    const system = dlopen(SYSTEM, {
      dlsym: {
        args: [
          "u64",
          "cstring",
        ],
        returns: "ptr",
      },
      pthread_main_np: {
        args: [],
        returns: "i32",
      },
    } as const);
    libraries.push(system);
    if (!system.symbols.pthread_main_np()) {
      failure("macOS appearance queries require the AppKit main thread.");
    }
    // Bun requires at least one exported symbol to own a library handle. Linking
    // this public AppKit symbol loads the framework without invoking its initializer.
    const appkit = dlopen(APPKIT, {
      NSApplicationLoad: {
        args: [],
        returns: "bool",
      },
    } as const);
    libraries.push(appkit);
    const stackBlock = system.symbols.dlsym(
      RTLD_DEFAULT,
      "_NSConcreteStackBlock",
    );
    if (!stackBlock) {
      failure("macOS appearance block runtime is unavailable.");
    }
    const runtime = dlopen(OBJC, {
      objc_msgSend: {
        args: [
          "u64",
          "u64",
        ],
        returns: "u64",
      },
      objc_getClass: {
        args: [
          "cstring",
        ],
        returns: "ptr",
      },
      sel_registerName: {
        args: [
          "cstring",
        ],
        returns: "ptr",
      },
    } as const);
    libraries.push(runtime);
    // Bun exposes the linked native address on the callable, but its typings omit it.
    const address: unknown = Reflect.get(runtime.symbols.objc_msgSend, "ptr");
    if (
      typeof address !== "number" ||
      !Number.isSafeInteger(address) ||
      address <= 0
    ) {
      failure("macOS appearance runtime is unavailable.");
    }
    const message = address as Pointer;
    const messages = linkSymbols({
      object: {
        ptr: message,
        args: [
          "u64",
          "u64",
          "u64",
          "u64",
        ],
        returns: "u64",
      },
      string: {
        ptr: message,
        args: [
          "u64",
          "u64",
          "cstring",
        ],
        returns: "u64",
      },
      boolean: {
        ptr: message,
        args: [
          "u64",
          "u64",
        ],
        returns: "bool",
      },
      component: {
        ptr: message,
        args: [
          "u64",
          "u64",
        ],
        returns: "f64",
      },
      drawing: {
        ptr: message,
        args: [
          "u64",
          "u64",
          "ptr",
        ],
        returns: "void",
      },
    } as const);
    libraries.push(messages);
    const selectors = new Map<string, bigint>();
    const selector = (name: string): bigint => {
      const cached = selectors.get(name);
      if (cached !== undefined) {
        return cached;
      }
      const address = runtime.symbols.sel_registerName(name);
      if (!address) {
        failure("macOS appearance selector is unavailable.");
      }
      const value = BigInt(address);
      selectors.set(name, value);
      return value;
    };
    const type = (name: string): bigint => {
      const address = runtime.symbols.objc_getClass(name);
      if (!address) {
        failure("macOS appearance class is unavailable.");
      }
      return BigInt(address);
    };
    // Tagged NSString objects can occupy all 64 bits; never round them through Number.
    const send = (
      object: bigint,
      name: string,
      first = 0n,
      second = 0n,
    ): bigint =>
      BigInt(messages.symbols.object(object, selector(name), first, second));
    let reads = 0;
    const required = (object: bigint, operation: string): bigint => {
      if (object === 0n) {
        failure(
          `macOS appearance query returned no value: ${operation} (read=${reads}, mainThread=${system.symbols.pthread_main_np()}).`,
        );
      }
      return object;
    };
    // A numeric pointer cannot keep a temporary Buffer alive while later arguments
    // allocate. Let Bun own UTF-8 conversion for the duration of each native call.
    const string = (value: string) =>
      required(
        BigInt(
          messages.symbols.string(
            type("NSString"),
            selector("stringWithUTF8String:"),
            value,
          ),
        ),
        `NSString.stringWithUTF8String: ${value}`,
      );
    const boolean = (object: bigint, name: string) =>
      messages.symbols.boolean(object, selector(name));
    const color = (name: string): string => {
      const native = required(send(type("NSColor"), name), `NSColor.${name}`);
      const space = required(
        send(type("NSColorSpace"), "sRGBColorSpace"),
        "NSColorSpace.sRGBColorSpace",
      );
      const rgb = required(
        send(native, "colorUsingColorSpace:", space),
        `NSColor.${name}.colorUsingColorSpace: sRGB`,
      );
      const components = [
        "redComponent",
        "greenComponent",
        "blueComponent",
      ].map((name) => {
        const value = messages.symbols.component(rgb, selector(name));
        if (!Number.isFinite(value)) {
          failure("macOS appearance color is invalid.");
        }
        // sRGB conversion may put a wide-gamut component outside the CSS RGB range.
        return Math.round(Math.max(0, Math.min(1, value)) * 255)
          .toString(16)
          .padStart(2, "0");
      });
      return `#${components.join("")}`;
    };
    let disposed = false;
    return {
      read(): AppearancePreferences {
        if (disposed) {
          throw new BunawayError({
            code: "CANCELLED",
            message: "Appearance adapter is disposed.",
          });
        }
        reads++;
        const allocated = required(
          send(type("NSAutoreleasePool"), "alloc"),
          "NSAutoreleasePool.alloc",
        );
        const pool = required(
          send(allocated, "init"),
          "NSAutoreleasePool.init",
        );
        try {
          const application = required(
            send(type("NSApplication"), "sharedApplication"),
            "NSApplication.sharedApplication",
          );
          const appearance = required(
            send(application, "effectiveAppearance"),
            "NSApplication.effectiveAppearance",
          );
          const names = required(
            send(type("NSArray"), "arrayWithObject:", string(AQUA)),
            "NSArray.arrayWithObject:",
          );
          const choices = required(
            send(names, "arrayByAddingObject:", string(DARK_AQUA)),
            "NSArray.arrayByAddingObject:",
          );
          const match = send(
            appearance,
            "bestMatchFromAppearancesWithNames:",
            choices,
          );
          const text = match === 0n ? 0n : send(match, "UTF8String");
          // UTF8String is an ordinary memory address, unlike the tagged NSString above.
          const name =
            text === 0n ? "" : new CString(Number(text) as Pointer).toString();
          let appsTheme: AppearancePreferences["appsTheme"] = null;
          if (name === AQUA) {
            appsTheme = "light";
          } else if (name === DARK_AQUA) {
            appsTheme = "dark";
          }
          const workspace = required(
            send(type("NSWorkspace"), "sharedWorkspace"),
            "NSWorkspace.sharedWorkspace",
          );
          let result: AppearancePreferences | undefined;
          let failed = false;
          let cause: unknown;
          // AppKit invokes this NS_NOESCAPE block synchronously on the owning main
          // thread and restores its drawing state. Never throw across the native ABI.
          const callback = new JSCallback(
            () => {
              try {
                result = {
                  appsTheme,
                  systemTheme: null,
                  accentColor: color("controlAccentColor"),
                  highContrast: boolean(
                    workspace,
                    "accessibilityDisplayShouldIncreaseContrast",
                  ),
                  // Increase Contrast adjusts AppKit drawing; macOS does not force a color palette.
                  forcedColors: false,
                  reducedMotion: boolean(
                    workspace,
                    "accessibilityDisplayShouldReduceMotion",
                  ),
                  transparencyEnabled: !boolean(
                    workspace,
                    "accessibilityDisplayShouldReduceTransparency",
                  ),
                  screenReaderEnabled: boolean(workspace, "isVoiceOverEnabled"),
                  colors: {
                    window: color("windowBackgroundColor"),
                    windowText: color("textColor"),
                    highlight: color("selectedTextBackgroundColor"),
                    highlightText: color("selectedTextColor"),
                  },
                };
              } catch (error) {
                failed = true;
                cause = error;
              }
            },
            {
              args: [
                "ptr",
              ],
              returns: "void",
            },
          );
          const descriptor = Buffer.alloc(16);
          descriptor.writeBigUInt64LE(32n, 8);
          const block = Buffer.alloc(32);
          block.writeBigUInt64LE(BigInt(stackBlock), 0);
          block.writeBigUInt64LE(BigInt(callback.ptr ?? 0), 16);
          block.writeBigUInt64LE(BigInt(ptr(descriptor)), 24);
          try {
            messages.symbols.drawing(
              appearance,
              selector("performAsCurrentDrawingAppearance:"),
              ptr(block),
            );
            if (failed) {
              throw cause;
            }
            if (!result) {
              failure("macOS appearance drawing callback did not run.");
            }
            return result;
          } finally {
            // Keep both buffers live across the synchronous callback, then release
            // the callback trampoline. The NS_NOESCAPE block cannot outlive this call.
            block.fill(0);
            descriptor.fill(0);
            callback.close();
          }
        } finally {
          send(pool, "drain");
        }
      },
      dispose() {
        if (disposed) {
          return;
        }
        disposed = true;
        selectors.clear();
        for (const library of libraries.reverse()) {
          library.close();
        }
      },
    };
  } catch (error) {
    for (const library of libraries.reverse()) {
      library.close();
    }
    throw error;
  }
}

export function dispose(instance: ReturnType<typeof initialize>) {
  instance.dispose();
}
