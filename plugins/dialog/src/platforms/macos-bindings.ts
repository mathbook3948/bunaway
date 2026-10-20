import { CString, dlopen, type Pointer, ptr } from "bun:ffi";
import { failWithCleanup, ResourceOwner } from "@bunaway/plugin";
import {
  LIBSYSTEM,
  LIBSYSTEM_PATH,
  OBJC_PATH,
  OBJC_RUNTIME,
} from "@bunaway/plugin/darwin";
import { pick } from "@bunaway/plugin/win32";
import { BunawayError } from "@bunaway/protocol";

const APPKIT = "/System/Library/Frameworks/AppKit.framework/AppKit";
const UNIFORM_TYPES =
  "/System/Library/Frameworks/UniformTypeIdentifiers.framework/UniformTypeIdentifiers";
/** `NSAlertFirstButtonReturn`: the modal response of the first button; later ones follow. */
const ALERT_FIRST_BUTTON_RETURN = 1000n;
/** `NSControlStateValueOn`. */
const CONTROL_STATE_ON = 1n;
const ALERT_STYLE_CODES: Record<AlertStyle, bigint> = {
  warning: 0n,
  informational: 1n,
  critical: 2n,
};
const RETURN_KEY = "\r";
const ESCAPE_KEY = "\u001b";
/** `NSModalResponseOK`: the user confirmed the panel. */
const MODAL_RESPONSE_OK = 1n;
/** Run loop mode set every modal panel loop services, so a scheduled cancel fires inside it. */
const COMMON_MODES = "kCFRunLoopCommonModes";

/** What a panel is configured with, already reduced from the dialog input by the adapter. */
export type PanelSettings = {
  canChooseFiles: boolean;
  canChooseDirectories: boolean;
  multiple: boolean;
  canCreateDirectories: boolean;
  showHidden: boolean;
  /** Shown as both the window title and the message line, the one AppKit displays. */
  title: string | null;
  directory: string | null;
  fileName: string | null;
  /** File name extensions the panel accepts; null accepts every file. */
  extensions: readonly string[] | null;
  /** Only a save panel reports the single chosen location through `URL`. */
  save: boolean;
};

/** AppKit state read back from a configured panel. */
export type PanelReadBack = {
  canChooseFiles: boolean;
  canChooseDirectories: boolean;
  multiple: boolean;
  canCreateDirectories: boolean;
  showHidden: boolean;
  title: string;
  directory: string;
  fileName: string;
  /** Extensions of the allowed content types, empty when every file is allowed. */
  extensions: string[];
};

/** One configured NSOpenPanel or NSSavePanel. Every call must run on the main thread. */
export type FilePanel = {
  readBack(): PanelReadBack;
  /** Dismisses the panel as the user's Cancel would once the modal loop has started. */
  scheduleCancel(seconds: number): void;
  /** Blocks in the modal loop. Null when the user cancelled, otherwise the chosen paths. */
  run(): string[] | null;
  /** Releases the panel. Safe to repeat. */
  dispose(): void;
};

/** NSAlertStyle: `informational` also stands in for the types that have no icon of their own. */
export type AlertStyle = "informational" | "warning" | "critical";

/** What an alert is configured with, already reduced from the message input by the adapter. */
export type AlertSettings = {
  message: string;
  detail: string | null;
  style: AlertStyle;
  /** Empty keeps the one OK button AppKit adds on its own, localized by the system. */
  buttons: readonly string[];
  /** Index of the button that Return activates. */
  defaultButton: number;
  /** Index of the button that Escape activates; undefined leaves Escape unbound. */
  cancelButton: number | undefined;
  checkbox: {
    label: string;
    checked: boolean;
  } | null;
};

/** What the user answered: the clicked button's index and the checkbox state afterwards. */
export type AlertAnswer = {
  button: number;
  checkboxChecked: boolean;
};

/** AppKit state read back from a configured alert. */
export type AlertReadBack = {
  message: string;
  detail: string;
  style: AlertStyle;
  buttons: string[];
  /** Key equivalent of each button, in button order. */
  keyEquivalents: string[];
  checkbox: {
    label: string;
    checked: boolean;
  } | null;
};

/** One configured NSAlert. Every call must run on the main thread. */
export type MessageAlert = {
  readBack(): AlertReadBack;
  /**
   * Clicks the button at `index` once the modal loop has run for `seconds`, as the user would.
   * The alert must have been configured with that button: AppKit adds its default OK button only
   * when the alert is shown, so an alert without buttons cannot be clicked this way.
   */
  scheduleClick(index: number, seconds: number): void;
  /** Blocks in the modal loop until the user clicks a button. */
  run(): AlertAnswer;
  /** Releases the alert. Safe to repeat. */
  dispose(): void;
};

