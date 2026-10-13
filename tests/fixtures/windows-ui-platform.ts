import assert from "node:assert/strict";
import { workerData } from "node:worker_threads";
import type {
  NativeMonitorServices,
  WindowSpec,
} from "@bunaway/plugin-api/native";

// Controlled native boundary for the real UI Worker. No HWND, DLL or COM is loaded.
const controls = workerData as {
  failView?: string;
};
export const WM_CLOSE = 16;
export const WM_SIZE = 5;
export const WM_ENTERSIZEMOVE = 561;
export const WM_EXITSIZEMOVE = 562;
export const kernel = {
  symbols: {
    GetCurrentThreadId: () => 1,
  },
};
export const ole = {
  symbols: {
    CoInitializeEx: () => 0,
    CoUninitialize() {},
  },
};
export function hr(result: number): void {
  assert(result >= 0);
}
export function disposeWin32Bindings(): void {}
export function checkCallbacks(): void {}
export function callbackCalls(): number[] {
  return [];
}
export function disposeCom(): object {
  return {};
}
export class Tray {
  readonly hwnd = 999n;
  dispose(): void {}
}

/** Model only native identity and visibility used by these lifecycle scenarios. */
export class Windows {
  validateCreation() {}

  private sequence = 0n;
  private readonly windows = new Map<
    bigint,
    {
      view: string;
      visible: boolean;
      closable: boolean;
    }
  >();
  create(
    _title: string,
    _width: number,
    _height: number,
    _callback: unknown,
    visible: boolean,
  ): bigint {
    const hwnd = ++this.sequence;
    this.windows.set(hwnd, {
      view: "",
      visible,
      closable: true,
    });
    return hwnd;
  }
  observe(hwnd: bigint, view: string): void {
    this.read(hwnd).view = view;
  }
  private read(hwnd: bigint) {
    const window = this.windows.get(hwnd);
    assert(window, "Unknown fixture window");
    return window;
  }
  getSnapshot(hwnd: bigint) {
    const window = this.read(hwnd);
    return {
      windowId: `window-${hwnd}`,
      viewId: window.view,
      revision: 0,
      state: {
        visible: window.visible,
        focused: false,
        minimized: false,
        maximized: false,
        fullscreen: false,
      },
      bounds: {
        x: 0,
        y: 0,
        width: 800,
        height: 600,
        dpi: 96,
      },
    };
  }
  getById(id: string) {
    for (const hwnd of this.windows.keys()) {
      const { windowId, viewId } = this.getSnapshot(hwnd);
      if (id === windowId) {
        return {
          windowId,
          viewId,
        };
      }
    }
    return null;
  }
  show(hwnd: bigint, visible: boolean): void {
    this.read(hwnd).visible = visible;
  }
  focus(hwnd: bigint): boolean {
    this.show(hwnd, true);
    return true;
  }
  isVisible(hwnd: bigint): boolean {
    return this.read(hwnd).visible;
  }
  setClosable(hwnd: bigint, closable: boolean): void {
    this.read(hwnd).closable = closable;
  }
  isClosable(hwnd: bigint): boolean {
    return this.read(hwnd).closable;
  }
  destroy(hwnd: bigint): void {
    assert(this.windows.delete(hwnd));
  }
  pump(): void {}
  dispose(): void {
    assert.equal(this.windows.size, 0, "Fixture window leaked");
  }
}

export function originOf(text: string): string {
  return new URL(text).origin;
}
const closeRequests = new Map<
  bigint,
  {
    view: string;
    close(force?: boolean): void;
  }
>();
/** Deliver a controlled WebView close callback through the real UI owner's lifecycle. */
export function requestFixtureClose(view: string, force: boolean): void {
  const targets = [
    ...closeRequests.values(),
  ].filter((target) => target.view === view);
  assert.equal(targets.length, 1, "Fixture close target must be unique.");
  targets[0]?.close(force);
}
/** Match the controller callback's failure plus forced-close notification. */
export class WebView {
  failure: unknown;
  constructor(
    readonly hwnd: bigint,
    spec: WindowSpec,
    _assets: string,
    _dataRoot: string,
    _loader: string,
    _origins: readonly string[],
    hooks: {
      ready(): void;
      close(force?: boolean): void;
    },
  ) {
    closeRequests.set(hwnd, {
      view: spec.view,
      close: hooks.close,
    });
    queueMicrotask(() => {
      if (spec.view === controls.failView) {
        this.failure = new Error("Controller completion failed in fixture");
        hooks.close(true);
      } else {
        hooks.ready();
      }
    });
  }
  source(): string {
    return "https://app.bunaway.local";
  }
  navigate(): void {}
  send(): void {}
  requestClose(): void {}
  detach(): boolean {
    return true;
  }
  finish(): boolean {
    closeRequests.delete(this.hwnd);
    return true;
  }
  canReuseProfile(): boolean {
    return true;
  }
}

function unexpectedMonitorQuery(): never {
  throw new Error(
    "Monitor queries are outside this controlled lifecycle fixture.",
  );
}
export const monitorServices: NativeMonitorServices = {
  list: unexpectedMonitorQuery,
  primary: unexpectedMonitorQuery,
  nearestPoint: unexpectedMonitorQuery,
  nearestRect: unexpectedMonitorQuery,
  cursor: unexpectedMonitorQuery,
};
export const windowMonitor = unexpectedMonitorQuery;
