import assert from "node:assert/strict";
import { workerData } from "node:worker_threads";
import type {
  NativeMonitorServices,
  WindowSpec,
} from "@bunaway/plugin-api/native";
import { DownloadCleanupError } from "../../native/windows/bun/downloads.ts";
import type { SessionMessageHandler } from "../../native/windows/bun/session-end.ts";
import {
  uiCleanupSlots,
  uiLifecycleSlots,
  uiWebRequestKinds,
} from "./windows-ui-cleanup.ts";

// Controlled native boundary for the real UI Worker. No HWND, DLL or COM is loaded.
const controls = workerData as {
  failView?: string;
  trayFailures?: number;
  cleanup: SharedArrayBuffer;
  lifecycle: SharedArrayBuffer;
  /** UTF-8 JSON of the next renderer message; its length is in `uiLifecycleSlots.webLength`. */
  webMessage?: SharedArrayBuffer;
  failCreationNumber?: number;
  creationFailure?: "controller" | "constructor";
  holdCreationNumber?: number;
};
const cleanup = new Int32Array(controls.cleanup);
const lifecycle = new Int32Array(controls.lifecycle);
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
    CoUninitialize() {
      assert.equal(Atomics.load(cleanup, uiCleanupSlots.windows), 1);
      Atomics.add(cleanup, uiCleanupSlots.apartment, 1);
    },
  },
};
export function hr(result: number): void {
  assert(result >= 0);
}
export function disposeWin32Bindings(): void {
  assert.equal(Atomics.load(cleanup, uiCleanupSlots.apartment), 1);
  Atomics.add(cleanup, uiCleanupSlots.bindings, 1);
}
export function checkCallbacks(): void {}
export function callbackCalls(): number[] {
  return [];
}
export function disposeCom(): object {
  Atomics.add(cleanup, uiCleanupSlots.com, 1);
  return {};
}
export class Tray {
  readonly hwnd = 999n;
  dispose(): void {
    const attempt = Atomics.add(cleanup, uiCleanupSlots.tray, 1) + 1;
    if (attempt <= (controls.trayFailures ?? 0)) {
      throw new Error("Injected tray icon cleanup failure");
    }
  }
}

/** Model only native identity and visibility used by these lifecycle scenarios. */
export class Windows {
  /** The UI owner passes its session handler as the fifth argument, as with the real class. */
  constructor(
    _shutdown?: () => void,
    _icon?: string,
    _appId?: string,
    _pollMessages?: () => void,
    private readonly sessionMessage?: SessionMessageHandler,
  ) {}

  validateCreation() {}

