import { CString, dlopen, JSCallback, type Pointer, ptr } from "bun:ffi";
import { attemptAll } from "@bunaway/plugin";
import {
  LIBSYSTEM,
  LIBSYSTEM_PATH,
  OBJC_PATH as OBJC,
  OBJC_RUNTIME,
} from "@bunaway/plugin/darwin";
import { pick } from "@bunaway/plugin/win32";
import { BunawayError } from "@bunaway/protocol";

const APPKIT = "/System/Library/Frameworks/AppKit.framework/AppKit";
/** NSVariableStatusItemLength: the item is as wide as its title. */
const NS_VARIABLE_STATUS_ITEM_LENGTH = -1;
/** Selector sent to the menu target; `v@:@` is void return, self, selector and sender. */
const SELECTED_SELECTOR = "bunawayTrayMenuItemSelected:";
const SELECTED_ENCODING = "v@:@";

/** One menu entry handed to AppKit; `tag` is reported back when the entry is chosen. */
export type NativeMenuEntry =
  | {
      kind: "separator";
    }
  | {
      kind: "item";
      label: string;
      enabled: boolean;
      tag: number;
    };

/** NSImageLeft: the image sits before the title, and alone when the title is empty. */
const NS_IMAGE_LEFT = 2n;
/** NSImageNoImage: the button shows only its title. */
const NS_NO_IMAGE = 0n;

/** PNG bytes for the button with the size AppKit should draw them at, in points. */
export type NativeImage = {
  data: Uint8Array;
  widthPoints: number;
  heightPoints: number;
  template: boolean;
  description: string;
};

/** The status item as AppKit sees it. Every call must run on the main thread. */
export type StatusItemBinding = {
  setTitle(title: string): void;
  setTooltip(tooltip: string): void;
  /** Replaces the attached menu; null removes it. */
  setMenu(entries: readonly NativeMenuEntry[] | null): void;
  /**
   * Replaces the button image; null removes it. Throws INVALID_ARGUMENT when AppKit cannot decode
   * the bytes, and keeps the previous image in that case.
   */
  setImage(image: NativeImage | null): void;
  /**
   * Reads the title, tooltip and menu back from AppKit rather than from the adapter's copy, so the
   * macOS native check can prove that what the adapter reports is what the menu bar item holds.
   */
  readBack(): StatusItemReadBack;
  /**
   * Chooses the menu entry at `index` through AppKit's own action dispatch, the same path a click
   * or keyboard activation takes. Disabled entries and separators do nothing.
   */
  activate(index: number): void;
  /** Removes the item from the menu bar and releases every native object. Safe to repeat. */
  dispose(): void;
};

/** Live AppKit state of the status item. */
export type StatusItemReadBack = {
  title: string;
  tooltip: string;
  /** Null when the button has no image. Pixels come from the decoded bitmap, not from the request. */
  image: {
    template: boolean;
    description: string;
    pixelsWide: number;
    pixelsHigh: number;
  } | null;
  /** Null when no menu is attached. */
  menu:
    | {
        separator: boolean;
        title: string;
        enabled: boolean;
      }[]
    | null;
};

function internal(message: string): never {
  throw new BunawayError({
    code: "INTERNAL",
    message,
  });
}

/**
 * Creates one NSStatusItem as wide as its title and reports chosen menu entries to `onSelect` with
 * their tag. Objects returned by Objective-C stay unsigned 64-bit integers, including tagged
 * pointers. Each call, including creation, drains its own autorelease pool. `dispose` and a failed
 * creation detach and release the menu, remove the item, release the item and the target, and only
 * then close the callback, so AppKit cannot call a closed trampoline. Each binding registers its
 * own target class, which lives until process exit: the Objective-C runtime cannot safely
 * unregister a class that menus may still reference, so repeated create and destroy accumulate
 * classes. If registering the method fails, the unregistered class pair is disposed.
 */
