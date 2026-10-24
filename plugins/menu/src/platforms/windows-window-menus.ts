import { dlopen } from "bun:ffi";
import assert from "node:assert/strict";
import { pick, USER32, USER32_MENUS } from "@bunaway/plugin/win32";
import { NativePopupMenu } from "@bunaway/plugin/windows-menu";
import type {
  NativeMenuItem,
  NativeMenuWindowHost,
} from "@bunaway/plugin-api/native";
import { BunawayError } from "@bunaway/protocol";

const WM_ENTERMENULOOP = 0x0211;
const WM_EXITMENULOOP = 0x0212;
const WM_CLOSE = 0x0010;
const WM_ACTIVATE = 0x0006;
const WM_KEYDOWN = 0x0100;
const WM_KEYUP = 0x0101;
const WM_SYSKEYDOWN = 0x0104;
const WM_SYSKEYUP = 0x0105;
const VK_ESCAPE = 0x1b;
const VK_MENU = 0x12;
const WA_INACTIVE = 0;
const WM_MENUCOMMAND = 0x0126;
const WM_TIMER = 0x0113;
const TPM_RETURNCMD = 0x0100;
const TPM_RIGHTBUTTON = 0x0002;
// A native modal menu loop must continue polling the host's cancellation packets.
const MENU_TIMER_ID = 0xb170;
const MENU_POLL_INTERVAL_MS = 50;

