import { dlopen } from "bun:ffi";
import assert from "node:assert/strict";
import { NativePopupMenu } from "@bunaway/plugin/windows-menu";
import type {
  NativeMenuItem,
  NativeMenuWindowHost,
} from "@bunaway/plugin-api/native";
import { BunawayError } from "@bunaway/protocol";

const WM_ENTERMENULOOP = 0x0211;
const WM_EXITMENULOOP = 0x0212;
const WM_CLOSE = 0x0010;
const WM_MENUCOMMAND = 0x0126;
const WM_TIMER = 0x0113;
const TPM_RETURNCMD = 0x0100;
const TPM_RIGHTBUTTON = 0x0002;
// A native modal menu loop must continue polling the host's cancellation packets.
const MENU_TIMER_ID = 0xb170;
const MENU_POLL_INTERVAL_MS = 50;

/** Narrow ownership boundary used by both the production adapter and contract tests. */
export type WindowMenuDriver = {
  validate(windowId: string): void;
  set(
    windowId: string,
    items: readonly NativeMenuItem[] | null,
    selected: (id: string) => void,
    closed: () => void,
  ): void;
  popup(
    windowId: string,
    items: readonly NativeMenuItem[],
    x: number,
    y: number,
    signal: AbortSignal,
    requestSignal?: AbortSignal,
  ): string | null;
  dispose(): void;
};

type Attachment = {
  hwnd: bigint;
  tree: NativePopupMenu;
  unsubscribe(): void;
};

/** Own independent HMENU trees. Detach before destroying a tree or its HWND owner. */
export class WindowMenus implements WindowMenuDriver {
  private readonly native = dlopen("user32.dll", {
    SetMenu: {
      args: [
        "u64",
        "u64",
      ],
      returns: "i32",
    },
    DrawMenuBar: {
      args: [
        "u64",
      ],
      returns: "i32",
    },
    TrackPopupMenuEx: {
      args: [
        "u64",
        "u32",
        "i32",
        "i32",
        "u64",
        "ptr",
      ],
      returns: "u32",
    },
    EndMenu: {
      args: [],
      returns: "i32",
    },
    SetTimer: {
      args: [
        "u64",
        "u64",
        "u32",
        "ptr",
      ],
      returns: "u64",
    },
    KillTimer: {
      args: [
        "u64",
        "u64",
      ],
      returns: "i32",
    },
    IsWindowEnabled: {
      args: [
        "u64",
      ],
      returns: "i32",
    },
  });
  private readonly attachments = new Map<string, Attachment>();
  private readonly retired = new Set<NativePopupMenu>();
  private popupActive = false;
  private disposed = false;

  constructor(private readonly host: NativeMenuWindowHost) {}

  validate(windowId: string) {
    this.host.resolve(windowId);
  }

  set(
    windowId: string,
    items: readonly NativeMenuItem[] | null,
    selected: (id: string) => void,
    closed: () => void,
  ) {
    const hwnd = this.host.resolve(windowId);
    const previous = this.attachments.get(windowId);
    const tree = items === null ? null : new NativePopupMenu(items, true);
    let unsubscribe: (() => void) | undefined;
    try {
      if (tree) {
        let stopModal: (() => void) | undefined;
        let modalCancelled = false;
        const unlisten = this.host.subscribe(
          windowId,
          (message, position, handle) => {
            if (this.attachments.get(windowId)?.tree !== tree) {
              return;
            }
            if (message === WM_ENTERMENULOOP && position === 0n) {
              stopModal?.();
              modalCancelled = false;
              stopModal = this.keepModalResponsive(hwnd, undefined, () => {
                modalCancelled = true;
                this.native.symbols.EndMenu();
              });
            } else if (message === WM_EXITMENULOOP && position === 0n) {
              stopModal?.();
              stopModal = undefined;
              modalCancelled = false;
            } else if (
              message === WM_TIMER &&
              position === BigInt(MENU_TIMER_ID) &&
              modalCancelled
            ) {
              // EndMenu can run before tracking starts in WM_ENTERMENULOOP.
              // The owned timer retries after Windows has entered its modal loop.
              this.native.symbols.EndMenu();
            } else if (message === WM_CLOSE && stopModal) {
              this.native.symbols.EndMenu();
            }
            if (message !== WM_MENUCOMMAND) {
              return;
            }
            const id = tree.selectedAt(handle, Number(position));
            if (id !== null) {
              selected(id);
            }
          },
          () => {
            this.detach(windowId);
            closed();
          },
        );
        unsubscribe = () => {
          stopModal?.();
          unlisten();
        };
      }
      assert(
        this.native.symbols.SetMenu(hwnd, tree?.handle ?? 0n),
        "Window menu attachment failed.",
      );
    } catch (error) {
      unsubscribe?.();
      if (tree) {
        this.retire(tree);
      }
      throw error;
    }
    // SetMenu transfers no destruction responsibility for the previous detached tree.
    if (tree && unsubscribe) {
      this.attachments.set(windowId, {
        hwnd,
        tree,
        unsubscribe,
      });
    } else {
      this.attachments.delete(windowId);
    }
    previous?.unsubscribe();
    if (previous) {
      this.retire(previous.tree);
    }
    this.native.symbols.DrawMenuBar(hwnd);
    this.host.changed(windowId);
  }

