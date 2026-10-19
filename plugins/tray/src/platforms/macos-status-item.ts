import { CString, dlopen, JSCallback, type Pointer, ptr } from "bun:ffi";
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

/** The status item as AppKit sees it. Every call must run on the main thread. */
export type StatusItemBinding = {
  setTitle(title: string): void;
  setTooltip(tooltip: string): void;
  /** Replaces the attached menu; null removes it. */
  setMenu(entries: readonly NativeMenuEntry[] | null): void;
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
 * pointers. Each call drains its own autorelease pool. `dispose` removes the item, detaches and
 * releases the menu and target, and only then closes the callback, so AppKit cannot call a closed
 * trampoline. The target class is registered once per binding and lives until process exit because
 * the Objective-C runtime cannot safely unregister a class that menus may still reference.
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
  const closeAll = () => {
    for (const resource of resources.splice(0).reverse()) {
      resource.close();
    }
  };
  try {
    // Bun requires a nonempty symbol table even when a framework is only loaded.
    own(
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
    const selectors = new Map<string, bigint>();
    const cstring = (value: string) => ptr(Buffer.from(`${value}\0`));
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
      }
    };

    // The menu action target is a fresh NSObject subclass with one method that reports the tag.
    let accepting = true;
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
    const targetClass = runtime.symbols.objc_allocateClassPair(
      Number(classOf("NSObject")) as Pointer,
      `BunawayTrayTarget${crypto.randomUUID().replaceAll("-", "")}`,
      0,
    );
    if (
      !targetClass ||
      !runtime.symbols.class_addMethod(
        targetClass,
        Number(selector(SELECTED_SELECTOR)) as Pointer,
        callback.ptr,
        SELECTED_ENCODING,
      )
    ) {
      internal("Objective-C menu target registration failed.");
    }
    runtime.symbols.objc_registerClassPair(targetClass);
    const target = required(
      send(send(BigInt(targetClass), "alloc"), "init"),
      "Menu target",
    );
    const bar = send(classOf("NSStatusBar"), "systemStatusBar");
    const item = required(
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
    const button = required(send(item, "button"), "Status item button");
    let menu = 0n;
    let disposed = false;
    const releaseMenu = () => {
      if (menu) {
        send(item, "setMenu:", 0n);
        send(menu, "release");
        menu = 0n;
      }
    };
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
          return {
            title: text(send(button, "title")),
            tooltip: text(send(button, "toolTip")),
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
        accepting = false;
        inPool(() => {
          releaseMenu();
          send(bar, "removeStatusItem:", item);
          send(item, "release");
          send(target, "release");
        });
        closeAll();
      },
    };
  } catch (error) {
    closeAll();
    throw error;
  }
}