  private sequence = 0n;
  private readonly windows = new Map<
    bigint,
    {
      view: string;
      visible: boolean;
      closable: boolean;
      enabled: boolean;
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
      enabled: true,
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
        alwaysOnTop: false,
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

  /** These UI-loop fixtures use the default focusable policy. */
  showForDesktop(hwnd: bigint): void {
    this.focus(hwnd);
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
  setOwner(child: bigint, parent: bigint): void {
    this.read(child);
    if (parent !== 0n) {
      this.read(parent);
    }
  }
  isEnabled(hwnd: bigint): boolean {
    return this.read(hwnd).enabled;
  }
  setEnabled(hwnd: bigint, enabled: boolean): void {
    if (enabled) {
      Atomics.add(lifecycle, uiLifecycleSlots.inputRestores, 1);
      if (Atomics.load(lifecycle, uiLifecycleSlots.inputRestoreFailures) > 0) {
        Atomics.sub(lifecycle, uiLifecycleSlots.inputRestoreFailures, 1);
        throw new Error("Injected parent input restoration failure");
      }
    }
    this.read(hwnd).enabled = enabled;
  }
  getTitle(hwnd: bigint): string {
    return this.read(hwnd).view;
  }
  confirmClose(): boolean {
    Atomics.add(lifecycle, uiLifecycleSlots.confirmations, 1);
    return Atomics.load(lifecycle, uiLifecycleSlots.confirmClose) === 1;
  }
  destroy(hwnd: bigint): void {
    if (this.read(hwnd).view) {
      Atomics.add(lifecycle, uiLifecycleSlots.destroy, 1);
    }
    assert(this.windows.delete(hwnd));
  }
  /** Delivers one test-requested window message to the UI owner's session handler, like a WndProc. */
  pump(): void {
    deliverFixtureWebRequest();
    if (Atomics.exchange(lifecycle, uiLifecycleSlots.sessionRequest, 0) !== 1) {
      return;
    }
    const result = this.sessionMessage?.(
      Atomics.load(lifecycle, uiLifecycleSlots.sessionMessage),
      BigInt(Atomics.load(lifecycle, uiLifecycleSlots.sessionWparam)),
      BigInt(Atomics.load(lifecycle, uiLifecycleSlots.sessionLparam) >>> 0),
    );
    Atomics.store(
      lifecycle,
      uiLifecycleSlots.sessionResult,
      result === undefined ? -1 : Number(result),
    );
    Atomics.store(lifecycle, uiLifecycleSlots.sessionDone, 1);
    Atomics.notify(lifecycle, uiLifecycleSlots.sessionDone);
  }
  dispose(): void {
    assert.equal(this.windows.size, 0, "Fixture window leaked");
    assert.equal(Atomics.load(cleanup, uiCleanupSlots.com), 1);
    if (controls.trayFailures !== undefined) {
      assert.equal(Atomics.load(cleanup, uiCleanupSlots.adapter), 1);
    }
    Atomics.add(cleanup, uiCleanupSlots.windows, 1);
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
const FIXTURE_SOURCE = "https://app.bunaway.local";
const webViews = new Map<
  bigint,
  {
    message(source: string, raw: string): void;
    documentComplete(error: null): void;
    revoke(reason: string): void;
  }
>();
/** Replay one test-requested renderer action (document completion, navigation or web message) on the UI thread. */
function deliverFixtureWebRequest(): void {
  if (Atomics.exchange(lifecycle, uiLifecycleSlots.webRequest, 0) !== 1) {
    return;
  }
  const hwnd = BigInt(Atomics.load(lifecycle, uiLifecycleSlots.webTarget));
  const target = webViews.get(hwnd);
  assert(target, "Fixture web target must be a live window.");
  const kind = Atomics.load(lifecycle, uiLifecycleSlots.webKind);
  if (kind === uiWebRequestKinds.documentComplete) {
    target.documentComplete(null);
  } else if (kind === uiWebRequestKinds.navigation) {
    target.revoke("navigation");
  } else if (kind === uiWebRequestKinds.close) {
    const closeTarget = closeRequests.get(hwnd);
    assert(closeTarget, "Fixture close target must be a live window.");
    closeTarget.close(false);
  } else {
    assert(controls.webMessage, "Fixture web message buffer is missing.");
    const length = Atomics.load(lifecycle, uiLifecycleSlots.webLength);
    // slice() copies out of the shared buffer, which TextDecoder cannot read directly.
    const bytes = new Uint8Array(controls.webMessage).slice(0, length);
    target.message(FIXTURE_SOURCE, new TextDecoder().decode(bytes));
  }
  Atomics.store(lifecycle, uiLifecycleSlots.webDone, 1);
  Atomics.notify(lifecycle, uiLifecycleSlots.webDone);
}
/** Deliver a controlled WebView close callback through the real UI owner's lifecycle. */
export function requestFixtureClose(view: string, force: boolean): void {
  const targets = [
    ...closeRequests.values(),
  ].filter((target) => target.view === view);
  assert.equal(targets.length, 1, "Fixture close target must be unique.");
  targets[0]?.close(force);
}
/** Controller completion withheld for the creation numbered `holdCreationNumber`, until settled. */
let heldController:
  | {
      ready(): void;
      fail(): void;
    }
  | undefined;
/**
 * Completes the withheld controller as ready or failed, as when WebView2 answers late.
 * Returns whether a controller was waiting.
 */
export function settleHeldController(outcome: "ready" | "fail"): boolean {
  const held = heldController;
  heldController = undefined;
  held?.[outcome]();
  return held !== undefined;
}
/** Whether a controller completion is currently withheld. */
export function hasHeldController(): boolean {
  return heldController !== undefined;
}
/** Match the controller callback's failure plus forced-close notification. */
export class WebView {
  failure: unknown;
  private static creations = 0;
  private readonly creationNumber = ++WebView.creations;
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
      message(source: string, raw: string): void;
      documentComplete(error: null): void;
      revoke(reason: string): void;
    },
  ) {
    if (
      this.creationNumber === controls.failCreationNumber &&
      controls.creationFailure === "constructor"
    ) {
      throw new Error("WebView constructor failed in fixture");
    }
    closeRequests.set(hwnd, {
      view: spec.view,
      close: hooks.close,
    });
    webViews.set(hwnd, hooks);
    const fail = () => {
      this.failure = new Error("Controller completion failed in fixture");
      hooks.close(true);
    };
    queueMicrotask(() => {
      if (this.creationNumber === controls.holdCreationNumber) {
        heldController = {
          ready: () => hooks.ready(),
          fail,
        };
      } else if (
        spec.view === controls.failView ||
        this.creationNumber === controls.failCreationNumber
      ) {
        fail();
      } else {
        hooks.ready();
      }
    });
  }
  source(): string {
    return FIXTURE_SOURCE;
  }
  navigate(): void {}
  send(): void {}
  requestClose(): void {
    Atomics.add(lifecycle, uiLifecycleSlots.close, 1);
  }
  detach(): boolean {
    Atomics.add(lifecycle, uiLifecycleSlots.detach, 1);
    if (Atomics.load(lifecycle, uiLifecycleSlots.detachFailures) > 0) {
      Atomics.sub(lifecycle, uiLifecycleSlots.detachFailures, 1);
      throw new DownloadCleanupError([
        new Error("download cancel failed"),
      ]);
    }
    return true;
  }
  isBrowserUnavailable(): boolean {
    return false;
  }
  finish(): boolean {
    Atomics.add(lifecycle, uiLifecycleSlots.finish, 1);
    closeRequests.delete(this.hwnd);
    webViews.delete(this.hwnd);
    return true;
  }
  canReuseProfile(): boolean {
    return Atomics.load(lifecycle, uiLifecycleSlots.holdProfileReuse) === 0;
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
