import assert from "node:assert/strict";

/** Controlled native releases for the compiled production Tray, isolated in a child process. */
export const trayCleanup = {
  nextIcon: 100n,
  icons: new Set<bigint>(),
  iconFailures: new Map<bigint, number>(),
  iconAttempts: [] as bigint[],
  windowFailures: 0,
  windowAttempts: 0,
  shellFailures: 0,
  addFailures: 0,
  shellAttempts: 0,
  shellNotifications: [] as number[],
  callback: (_message: number, _wparam: bigint, _lparam: bigint) => {},
};

export const WM_CLOSE = 16;
export const TASKBAR_CREATED = 0xc000;
export function ptr(_buffer: ArrayBufferView): number {
  return 1;
}
export function withWide<T>(_text: string, use: (pointer: number) => T): T {
  return use(1);
}
export const user = {
  symbols: {
    RegisterWindowMessageW: () => TASKBAR_CREATED,
    DestroyIcon(icon: bigint) {
      trayCleanup.iconAttempts.push(icon);
      const remaining = trayCleanup.iconFailures.get(icon) ?? 0;
      if (remaining > 0) {
        trayCleanup.iconFailures.set(icon, remaining - 1);
        return 0;
      }
      assert(
        trayCleanup.icons.delete(icon),
        "Unowned or already released icon",
      );
      return 1;
    },
  },
};
export function createTrayIcon(_ico: string): bigint {
  const icon = trayCleanup.nextIcon++;
  trayCleanup.icons.add(icon);
  return icon;
}
export class NativePopupMenu {
  constructor() {
    throw new Error("Unexpected popup during tray cleanup");
  }
}
export class Windows {
  readonly icon = 1n;
  private live = false;
  create(
    _title: string,
    _width: number,
    _height: number,
    callback: typeof trayCleanup.callback,
  ): bigint {
    assert(!this.live);
    this.live = true;
    trayCleanup.callback = callback;
    return 999n;
  }
  destroy(hwnd: bigint): void {
    assert.equal(hwnd, 999n);
    assert(this.live, "Already destroyed tray window");
    trayCleanup.windowAttempts++;
    if (trayCleanup.windowFailures > 0) {
      trayCleanup.windowFailures--;
      throw new Error("Injected window release failure");
    }
    this.live = false;
  }
  dispose(): void {
    assert(!this.live, "Tray window leaked");
  }
}
export function dlopen(_library: string) {
  let closed = false;
  return {
    symbols: {
      Shell_NotifyIconW(operation: number) {
        assert(!closed, "Tray accessed a closed shell binding");
        trayCleanup.shellNotifications.push(operation);
        if (operation === 0 && trayCleanup.addFailures > 0) {
          trayCleanup.addFailures--;
          return 0;
        }
        return 1;
      },
    },
    close() {
      assert(!closed, "Shell binding closed twice");
      trayCleanup.shellAttempts++;
      if (trayCleanup.shellFailures > 0) {
        trayCleanup.shellFailures--;
        throw new Error("Injected shell release failure");
      }
      closed = true;
    },
  };
}

export function openTrayBindings() {
  return {
    ...user,
    close() {},
  };
}