/** Narrow ownership boundary used by both the production adapter and contract tests. */
export type WindowMenuDriver = {
  /** The app's open window; INVALID_ARGUMENT when there is none. */
  current(): string;
  validate(windowId: string): void;
  set(
    windowId: string,
    items: readonly NativeMenuItem[] | null,
    selected: (id: string) => void,
    closed: () => void,
  ): void;
  setVisible(windowId: string, visible: boolean): void;
  isVisible(windowId: string): boolean;
  setAutoHide(windowId: string, autoHide: boolean): void;
  isAutoHide(windowId: string): boolean;
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
    ...pick(USER32, "DrawMenuBar", "SetTimer", "KillTimer", "IsWindowEnabled"),
    ...pick(USER32_MENUS, "TrackPopupMenuEx"),
    SetMenu: {
      args: [
        "u64",
        "u64",
      ],
      returns: "i32",
    },
    EndMenu: {
      args: [],
      returns: "i32",
    },
  });
  private readonly attachments = new Map<string, Attachment>();
  private readonly retired = new Set<NativePopupMenu>();
  /** Windows whose menu bar is hidden; the attached tree is kept and only unlinked from the HWND. */
  private readonly hidden = new Set<string>();
  /** Windows whose menu bar shows only after an Alt tap; it hides again on Esc, a command or deactivation. */
  private readonly autoHide = new Set<string>();
  /** Auto-hide windows whose menu bar is currently shown by an Alt tap. */
  private readonly revealed = new Set<string>();
  /** Windows where Alt went down and no other key has followed, so its release is an Alt tap. */
  private readonly altArmed = new Set<string>();
  private popupActive = false;
  private disposed = false;

  constructor(private readonly host: NativeMenuWindowHost) {}

  current() {
    return this.host.current();
  }

  validate(windowId: string) {
    this.resolve(windowId);
  }

  /** A closed window can no longer be addressed, so its visibility flag is dropped. */
  private resolve(windowId: string) {
    try {
      return this.host.resolve(windowId);
    } catch (error) {
      this.forget(windowId);
      throw error;
    }
  }

  /** Drop the per-window menu bar state once the window can no longer be addressed. */
  private forget(windowId: string) {
    this.hidden.delete(windowId);
    this.autoHide.delete(windowId);
    this.revealed.delete(windowId);
    this.altArmed.delete(windowId);
  }

  /** An auto-hide window allows its bar only after an Alt tap. */
  private autoHideAllowsBar(windowId: string) {
    return !this.autoHide.has(windowId) || this.revealed.has(windowId);
  }

  /** Link or unlink the attached tree, leaving the recorded state to the caller until this succeeds. */
  private link(windowId: string, hwnd: bigint, shown: boolean) {
    const attached = this.attachments.get(windowId);
    if (attached) {
      assert(
        this.native.symbols.SetMenu(hwnd, shown ? attached.tree.handle : 0n),
        "Window menu bar visibility change failed.",
      );
    }
    return attached !== undefined;
  }

  private redraw(hwnd: bigint, windowId: string) {
    this.native.symbols.DrawMenuBar(hwnd);
    this.host.changed(windowId);
  }

  setVisible(windowId: string, visible: boolean) {
    const hwnd = this.resolve(windowId);
    const attached = this.link(
      windowId,
      hwnd,
      visible && this.autoHideAllowsBar(windowId),
    );
    if (visible) {
      this.hidden.delete(windowId);
    } else {
      this.hidden.add(windowId);
      this.revealed.delete(windowId);
      this.altArmed.delete(windowId);
    }
    if (attached) {
      this.redraw(hwnd, windowId);
    }
  }

  isVisible(windowId: string) {
    this.resolve(windowId);
    return !this.hidden.has(windowId);
  }

  setAutoHide(windowId: string, autoHide: boolean) {
    const hwnd = this.resolve(windowId);
    const attached = this.link(
      windowId,
      hwnd,
      !this.hidden.has(windowId) && !autoHide,
    );
    if (autoHide) {
      this.autoHide.add(windowId);
    } else {
      this.autoHide.delete(windowId);
    }
    this.revealed.delete(windowId);
    this.altArmed.delete(windowId);
    if (attached) {
      this.redraw(hwnd, windowId);
    }
  }

  isAutoHide(windowId: string) {
    this.resolve(windowId);
    return this.autoHide.has(windowId);
  }

  set(
    windowId: string,
    items: readonly NativeMenuItem[] | null,
    selected: (id: string) => void,
    closed: () => void,
  ) {
    const hwnd = this.resolve(windowId);
    const previous = this.attachments.get(windowId);
    const tree = items === null ? null : new NativePopupMenu(items, true);
    let unsubscribe: (() => void) | undefined;
    try {
      if (tree) {
        unsubscribe = this.listen(windowId, hwnd, tree, selected, closed);
      }
      assert(
        this.native.symbols.SetMenu(
          hwnd,
          tree && !this.hidden.has(windowId) && !this.autoHide.has(windowId)
            ? tree.handle
            : 0n,
        ),
        "Window menu attachment failed.",
      );
    } catch (error) {
      unsubscribe?.();
      if (tree) {
        this.retire(tree);
      }
      throw error;
    }
    // An Alt tap belongs to the tree it showed; a new or removed tree starts hidden again.
    this.revealed.delete(windowId);
    this.altArmed.delete(windowId);
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

  /**
   * Subscribe to the window's menu messages for `tree`: keep the modal loop cancellable while it
   * is open and route a chosen item to its role or to `selected`. The returned function stops the
   * modal timer and the subscription; messages are ignored once another tree is attached.
   */
  private listen(
    windowId: string,
    hwnd: bigint,
    tree: NativePopupMenu,
    selected: (id: string) => void,
    closed: () => void,
  ): () => void {
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
          // Windows enters keyboard menu mode after a frame Alt tap and consumes Esc and the next
          // Alt there, so leaving it ends the temporary display.
          this.hideRevealedLater(windowId);
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
        this.trackAltTap(windowId, message, position);
        if (message !== WM_MENUCOMMAND) {
          return;
        }
        const item = tree.selectedItemAt(handle, Number(position));
        if (item?.role) {
          // A role runs its command and is not an app-level selection.
          this.host.executeRole(windowId, item.role);
        } else if (item) {
          selected(item.id);
        }
        // A bar shown by an Alt tap goes away once a command has run.
        this.hideRevealedLater(windowId);
      },
      () => {
        this.detach(windowId);
        closed();
      },
    );
    return () => {
      stopModal?.();
      unlisten();
    };
  }

  /**
   * Alt pressed and released with no other key in between shows or hides an auto-hide bar. Esc and
   * losing activation hide a shown bar. The keys arrive from the window procedure when the frame
   * has focus and from the WebView's accelerator event when the page has it.
   */
  private trackAltTap(windowId: string, message: number, wparam: bigint) {
    if (!this.autoHide.has(windowId) || this.hidden.has(windowId)) {
      return;
    }
    const key = Number(wparam);
    if (message === WM_SYSKEYDOWN || message === WM_KEYDOWN) {
      if (key === VK_MENU) {
        this.altArmed.add(windowId);
        return;
      }
      this.altArmed.delete(windowId);
      if (key === VK_ESCAPE) {
        this.reveal(windowId, false);
      }
    } else if (message === WM_SYSKEYUP || message === WM_KEYUP) {
      if (key === VK_MENU && this.altArmed.delete(windowId)) {
        this.reveal(windowId, !this.revealed.has(windowId));
      }
    } else if (
      message === WM_ACTIVATE &&
      Number(wparam & 0xffffn) === WA_INACTIVE
    ) {
      this.altArmed.delete(windowId);
      this.reveal(windowId, false);
    }
  }

  /** The native menu loop is still unwinding in its messages, so the bar is unlinked from the next turn. */
  private hideRevealedLater(windowId: string) {
    if (this.revealed.has(windowId)) {
      setTimeout(() => this.reveal(windowId, false), 0);
    }
  }

  /** Show or hide the bar of an auto-hide window. Keyboard input must not throw, so failures are logged. */
  private reveal(windowId: string, shown: boolean) {
    if (!this.autoHide.has(windowId) || this.revealed.has(windowId) === shown) {
      return;
    }
    try {
      const hwnd = this.host.resolve(windowId);
      this.link(windowId, hwnd, shown);
      if (shown) {
        this.revealed.add(windowId);
      } else {
        this.revealed.delete(windowId);
      }
      this.redraw(hwnd, windowId);
    } catch (error) {
      console.error("Window menu bar auto-hide change failed.", error);
    }
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
    this.forget(windowId);
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
      unsubscribe = this.host.subscribe(
        windowId,
        (message, wparam) => {
          if (
            closed &&
            message === WM_TIMER &&
            wparam === BigInt(MENU_TIMER_ID)
          ) {
            // EndMenu can run before TrackPopupMenuEx starts tracking.
            // The owned timer retries after Windows has entered its modal loop.
            this.native.symbols.EndMenu();
          }
        },
        cancel,
      );
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
      const item = tree.selectedItem(command);
      if (item?.role) {
        // Report no selection for a role; run it once the popup has released focus.
        this.host.executeRole(windowId, item.role);
        return null;
      }
      return item?.id ?? null;
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