  /** Once SetMenu commits, a failed old-tree release must not undo only the logical state. */
  private retire(tree: NativePopupMenu) {
    this.retired.add(tree);
    try {
      tree.dispose();
      this.retired.delete(tree);
    } catch (error) {
      console.error(
        "Detached window menu release will be retried during cleanup.",
        error,
      );
    }
  }

  private detach(windowId: string) {
    const attached = this.attachments.get(windowId);
    if (!attached) {
      return;
    }
    assert(
      this.native.symbols.SetMenu(attached.hwnd, 0n),
      "Window menu detachment failed.",
    );
    this.attachments.delete(windowId);
    attached.unsubscribe();
    this.retire(attached.tree);
    this.native.symbols.DrawMenuBar(attached.hwnd);
  }

  /** Wake the shared channel during native tracking; only termination runs on its callback stack. */
  private keepModalResponsive(
    hwnd: bigint,
    signal: AbortSignal | undefined,
    cancel: () => void,
  ): () => void {
    const unsubscribe = this.host.interrupt(signal, cancel);
    const timer = this.native.symbols.SetTimer(
      hwnd,
      BigInt(MENU_TIMER_ID),
      MENU_POLL_INTERVAL_MS,
      null,
    );
    if (!timer) {
      unsubscribe();
      this.native.symbols.EndMenu();
      throw new Error("Menu cancellation timer failed.");
    }
    return () => {
      this.native.symbols.KillTimer(hwnd, timer);
      unsubscribe();
    };
  }

  /** Track a temporary snapshot. Cancellation is polled even while Windows owns the modal loop. */
  popup(
    windowId: string,
    items: readonly NativeMenuItem[],
    x: number,
    y: number,
    signal: AbortSignal,
    requestSignal?: AbortSignal,
  ) {
    const hwnd = this.host.resolve(windowId);
    if (this.popupActive || !this.native.symbols.IsWindowEnabled(hwnd)) {
      throw new BunawayError({
        code: "BUSY",
        message: "A menu is already open or its owner is disabled.",
      });
    }
    if (signal.aborted) {
      throw new BunawayError({
        code: "CANCELLED",
        message: "Menu popup cancelled.",
      });
    }
    const tree = new NativePopupMenu(items);
    let unsubscribe: (() => void) | undefined;
    let stopModal: (() => void) | undefined;
    let closed = false;
    const cancel = () => {
      closed = true;
      this.native.symbols.EndMenu();
    };
    this.popupActive = true;
    try {
      unsubscribe = this.host.subscribe(windowId, () => {}, cancel);
      stopModal = this.keepModalResponsive(hwnd, requestSignal, cancel);
      signal.addEventListener("abort", cancel, {
        once: true,
      });
      if (closed) {
        throw new BunawayError({
          code: "CANCELLED",
          message: "Menu popup cancelled.",
        });
      }
      const command = this.native.symbols.TrackPopupMenuEx(
        tree.handle,
        TPM_RETURNCMD | TPM_RIGHTBUTTON,
        x,
        y,
        hwnd,
        null,
      );
      if (closed || signal.aborted) {
        throw new BunawayError({
          code: "CANCELLED",
          message: "Menu popup cancelled.",
        });
      }
      return tree.selected(command);
    } finally {
      signal.removeEventListener("abort", cancel);
      stopModal?.();
      unsubscribe?.();
      this.popupActive = false;
      this.retire(tree);
    }
  }

  dispose() {
    if (this.disposed) {
      return;
    }
    for (const id of this.attachments.keys()) {
      this.detach(id);
    }
    for (const tree of this.retired) {
      tree.dispose();
      this.retired.delete(tree);
    }
    this.native.close();
    this.disposed = true;
  }
}