export type FilePanelFactory = {
  create(settings: PanelSettings): FilePanel;
  createAlert(settings: AlertSettings): MessageAlert;
  dispose(): void;
};

function internal(message: string): never {
  throw new BunawayError({
    code: "INTERNAL",
    message,
  });
}

const closeLibrary = (library: { close(): void }) => library.close();

/**
 * Opens the AppKit panels and alerts. Objects returned by Objective-C stay unsigned 64-bit
 * integers. Each call drains its own autorelease pool and a panel or alert is owned by its binding
 * until its `dispose`, which releases it exactly once. Both are modal: `run` returns only after the
 * user answers, and host cancellation cannot interrupt it. Library handles are closed in reverse
 * order by the factory's `dispose`.
 */
export function createFilePanelFactory(): FilePanelFactory {
  const owner = new ResourceOwner("macOS dialog adapter cleanup failed.");
  let runtime: ReturnType<typeof openRuntime>;
  try {
    runtime = openRuntime(owner);
  } catch (error) {
    // No caller receives the factory, so release what was opened before the failure here.
    failWithCleanup(
      error,
      () => owner.dispose(),
      "macOS dialog adapter cleanup failed.",
    );
  }
  return {
    create: (settings) => createPanel(runtime, settings),
    createAlert: (settings) => createAlert(runtime, settings),
    dispose: () => owner.dispose(),
  };
}

function openRuntime(owner: ResourceOwner) {
  // Bun requires a nonempty symbol table even when a framework is only loaded.
  const appkit = owner.acquire(
    () =>
      dlopen(APPKIT, {
        NSApplicationLoad: {
          args: [],
          returns: "bool",
        },
      } as const),
    closeLibrary,
  );
  owner.acquire(
    () =>
      dlopen(UNIFORM_TYPES, {
        UTTagClassFilenameExtension: {
          args: [],
          returns: "ptr",
        },
      } as const),
    closeLibrary,
  );
  const system = owner.acquire(
    () => dlopen(LIBSYSTEM_PATH, pick(LIBSYSTEM, "pthread_main_np")),
    closeLibrary,
  );
  const objc = owner.acquire(
    () =>
      dlopen(OBJC_PATH, {
        ...pick(OBJC_RUNTIME, "objc_getClass", "sel_registerName"),
        objc_msgSend: {
          args: [
            "u64",
            "u64",
            "u64",
            "u64",
          ],
          returns: "u64",
        },
      } as const),
    closeLibrary,
  );
  // The one message that takes a delay, so the scheduled cancel needs its own argument shape.
  const delayed = owner.acquire(
    () =>
      dlopen(OBJC_PATH, {
        objc_msgSend: {
          args: [
            "u64",
            "u64",
            "u64",
            "u64",
            "f64",
            "u64",
          ],
          returns: "void",
        },
      } as const),
    closeLibrary,
  );
  return {
    appkit,
    system,
    objc,
    delayed,
  };
}

type Runtime = ReturnType<typeof openRuntime>;

