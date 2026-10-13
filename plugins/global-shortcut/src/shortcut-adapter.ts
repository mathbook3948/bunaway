import { NativeEventWaiters, type NativeAdapter } from "@bunaway/plugin";
import { BunawayError, type JsonValue } from "@bunaway/protocol";
import {
  type GlobalShortcut,
  globalShortcutOperations,
  hotkeyCodes,
  MAX_GLOBAL_SHORTCUTS,
  MAX_HOTKEY_ID,
  MAX_SHORTCUT_WAITERS,
  shortcutId,
} from "./contract.ts";

/** Native registration and hidden-window ownership boundary, shared by runtime and focused tests. */
export type ShortcutDriver = {
  listen(receive: (id: number, packedKeys: bigint) => void): void;
  register(id: number, shortcut: GlobalShortcut): boolean;
  unregister(id: number): boolean;
  dispose(): void;
};
type Registration = {
  id: number;
  shortcut: GlobalShortcut;
  active: boolean;
};

function error(
  code:
    | "INVALID_ARGUMENT"
    | "BUSY"
    | "INTERNAL"
    | "CANCELLED"
    | "PERMISSION_DENIED"
    | "UNSUPPORTED",
  message: string,
): never {
  throw new BunawayError({
    code,
    message,
  });
}

