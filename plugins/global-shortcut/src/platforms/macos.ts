import {
  failWithCleanup,
  type NativeEnvironment,
  NativeEventWaiters,
} from "@bunaway/plugin";
import { BunawayError, type JsonValue } from "@bunaway/protocol";
import {
  type GlobalShortcut,
  type GlobalShortcutInstance,
  MAX_GLOBAL_SHORTCUTS,
  MAX_SHORTCUT_WAITERS,
  shortcutId,
  type shortcutSchema,
} from "#global-shortcut/contract";
import {
  createCarbonHotKeys,
  EVENT_HOT_KEY_EXISTS,
  type HotKeyDriver,
  isMacosKey,
} from "#global-shortcut/platforms/macos-bindings";

/** Largest identifier a Carbon hot key can carry, one past the last 32-bit value. */
const MAX_HOT_KEY_ID = 0xffffffff;

type Registration = {
  id: number;
  shortcut: GlobalShortcut;
  /** Whether Carbon currently holds this registration. */
  active: boolean;
  /** Whether a press was reported without its release yet. */
  down: boolean;
};

type ErrorCode = "INVALID_ARGUMENT" | "BUSY" | "INTERNAL" | "UNSUPPORTED";

function error(code: ErrorCode, message: string): never {
  throw new BunawayError({
    code,
    message,
  });
}

/**
 * App-owned global shortcuts on macOS through Carbon `RegisterEventHotKey`. This needs no
 * Accessibility or Input Monitoring permission, so there is no permission-denied outcome, and a
 * combination another registration already owns is refused as BUSY like on Windows. Carbon reports
 * both the press and the release, so no key-state polling is needed. `Super` is Command and
 * `Alt` is Option. Keys follow physical positions on the keyboard.
 *
 * Logical registrations survive suspension and are given fresh identifiers when resumed, so a
 * queued event of a retired registration is recognized and dropped.
 */
export class MacosGlobalShortcut implements GlobalShortcutInstance {
  private readonly registrations = new Map<string, Registration>();
  private readonly presses = new NativeEventWaiters<{
    shortcut: ReturnType<typeof shortcutSchema.parse>;
  }>(MAX_SHORTCUT_WAITERS);
  private nextId = 1;
  private suspended = false;
  private disposed = false;

  constructor(
    private readonly driver: HotKeyDriver,
    private readonly emit: (event: string, payload: JsonValue) => void,
  ) {
    driver.listen((event, id) => this.receive(event, id));
  }

  private receive(event: "pressed" | "released", id: number): void {
    if (this.disposed || this.suspended) {
      return;
    }
    const entry = [
      ...this.registrations.values(),
    ].find((registration) => registration.id === id && registration.active);
    if (!entry) {
      return;
    }
    if (event === "released") {
      this.finishHold(entry);
      return;
    }
    // A second press without a release means the release was lost: close the earlier hold first so
    // every pressed has exactly one released.
    this.finishHold(entry);
    entry.down = true;
    this.presses.publish({
      shortcut: structuredClone(entry.shortcut),
    });
    this.emit("globalShortcut.pressed", {
      shortcut: structuredClone(entry.shortcut),
    });
  }

  /** Reports `released` for a registration that is held down; does nothing otherwise. */
  private finishHold(entry: Registration): void {
    if (!entry.down) {
      return;
    }
    entry.down = false;
    this.emit("globalShortcut.released", {
      shortcut: structuredClone(entry.shortcut),
    });
  }

  private acquire(entry: Registration) {
    if (this.nextId > MAX_HOT_KEY_ID) {
      return error("BUSY", "Global shortcut registration ID limit reached.");
    }
    const id = this.nextId++;
    const status = this.driver.register(id, entry.shortcut);
    if (status === EVENT_HOT_KEY_EXISTS) {
      return error(
        "BUSY",
        "Global shortcut is already owned by another registration.",
      );
    }
    if (status !== 0) {
      return error(
        "INTERNAL",
        `macOS could not register the global shortcut (${status}).`,
      );
    }
    entry.id = id;
    entry.active = true;
  }

  private release(entry: Registration) {
    if (!entry.active) {
      return;
    }
    if (!this.driver.unregister(entry.id)) {
      return error("INTERNAL", "macOS could not unregister a global shortcut.");
    }
    entry.active = false;
    // Unbinding or suspending while the key is down completes the pair without waiting for a key-up.
    this.finishHold(entry);
  }

  private releaseAll(entries: Iterable<Registration>) {
    let failed = false;
    for (const entry of entries) {
      try {
        this.release(entry);
      } catch {
        failed = true;
      }
    }
    if (failed) {
      return error(
        "INTERNAL",
        "Some macOS global shortcuts remain registered.",
      );
    }
  }

