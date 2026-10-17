/** Interval of the key-state poll that detects a released shortcut key, in milliseconds. */
export const RELEASE_POLL_INTERVAL_MS = 20;

/**
 * Tracks registrations whose primary key is still held after WM_HOTKEY.
 *
 * RegisterHotKey reports only the key-down. The caller runs a timer while `size > 0` and calls
 * `poll` on every tick with the current physical key state. Only the primary virtual key counts:
 * releasing a modifier first does not end the hold.
 */
export class HeldShortcuts {
  private readonly held = new Map<number, number>();

  get size(): number {
    return this.held.size;
  }

  /** Marks a registration as held. Returns true when it was already held (a missed release). */
  press(id: number, virtualKey: number): boolean {
    const wasHeld = this.held.has(id);
    this.held.set(id, virtualKey);
    return wasHeld;
  }

  /** Removes and returns the held IDs whose key is no longer down, in press order. */
  poll(isKeyDown: (virtualKey: number) => boolean): number[] {
    const released: number[] = [];
    for (const [id, virtualKey] of this.held) {
      if (!isKeyDown(virtualKey)) {
        released.push(id);
      }
    }
    for (const id of released) {
      this.held.delete(id);
    }
    return released;
  }

  /** Removes one registration. Returns true when it was held. */
  drop(id: number): boolean {
    return this.held.delete(id);
  }

  /** Removes every registration and returns the IDs that were held. */
  clear(): number[] {
    const ids = [
      ...this.held.keys(),
    ];
    this.held.clear();
    return ids;
  }
}
