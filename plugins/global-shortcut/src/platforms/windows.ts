import { type NativeEnvironment, NativeEventWaiters } from "@bunaway/plugin";
import { BunawayError, type JsonValue } from "@bunaway/protocol";
import {
  type GlobalShortcut,
  MAX_GLOBAL_SHORTCUTS,
  MAX_SHORTCUT_WAITERS,
  shortcutId,
  type shortcutSchema,
} from "#global-shortcut/contract";
import {
  hotkeyCodes,
  MAX_HOTKEY_ID,
  Win32Shortcuts,
} from "#global-shortcut/platforms/windows-bindings";
import { HeldShortcuts } from "#global-shortcut/release-tracker";
/** Native registration and hidden-window ownership boundary, shared by runtime and focused tests. */
export type ShortcutDriver = {
  listen(receive: (id: number, packedKeys: bigint) => void): void;
  register(id: number, shortcut: GlobalShortcut): boolean;
  unregister(id: number): boolean;
  /** Physical state of a virtual key, independent of focus. */
  isKeyDown(virtualKey: number): boolean;
  /** Calls `tick` periodically on the UI thread until `stopPolling` or `dispose`. Idempotent. */
  startPolling(tick: () => void): void;
  stopPolling(): void;
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
export function initializeShortcutOperations(
  driver: ShortcutDriver,
  emit: (event: string, payload: JsonValue) => void,
) {
  const registrations = new Map<string, Registration>();
  const presses = new NativeEventWaiters<{
    shortcut: ReturnType<typeof shortcutSchema.parse>;
  }>(MAX_SHORTCUT_WAITERS);
  let nextId = 1;
  let suspended = false;
  let disposed = false;
  // RegisterHotKey never reports the key-up, so a pressed shortcut is polled until its key is up.
  const held = new HeldShortcuts();
  const emitReleased = (shortcut: GlobalShortcut) =>
    emit("globalShortcut.released", {
      shortcut: structuredClone(shortcut),
    });
  /** Emits `released` for ended holds and stops the poll timer once nothing is held. */
  const publishReleased = (shortcuts: GlobalShortcut[]) => {
    for (const shortcut of shortcuts) {
      emitReleased(shortcut);
    }
    if (held.size === 0) {
      driver.stopPolling();
    }
  };
  const pollReleased = () => {
    if (!disposed) {
      publishReleased(held.poll((key) => driver.isKeyDown(key)));
    }
  };
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
    // This runs inside the window procedure, so a timer failure must not escape. Without a timer
    // the key-up cannot be observed: report pressed, then released at once, and record no hold.
    let polling = true;
    try {
      driver.startPolling(pollReleased);
    } catch (cause) {
      polling = false;
      console.error("Global shortcut release polling could not start.", cause);
    }
    // A second WM_HOTKEY for a tracked hold means the key went up and down between two polls.
    // Close the earlier hold first so every pressed has one released.
    const previous = held.drop(entry.id);
    if (previous) {
      emitReleased(previous);
    }
    if (polling) {
      held.hold(entry.id, entry.shortcut, codes.key);
    }
    presses.publish(payload);
    emit("globalShortcut.pressed", payload);
    if (!polling) {
      emitReleased(entry.shortcut);
    }
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
    // Unbinding or suspending while the key is down completes the pair without waiting for a poll.
    const dropped = held.drop(entry.id);
    if (dropped) {
      publishReleased([
        dropped,
      ]);
    }
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
    register(shortcut: GlobalShortcut) {
      return registerMany([
        shortcut,
      ]);
    },
    registerMany,
    isRegistered(shortcut: GlobalShortcut) {
      return registrations.has(shortcutId(shortcut));
    },
    list() {
      return [
        ...registrations.values(),
      ].map((entry) => structuredClone(entry.shortcut));
    },
    unregister(shortcut: GlobalShortcut) {
      const id = shortcutId(shortcut);
      const entry = registrations.get(id);
      if (!entry) {
        return false;
      }
      release(entry);
      return registrations.delete(id);
    },
    unregisterAll() {
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
    },
    setSuspended,
    isSuspended() {
      return suspended;
    },
    waitForPress(signal?: AbortSignal) {
      return presses.wait(signal);
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

export function initialize(environment: NativeEnvironment) {
  const services = environment.shortcuts;
  if (!services) {
    throw new BunawayError({
      code: "UNSUPPORTED",
      message: "Native global shortcut services are unavailable.",
    });
  }
  return initializeShortcutOperations(
    new Win32Shortcuts(services),
    (event, payload) => services.emit(event, payload),
  );
}

export function dispose(instance: ReturnType<typeof initialize>): void {
  instance.dispose();
}