/** The Objective-C calls both dialog kinds share, bound to one binding's argument buffers. */
function objcSession(runtime: Runtime, what: string) {
  if (!runtime.system.symbols.pthread_main_np()) {
    throw new BunawayError({
      code: "UNSUPPORTED",
      message: `The ${what} require the macOS main thread.`,
    });
  }
  if (!runtime.appkit.symbols.NSApplicationLoad()) {
    internal("AppKit could not initialize the application object.");
  }
  const { objc } = runtime;
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
      value = BigInt(objc.symbols.sel_registerName(cstring(name)) ?? 0);
      selectors.set(name, value);
    }
    return value;
  };
  const classOf = (name: string) => {
    const value = BigInt(objc.symbols.objc_getClass(cstring(name)) ?? 0);
    return value || internal(`Objective-C class ${name} is unavailable.`);
  };
  const send = (object: bigint, name: string, ...args: (bigint | number)[]) =>
    objc.symbols.objc_msgSend(
      object,
      selector(name),
      BigInt(args[0] ?? 0),
      BigInt(args[1] ?? 0),
    );
  const flag = (value: boolean) => (value ? 1n : 0n);
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
  const textOf = (value: bigint): string =>
    value
      ? new CString(Number(send(value, "UTF8String")) as Pointer).toString()
      : "";
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
  const array = (items: readonly bigint[]) => {
    const list = required(send(classOf("NSMutableArray"), "array"), "NSArray");
    for (const item of items) {
      send(list, "addObject:", item);
    }
    return list;
  };
  const fileUrl = (path: string, directory: boolean) =>
    required(
      send(
        classOf("NSURL"),
        "fileURLWithPath:isDirectory:",
        string(path),
        flag(directory),
      ),
      "NSURL",
    );
  const contentTypes = (extensions: readonly string[]) => {
    const typeClass = classOf("UTType");
    return array(
      extensions.map((extension) =>
        required(
          send(typeClass, "typeWithFilenameExtension:", string(extension)),
          "UTType",
        ),
      ),
    );
  };
  const extensionsOf = (types: bigint): string[] => {
    const count = Number(send(types, "count"));
    const extensions: string[] = [];
    for (let index = 0; index < count; index++) {
      const type = send(types, "objectAtIndex:", BigInt(index));
      const extension = send(type, "preferredFilenameExtension");
      if (extension) {
        extensions.push(textOf(extension));
      }
    }
    return extensions;
  };
  return {
    send,
    string,
    textOf,
    inPool,
    array,
    classOf,
    selector,
    required,
    flag,
    fileUrl,
    contentTypes,
    extensionsOf,
  };
}

function createPanel(runtime: Runtime, settings: PanelSettings): FilePanel {
  const {
    send,
    string,
    textOf,
    inPool,
    array,
    classOf,
    selector,
    required,
    flag,
    fileUrl,
    contentTypes,
    extensionsOf,
  } = objcSession(runtime, "file panels");

  let panel = 0n;
  const release = () => {
    if (panel) {
      inPool(() => send(panel, "release"));
      panel = 0n;
    }
  };
  try {
    inPool(() => {
      panel = required(
        send(
          classOf(settings.save ? "NSSavePanel" : "NSOpenPanel"),
          settings.save ? "savePanel" : "openPanel",
        ),
        "File panel",
      );
      send(panel, "retain");
      if (!settings.save) {
        send(panel, "setCanChooseFiles:", flag(settings.canChooseFiles));
        send(
          panel,
          "setCanChooseDirectories:",
          flag(settings.canChooseDirectories),
        );
        send(panel, "setAllowsMultipleSelection:", flag(settings.multiple));
      }
      send(
        panel,
        "setCanCreateDirectories:",
        flag(settings.canCreateDirectories),
      );
      send(panel, "setShowsHiddenFiles:", flag(settings.showHidden));
      if (settings.title !== null) {
        send(panel, "setTitle:", string(settings.title));
        send(panel, "setMessage:", string(settings.title));
      }
      if (settings.directory !== null) {
        send(panel, "setDirectoryURL:", fileUrl(settings.directory, true));
      }
      if (settings.fileName !== null) {
        send(panel, "setNameFieldStringValue:", string(settings.fileName));
      }
      if (settings.extensions !== null) {
        send(
          panel,
          "setAllowedContentTypes:",
          contentTypes(settings.extensions),
        );
      }
    });
  } catch (error) {
    release();
    throw error;
  }
  // A BOOL occupies the low byte of the return register; the rest is unspecified.
  const boolOf = (name: string) => (send(panel, name) & 0xffn) !== 0n;
  return {
    readBack: () =>
      inPool(() => ({
        canChooseFiles: settings.save || boolOf("canChooseFiles"),
        canChooseDirectories: !settings.save && boolOf("canChooseDirectories"),
        multiple: !settings.save && boolOf("allowsMultipleSelection"),
        canCreateDirectories: boolOf("canCreateDirectories"),
        showHidden: boolOf("showsHiddenFiles"),
        title: textOf(send(panel, "title")),
        directory: textOf(send(send(panel, "directoryURL"), "path")),
        fileName: textOf(send(panel, "nameFieldStringValue")),
        extensions: extensionsOf(send(panel, "allowedContentTypes")),
      })),
    scheduleCancel: (seconds) =>
      inPool(() => {
        runtime.delayed.symbols.objc_msgSend(
          panel,
          selector("performSelector:withObject:afterDelay:inModes:"),
          selector("cancel:"),
          0n,
          seconds,
          array([
            string(COMMON_MODES),
          ]),
        );
      }),
    run: () =>
      inPool(() => {
        if (send(panel, "runModal") !== MODAL_RESPONSE_OK) {
          return null;
        }
        if (settings.save) {
          return [
            textOf(send(send(panel, "URL"), "path")),
          ];
        }
        const urls = send(panel, "URLs");
        const count = Number(send(urls, "count"));
        const paths: string[] = [];
        for (let index = 0; index < count; index++) {
          paths.push(
            textOf(send(send(urls, "objectAtIndex:", BigInt(index)), "path")),
          );
        }
        return paths;
      }),
    dispose: release,
  };
}