  /** Rejects a batch before any OS call when it cannot be registered as a whole. */
  private assertBatchAdmissible(shortcuts: GlobalShortcut[]) {
    if (this.suspended) {
      return error("BUSY", "Global shortcut processing is suspended.");
    }
    if (shortcuts.some((shortcut) => !isMacosKey(shortcut.key))) {
      return error(
        "UNSUPPORTED",
        "A global shortcut key has no equivalent on a Mac keyboard.",
      );
    }
    const ids = shortcuts.map(shortcutId);
    if (new Set(ids).size !== ids.length) {
      return error("INVALID_ARGUMENT", "Duplicate global shortcut in batch.");
    }
    if (ids.some((id) => this.registrations.has(id))) {
      return error("BUSY", "Global shortcut is already registered.");
    }
    if (
      this.registrations.size + shortcuts.length > MAX_GLOBAL_SHORTCUTS ||
      this.nextId + shortcuts.length - 1 > MAX_HOT_KEY_ID
    ) {
      return error("BUSY", "Global shortcut registration limit reached.");
    }
  }

  register(shortcut: GlobalShortcut): null {
    return this.registerMany([
      shortcut,
    ]);
  }

  registerMany(shortcuts: GlobalShortcut[]): null {
    this.assertBatchAdmissible(shortcuts);
    const acquired: Registration[] = [];
    try {
      for (const shortcut of shortcuts) {
        const entry = {
          shortcut: structuredClone(shortcut),
          id: 0,
          active: false,
          down: false,
        };
        this.acquire(entry);
        acquired.push(entry);
      }
    } catch (cause) {
      try {
        this.releaseAll(acquired);
      } catch {
        // Retain ownership if OS rollback fails; callers can inspect and retry removal.
        for (const entry of acquired) {
          if (entry.active) {
            this.registrations.set(shortcutId(entry.shortcut), entry);
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
      this.registrations.set(shortcutId(entry.shortcut), entry);
    }
    return null;
  }

  isRegistered(shortcut: GlobalShortcut): boolean {
    return this.registrations.has(shortcutId(shortcut));
  }

  list(): GlobalShortcut[] {
    return [
      ...this.registrations.values(),
    ].map((entry) => structuredClone(entry.shortcut));
  }

  unregister(shortcut: GlobalShortcut): boolean {
    const id = shortcutId(shortcut);
    const entry = this.registrations.get(id);
    if (!entry) {
      return false;
    }
    this.release(entry);
    return this.registrations.delete(id);
  }

  unregisterAll(): null {
    let failed = false;
    for (const [id, entry] of this.registrations) {
      try {
        this.release(entry);
        this.registrations.delete(id);
      } catch {
        failed = true;
      }
    }
    if (failed) {
      return error(
        "INTERNAL",
        "Some macOS global shortcuts remain registered.",
      );
    }
    return null;
  }

  setSuspended(value: boolean): null {
    if (value) {
      this.suspended = true;
      this.releaseAll(this.registrations.values());
      return null;
    }
    if (!this.suspended) {
      return null;
    }
    // A failed suspend may retain some OS bindings. Finish unbinding before a new generation.
    this.releaseAll(this.registrations.values());
    if (this.nextId + this.registrations.size - 1 > MAX_HOT_KEY_ID) {
      return error("BUSY", "Global shortcut registration ID limit reached.");
    }
    const acquired: Registration[] = [];
    try {
      for (const entry of this.registrations.values()) {
        this.acquire(entry);
        acquired.push(entry);
      }
    } catch (cause) {
      // Report the registration failure even when the rollback fails too. The shortcuts stay
      // suspended, and the next resume finishes unbinding before it registers again.
      failWithCleanup(
        cause,
        () => this.releaseAll(acquired),
        "Global shortcut resume failed and its rollback was incomplete.",
      );
    }
    this.suspended = false;
    return null;
  }

  isSuspended(): boolean {
    return this.suspended;
  }

  waitForPress(signal?: AbortSignal) {
    return this.presses.wait(signal);
  }

  /** Removes every registration and the event handler. Repeated calls do nothing. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.presses.dispose();
    this.suspended = true;
    try {
      this.driver.dispose();
    } finally {
      this.registrations.clear();
    }
  }
}

export function initialize(
  environment: NativeEnvironment,
): GlobalShortcutInstance {
  const events = environment.events;
  if (!events) {
    throw new BunawayError({
      code: "UNSUPPORTED",
      message: "Native plugin event delivery is unavailable.",
    });
  }
  return new MacosGlobalShortcut(createCarbonHotKeys(), (event, payload) =>
    events.emit(event, payload),
  );
}

export function dispose(instance: GlobalShortcutInstance): void {
  instance.dispose();
}
