import type { GlobalShortcut } from "#global-shortcut/contract";

/** Requested interval of the key-state poll; WM_TIMER actually fires every 20 to 30 ms. */
export const RELEASE_POLL_INTERVAL_MS = 20;

type Hold = {
  shortcut: GlobalShortcut;
  virtualKey: number;
};

/**
 * Tracks registrations whose primary key is still held after WM_HOTKEY.
 *
 * RegisterHotKey reports only the key-down. The caller runs a timer while `size > 0` and calls
 * `poll` on every tick with the current physical key state. Only the primary virtual key counts:
 * releasing a modifier first does not end the hold. Holds keep a snapshot of the shortcut, so
 * reporting a release does not depend on the registration still existing.
 */
export class HeldShortcuts {
  private readonly held = new Map<number, Hold>();

  get size(): number {
    return this.held.size;
  }

  /** Records a hold, replacing any earlier one for the same registration. */
  hold(id: number, shortcut: GlobalShortcut, virtualKey: number): void {
    this.held.set(id, {
      shortcut: structuredClone(shortcut),
      virtualKey,
    });
  }

  /** Removes one hold and returns its shortcut, or undefined when it was not held. */
  drop(id: number): GlobalShortcut | undefined {
    const hold = this.held.get(id);
    this.held.delete(id);
    return hold?.shortcut;
  }

  /** Removes and returns the shortcuts whose key is no longer down, in press order. */
  poll(isKeyDown: (virtualKey: number) => boolean): GlobalShortcut[] {
    const released: GlobalShortcut[] = [];
    for (const [id, hold] of this.held) {
      if (!isKeyDown(hold.virtualKey)) {
        released.push(hold.shortcut);
        this.held.delete(id);
      }
    }
    return released;
  }
}