/** The key a button answers to: Return for the default, Escape for the cancel button, else none. */
function keyEquivalentOf(index: number, settings: AlertSettings): string {
  if (index === settings.defaultButton) {
    return RETURN_KEY;
  }
  return index === settings.cancelButton ? ESCAPE_KEY : "";
}

function createAlert(runtime: Runtime, settings: AlertSettings): MessageAlert {
  const {
    send,
    string,
    textOf,
    inPool,
    array,
    selector,
    classOf,
    required,
    flag,
  } = objcSession(runtime, "message dialogs");
  let alert = 0n;
  const release = () => {
    if (alert) {
      inPool(() => send(alert, "release"));
      alert = 0n;
    }
  };
  const buttonCount = Math.max(1, settings.buttons.length);
  const buttonAt = (index: number) =>
    send(send(alert, "buttons"), "objectAtIndex:", BigInt(index));
  try {
    inPool(() => {
      // `alloc` returns an owned object, so `dispose` releases it exactly once.
      alert = required(
        send(send(classOf("NSAlert"), "alloc"), "init"),
        "NSAlert",
      );
      send(alert, "setMessageText:", string(settings.message));
      if (settings.detail !== null) {
        send(alert, "setInformativeText:", string(settings.detail));
      }
      send(alert, "setAlertStyle:", ALERT_STYLE_CODES[settings.style]);
      for (const [index, title] of settings.buttons.entries()) {
        const button = required(
          send(alert, "addButtonWithTitle:", string(title)),
          "NSButton",
        );
        // Only Return and Escape are bound, so AppKit's own choice of default is replaced.
        send(
          button,
          "setKeyEquivalent:",
          string(keyEquivalentOf(index, settings)),
        );
      }
      if (settings.checkbox !== null) {
        send(alert, "setShowsSuppressionButton:", flag(true));
        const box = required(send(alert, "suppressionButton"), "NSButton");
        send(box, "setTitle:", string(settings.checkbox.label));
        send(box, "setState:", flag(settings.checkbox.checked));
      }
    });
  } catch (error) {
    release();
    throw error;
  }
  const checkboxOf = () => {
    const box = send(alert, "suppressionButton");
    return {
      label: textOf(send(box, "title")),
      checked: send(box, "state") === CONTROL_STATE_ON,
    };
  };
  return {
    readBack: () =>
      inPool(() => {
        // AppKit adds its own OK button only when the alert is shown, so an alert configured
        // without buttons reports none here.
        const count = Number(send(send(alert, "buttons"), "count"));
        const code = send(alert, "alertStyle");
        // The keys of the style table are exactly the AlertStyle names.
        const style = (Object.keys(ALERT_STYLE_CODES) as AlertStyle[]).find(
          (name) => ALERT_STYLE_CODES[name] === code,
        );
        if (style === undefined) {
          internal("The alert reported an unknown style.");
        }
        return {
          message: textOf(send(alert, "messageText")),
          detail: textOf(send(alert, "informativeText")),
          style,
          buttons: Array.from(
            {
              length: count,
            },
            (_, index) => textOf(send(buttonAt(index), "title")),
          ),
          keyEquivalents: Array.from(
            {
              length: count,
            },
            (_, index) => textOf(send(buttonAt(index), "keyEquivalent")),
          ),
          checkbox: settings.checkbox === null ? null : checkboxOf(),
        };
      }),
    scheduleClick: (index, seconds) =>
      inPool(() => {
        runtime.delayed.symbols.objc_msgSend(
          buttonAt(index),
          selector("performSelector:withObject:afterDelay:inModes:"),
          selector("performClick:"),
          0n,
          seconds,
          array([
            string(COMMON_MODES),
          ]),
        );
      }),
    run: () =>
      inPool(() => {
        const button = Number(
          send(alert, "runModal") - ALERT_FIRST_BUTTON_RETURN,
        );
        if (button < 0 || button >= buttonCount) {
          internal("The alert returned an unexpected response.");
        }
        return {
          button,
          checkboxChecked: settings.checkbox !== null && checkboxOf().checked,
        };
      }),
    dispose: release,
  };
}