export function createStatusItem(
  onSelect: (tag: number) => void,
): StatusItemBinding {
  const resources: {
    close(): void;
  }[] = [];
  const own = <
    T extends {
      close(): void;
    },
  >(
    resource: T,
  ): T => {
    resources.push(resource);
    return resource;
  };
  // A failing close must not leave the later resources open, so every one is attempted.
  const closeAll = () =>
    attemptAll(
      resources
        .splice(0)
        .reverse()
        .map((resource) => () => resource.close()),
      "The menu bar item could not release every native resource.",
    );
  try {
    // Bun requires a nonempty symbol table even when a framework is only loaded.
    const appkit = own(
      dlopen(APPKIT, {
        NSApplicationLoad: {
          args: [],
          returns: "bool",
        },
      } as const),
    );
    const system = own(
      dlopen(LIBSYSTEM_PATH, pick(LIBSYSTEM, "pthread_main_np")),
    );
    if (!system.symbols.pthread_main_np()) {
      throw new BunawayError({
        code: "UNSUPPORTED",
        message: "The menu bar item requires the macOS main thread.",
      });
    }
    // The status bar needs the shared application object and its window server connection.
    if (!appkit.symbols.NSApplicationLoad()) {
      internal("AppKit could not initialize the application object.");
    }
    const runtime = own(
      dlopen(OBJC, {
        ...pick(OBJC_RUNTIME, "objc_getClass", "sel_registerName"),
        objc_allocateClassPair: {
          args: [
            "ptr",
            "cstring",
            "usize",
          ],
          returns: "ptr",
        },
        objc_disposeClassPair: {
          args: [
            "ptr",
          ],
          returns: "void",
        },
        objc_registerClassPair: {
          args: [
            "ptr",
          ],
          returns: "void",
        },
        class_addMethod: {
          args: [
            "ptr",
            "ptr",
            "ptr",
            "cstring",
          ],
          returns: "bool",
        },
        objc_msgSend: {
          args: [
            "u64",
            "u64",
            "u64",
            "u64",
            "u64",
          ],
          returns: "u64",
        },
      } as const),
    );
    // A second table for the one message that takes a floating-point argument.
    const lengthSender = own(
      dlopen(OBJC, {
        objc_msgSend: {
          args: [
            "u64",
            "u64",
            "f64",
          ],
          returns: "u64",
        },
      } as const),
    );
    // A third table for `setSize:`, whose NSSize argument travels as two doubles.
    const sizeSender = own(
      dlopen(OBJC, {
        objc_msgSend: {
          args: [
            "u64",
            "u64",
            "f64",
            "f64",
          ],
          returns: "u64",
        },
      } as const),
    );
    const selectors = new Map<string, bigint>();
    // `ptr` returns only an address, so the buffers stay referenced until the next pool drain
    // and cannot be collected between building an argument and the native call that reads it.
    const pinned: Buffer[] = [];
    const cstring = (value: string) => {
      const buffer = Buffer.from(`${value}\0`);
      pinned.push(buffer);
      return ptr(buffer);
    };
    const selector = (name: string) => {
      let value = selectors.get(name);
      if (value === undefined) {
        value = BigInt(runtime.symbols.sel_registerName(cstring(name)) ?? 0);
        selectors.set(name, value);
      }
      return value;
    };
    const classOf = (name: string) => {
      const value = BigInt(runtime.symbols.objc_getClass(cstring(name)) ?? 0);
      return value || internal(`Objective-C class ${name} is unavailable.`);
    };
    const send = (object: bigint, name: string, ...args: (bigint | number)[]) =>
      runtime.symbols.objc_msgSend(
        object,
        selector(name),
        BigInt(args[0] ?? 0),
        BigInt(args[1] ?? 0),
        BigInt(args[2] ?? 0),
      );
    const required = (object: bigint, what: string) =>
      object || internal(`${what} could not be created.`);
    const string = (value: string) =>
      required(
        send(
          classOf("NSString"),
          "stringWithUTF8String:",
          BigInt(cstring(value)),
        ),
        "NSString",
      );
    const inPool = <T>(work: () => T): T => {
      const pool = required(
        send(send(classOf("NSAutoreleasePool"), "alloc"), "init"),
        "NSAutoreleasePool",
      );
      try {
        return work();
      } finally {
        send(pool, "drain");
        pinned.length = 0;
      }
    };

    // Everything created below is owned by one resource, registered before the first native
    // object exists, so a failure at any step releases exactly what was created so far.
    let accepting = true;
    let target = 0n;
    let item = 0n;
    let menu = 0n;
    const releaseMenu = () => {
      if (menu) {
        send(item, "setMenu:", 0n);
        send(menu, "release");
        menu = 0n;
      }
    };
    // The menu action target is a fresh NSObject subclass with one method that reports the tag.
    const callback = own(
      new JSCallback(
        (_self, _command, sender) => {
          if (accepting && sender) {
            onSelect(Number(send(BigInt(sender), "tag")));
          }
        },
        {
          args: [
            "ptr",
            "ptr",
            "ptr",
          ],
          returns: "void",
        } as const,
      ),
    );
    // Registered after the callback, so closing runs in reverse: detach the menu, remove the item
    // from the bar, release it and the target, and only then close the callback and the handles.
    own({
      close() {
        accepting = false;
        inPool(() => {
          releaseMenu();
          if (item) {
            send(
              send(classOf("NSStatusBar"), "systemStatusBar"),
              "removeStatusItem:",
              item,
            );
            send(item, "release");
            item = 0n;
          }
          if (target) {
            send(target, "release");
            target = 0n;
          }
        });
      },
    });
    const targetClass = runtime.symbols.objc_allocateClassPair(
      Number(classOf("NSObject")) as Pointer,
      `BunawayTrayTarget${crypto.randomUUID().replaceAll("-", "")}`,
      0,
    );
    if (!targetClass) {
      internal("Objective-C menu target allocation failed.");
    }
    if (
      !runtime.symbols.class_addMethod(
        targetClass,
        Number(selector(SELECTED_SELECTOR)) as Pointer,
        callback.ptr,
        SELECTED_ENCODING,
      )
    ) {
      // The pair is not registered yet, so no instance can exist and it can be disposed.
      runtime.symbols.objc_disposeClassPair(targetClass);
      internal("Objective-C menu target registration failed.");
    }
    runtime.symbols.objc_registerClassPair(targetClass);
    // The status bar hands out an autoreleased item, so the creation calls share one pool and the
    // item is retained for as long as this binding owns it.
    const button = inPool(() => {
      target = required(
        send(send(BigInt(targetClass), "alloc"), "init"),
        "Menu target",
      );
      const bar = send(classOf("NSStatusBar"), "systemStatusBar");
      item = required(
        send(
          lengthSender.symbols.objc_msgSend(
            bar,
            selector("statusItemWithLength:"),
            NS_VARIABLE_STATUS_ITEM_LENGTH,
          ),
          "retain",
        ),
        "Status item",
      );
      return required(send(item, "button"), "Status item button");
    });
    let disposed = false;
    const buildMenu = (entries: readonly NativeMenuEntry[]) => {
      const built = required(
        send(send(classOf("NSMenu"), "alloc"), "init"),
        "NSMenu",
      );
      try {
        // Disabled entries stay disabled instead of being re-enabled by responder validation.
        send(built, "setAutoenablesItems:", 0n);
        for (const entry of entries) {
          if (entry.kind === "separator") {
            send(
              built,
              "addItem:",
              send(classOf("NSMenuItem"), "separatorItem"),
            );
            continue;
          }
          const created = required(
            send(
              send(classOf("NSMenuItem"), "alloc"),
              "initWithTitle:action:keyEquivalent:",
              string(entry.label),
              selector(SELECTED_SELECTOR),
              string(""),
            ),
            "NSMenuItem",
          );
          try {
            send(created, "setTarget:", target);
            send(created, "setTag:", entry.tag);
            send(created, "setEnabled:", entry.enabled ? 1n : 0n);
            send(built, "addItem:", created);
          } finally {
            send(created, "release");
          }
        }
        return built;
      } catch (error) {
        send(built, "release");
        throw error;
      }
    };
    // Returns an owned NSImage (+1) that the caller releases once the button holds it.
    const decodeImage = (image: NativeImage) => {
      const bytes = Buffer.from(image.data);
      pinned.push(bytes);
      const data = required(
        send(
          classOf("NSData"),
          "dataWithBytes:length:",
          BigInt(ptr(bytes)),
          bytes.length,
        ),
        "NSData",
      );
      const decoded = send(
        send(classOf("NSImage"), "alloc"),
        "initWithData:",
        data,
      );
      if (!decoded) {
        throw new BunawayError({
          code: "INVALID_ARGUMENT",
          message: "The tray image could not be decoded as a PNG.",
        });
      }
      try {
        sizeSender.symbols.objc_msgSend(
          decoded,
          selector("setSize:"),
          image.widthPoints,
          image.heightPoints,
        );
        send(decoded, "setTemplate:", image.template ? 1n : 0n);
        if (image.description) {
          send(
            decoded,
            "setAccessibilityDescription:",
            string(image.description),
          );
        }
        return decoded;
      } catch (error) {
        send(decoded, "release");
        throw error;
      }
    };
    const active = () => {
      if (disposed) {
        throw new BunawayError({
          code: "CANCELLED",
          message: "The menu bar item is disposed.",
        });
      }
    };
    return {
      setTitle(title) {
        active();
        inPool(() => send(button, "setTitle:", string(title)));
      },
      setTooltip(tooltip) {
        active();
        inPool(() => send(button, "setToolTip:", string(tooltip)));
      },
      setMenu(entries) {
        active();
        inPool(() => {
          // Build first so a failed rebuild keeps the previous menu attached.
          const next = entries ? buildMenu(entries) : 0n;
          releaseMenu();
          if (next) {
            send(item, "setMenu:", next);
            menu = next;
          }
        });
      },
      setImage(image) {
        active();
        inPool(() => {
          // Decode first so a failed replacement keeps the previous image.
          const next = image ? decodeImage(image) : 0n;
          try {
            send(button, "setImage:", next);
            send(
              button,
              "setImagePosition:",
              next ? NS_IMAGE_LEFT : NS_NO_IMAGE,
            );
          } finally {
            // The button retains what it displays; drop the reference decoding created.
            if (next) {
              send(next, "release");
            }
          }
        });
      },
      readBack() {
        active();
        return inPool(() => {
          const text = (object: bigint) => {
            const bytes = send(object, "UTF8String");
            return bytes
              ? new CString(Number(bytes) as Pointer).toString()
              : "";
          };
          // BOOL is one byte; the upper register bits are unspecified.
          const flag = (object: bigint, name: string) =>
            (send(object, name) & 0xffn) !== 0n;
          const shown = send(button, "image");
          const representation = shown
            ? send(send(shown, "representations"), "firstObject")
            : 0n;
          return {
            title: text(send(button, "title")),
            tooltip: text(send(button, "toolTip")),
            image: shown
              ? {
                  template: flag(shown, "isTemplate"),
                  description: text(send(shown, "accessibilityDescription")),
                  pixelsWide: Number(send(representation, "pixelsWide")),
                  pixelsHigh: Number(send(representation, "pixelsHigh")),
                }
              : null,
            menu: menu
              ? Array.from(
                  {
                    length: Number(send(menu, "numberOfItems")),
                  },
                  (_, index) => {
                    const entry = send(menu, "itemAtIndex:", index);
                    return {
                      separator: flag(entry, "isSeparatorItem"),
                      title: text(send(entry, "title")),
                      enabled: flag(entry, "isEnabled"),
                    };
                  },
                )
              : null,
          };
        });
      },
      activate(index) {
        active();
        inPool(() => {
          if (menu) {
            send(menu, "performActionForItemAtIndex:", index);
          }
        });
      },
      dispose() {
        if (disposed) {
          return;
        }
        disposed = true;
        closeAll();
      },
    };
  } catch (error) {
    closeAll();
    throw error;
  }
}