/** Owns logical registrations through suspension and native failures. Every native ID is used once. */
export function createShortcutOperations(
  driver: ShortcutDriver,
  emit: (event: string, payload: JsonValue) => void,
): NativeAdapter {
  const registrations = new Map<string, Registration>();
  const presses = new NativeEventWaiters<JsonValue>(MAX_SHORTCUT_WAITERS);
  let nextId = 1;
  let suspended = false;
  let disposed = false;
  driver.listen((id, packedKeys) => {
    if (disposed || suspended) {
      return;
    }
    const entry = [
      ...registrations.values(),
    ].find((registration) => registration.id === id && registration.active);
    if (!entry) {
      return;
    }
    const codes = hotkeyCodes(entry.shortcut);
    // Validate both the generation-specific ID and key tuple. Ignore retired queued WM_HOTKEYs.
    if (
      (Number(packedKeys) & 0xffff) !== codes.modifiers ||
      ((Number(packedKeys) >>> 16) & 0xffff) !== codes.key
    ) {
      return;
    }
    const payload = {
      shortcut: structuredClone(entry.shortcut),
    };
    presses.publish(payload);
    emit("globalShortcut.pressed", payload);
  });
  const acquire = (entry: Registration) => {
    if (nextId > MAX_HOTKEY_ID) {
      return error("BUSY", "Global shortcut registration ID limit reached.");
    }
    const id = nextId++;
    if (!driver.register(id, entry.shortcut)) {
      return error(
        "BUSY",
        "Global shortcut is occupied or reserved by Windows.",
      );
    }
    entry.id = id;
    entry.active = true;
  };
  const release = (entry: Registration) => {
    if (!entry.active) {
      return;
    }
    if (!driver.unregister(entry.id)) {
      return error(
        "INTERNAL",
        "Windows could not unregister a global shortcut.",
      );
    }
    entry.active = false;
  };
  const releaseAll = (entries: Iterable<Registration>) => {
    let failed = false;
    for (const entry of entries) {
      try {
        release(entry);
      } catch {
        failed = true;
      }
    }
    if (failed) {
      return error(
        "INTERNAL",
        "Some Windows global shortcuts remain registered.",
      );
    }
  };
  const registerMany = (shortcuts: GlobalShortcut[]) => {
    if (suspended) {
      return error("BUSY", "Global shortcut processing is suspended.");
    }
    const ids = shortcuts.map(shortcutId);
    if (new Set(ids).size !== ids.length) {
      return error("INVALID_ARGUMENT", "Duplicate global shortcut in batch.");
    }
    if (ids.some((id) => registrations.has(id))) {
      return error("BUSY", "Global shortcut is already registered.");
    }
    if (
      registrations.size + shortcuts.length > MAX_GLOBAL_SHORTCUTS ||
      nextId + shortcuts.length - 1 > MAX_HOTKEY_ID
    ) {
      return error("BUSY", "Global shortcut registration limit reached.");
    }
    const acquired: Registration[] = [];
    try {
      for (const shortcut of shortcuts) {
        const entry = {
          shortcut: structuredClone(shortcut),
          id: 0,
          active: false,
        };
        acquire(entry);
        acquired.push(entry);
      }
    } catch (cause) {
      try {
        releaseAll(acquired);
      } catch {
        // Retain ownership if OS rollback fails; callers can inspect and retry removal.
        for (const entry of acquired) {
          if (entry.active) {
            registrations.set(shortcutId(entry.shortcut), entry);
          }
        }
        return error(
          "INTERNAL",
          "Global shortcut rollback failed; inspect registered shortcuts.",
        );
      }
      throw cause;
    }
    for (const entry of acquired) {
      registrations.set(shortcutId(entry.shortcut), entry);
    }
    return null;
  };
  const setSuspended = (value: boolean) => {
    if (value) {
      suspended = true;
      releaseAll(registrations.values());
      return null;
    }
    if (!suspended) {
      return null;
    }
    // A failed suspend may retain some OS bindings. Finish unbinding before a new generation.
    releaseAll(registrations.values());
    if (nextId + registrations.size - 1 > MAX_HOTKEY_ID) {
      return error("BUSY", "Global shortcut registration ID limit reached.");
    }
    const acquired: Registration[] = [];
    try {
      for (const entry of registrations.values()) {
        acquire(entry);
        acquired.push(entry);
      }
    } catch (cause) {
      releaseAll(acquired);
      throw cause;
    }
    suspended = false;
    return null;
  };
  return {
    execute() {
      return error("UNSUPPORTED", "Global shortcuts require UI execution.");
    },
    executeUI(name, input, _source, context) {
      if (disposed || context.signal?.aborted) {
        return error("CANCELLED", "Global shortcut operation cancelled.");
      }
      if (!context.permissions.permissions.includes(name)) {
        return error("PERMISSION_DENIED", "Global shortcut permission denied.");
      }
      const parse = <T>(run: () => T): T => {
        try {
          return run();
        } catch {
          return error("INVALID_ARGUMENT", "Invalid global shortcut input.");
        }
      };
      switch (name) {
        case "globalShortcut.register":
          return registerMany([
            parse(() => globalShortcutOperations.register.input.parse(input)),
          ]);
        case "globalShortcut.registerMany":
          return registerMany(
            parse(() =>
              globalShortcutOperations.registerMany.input.parse(input),
            ).shortcuts,
          );
        case "globalShortcut.isRegistered":
          return registrations.has(
            shortcutId(
              parse(() =>
                globalShortcutOperations.isRegistered.input.parse(input),
              ),
            ),
          );
        case "globalShortcut.list":
          parse(() => globalShortcutOperations.list.input.parse(input));
          return [
            ...registrations.values(),
          ].map((entry) => structuredClone(entry.shortcut));
        case "globalShortcut.unregister": {
          const id = shortcutId(
            parse(() => globalShortcutOperations.unregister.input.parse(input)),
          );
          const entry = registrations.get(id);
          if (!entry) {
            return false;
          }
          release(entry);
          return registrations.delete(id);
        }
        case "globalShortcut.unregisterAll": {
          parse(() =>
            globalShortcutOperations.unregisterAll.input.parse(input),
          );
          let failed = false;
          for (const [id, entry] of registrations) {
            try {
              release(entry);
              registrations.delete(id);
            } catch {
              failed = true;
            }
          }
          if (failed) {
            return error(
              "INTERNAL",
              "Some Windows global shortcuts remain registered.",
            );
          }
          return null;
        }
        case "globalShortcut.setSuspended":
          return setSuspended(
            parse(() =>
              globalShortcutOperations.setSuspended.input.parse(input),
            ).suspended,
          );
        case "globalShortcut.isSuspended":
          parse(() => globalShortcutOperations.isSuspended.input.parse(input));
          return suspended;
        case "globalShortcut.waitForPress":
          parse(() => globalShortcutOperations.waitForPress.input.parse(input));
          return presses.wait(context.signal);
        default:
          return error(
            "UNSUPPORTED",
            "Global shortcut operation is not registered.",
          );
      }
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      presses.dispose();
      suspended = true;
      // The driver attempts explicit removal and destroys the HWND even after a native error.
      try {
        driver.dispose();
      } finally {
        registrations.clear();
      }
    },
  };
}
