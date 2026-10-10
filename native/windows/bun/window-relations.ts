import type { WindowIdentity } from "@bunaway/plugin-api/native";
import { BunawayError } from "@bunaway/protocol";

type OwnedWindow = {
  identity: WindowIdentity;
  parent: string | null;
  modal: boolean;
  closing: boolean;
};

/** Owns lifetime relationships and restores input only after the last modal resource owner releases. */
export class WindowRelations {
  private readonly windows = new Map<string, OwnedWindow>();
  private readonly blocked = new Map<
    string,
    {
      count: number;
      enabled: boolean;
    }
  >();

  constructor(
    private readonly native: {
      setOwner(child: string, parent: string | null): void;
      isEnabled(windowId: string): boolean;
      setEnabled(windowId: string, enabled: boolean): void;
    },
  ) {}

  register(identity: WindowIdentity) {
    this.windows.set(identity.windowId, {
      identity,
      parent: null,
      modal: false,
      closing: false,
    });
  }

  private read(windowId: string): OwnedWindow {
    const window = this.windows.get(windowId);
    if (!window || window.closing) {
      throw new BunawayError({
        code: "INVALID_ARGUMENT",
        message: "Window lifetime is not open.",
      });
    }
    return window;
  }

  getParent(windowId: string): WindowIdentity | null {
    const parent = this.windows.get(windowId)?.parent;
    const window = parent ? this.windows.get(parent) : undefined;
    return window && !window.closing
      ? {
          ...window.identity,
        }
      : null;
  }

  getChildren(windowId: string): WindowIdentity[] {
    return [
      ...this.windows.values(),
    ]
      .filter((window) => window.parent === windowId && !window.closing)
      .map((window) => ({
        ...window.identity,
      }));
  }

  /** Validates the entire change before native mutation. Modal owner changes require detaching first. */
  setParent(windowId: string, parent: string | null, modal: boolean) {
    const window = this.read(windowId);
    if (modal && parent === null) {
      throw new BunawayError({
        code: "INVALID_ARGUMENT",
        message: "A modal window requires a parent.",
      });
    }
    for (
      let ancestor = parent;
      ancestor !== null;
      ancestor = this.read(ancestor).parent
    ) {
      if (ancestor === windowId) {
        throw new BunawayError({
          code: "INVALID_ARGUMENT",
          message: "Window ownership cannot contain a cycle.",
        });
      }
    }
    if (window.parent === parent && window.modal === modal) {
      return;
    }
    if (window.modal && modal && window.parent !== parent) {
      throw new BunawayError({
        code: "BUSY",
        message: "Detach the modal before changing its parent.",
      });
    }
    const oldParent = window.parent;
    this.native.setOwner(windowId, parent);
    try {
      if (modal && parent !== null && !window.modal) {
        this.block(parent);
      }
      if (window.modal && oldParent !== null) {
        this.unblock(oldParent);
      }
    } catch (error) {
      this.native.setOwner(windowId, oldParent);
      throw error;
    }
    window.parent = parent;
    window.modal = modal;
  }

  setEnabled(windowId: string, enabled: boolean) {
    this.read(windowId);
    if (this.blocked.has(windowId)) {
      throw new BunawayError({
        code: "BUSY",
        message: "Modal windows are blocking parent input.",
      });
    }
    this.native.setEnabled(windowId, enabled);
  }

  private block(windowId: string) {
    const previous = this.blocked.get(windowId);
    if (previous) {
      previous.count++;
      return;
    }
    const enabled = this.native.isEnabled(windowId);
    this.native.setEnabled(windowId, false);
    this.blocked.set(windowId, {
      count: 1,
      enabled,
    });
  }

  private unblock(windowId: string) {
    const previous = this.blocked.get(windowId);
    if (!previous) {
      return;
    }
    if (previous.count > 1) {
      previous.count--;
      return;
    }
    if (!this.windows.get(windowId)?.closing) {
      this.native.setEnabled(windowId, previous.enabled);
    }
    this.blocked.delete(windowId);
  }

  /** Captures descendants in postorder, including already-closing resource owners. */
  closeOrder(windowId: string): string[] {
    const order: string[] = [];
    const visit = (id: string) => {
      for (const [childId, child] of this.windows) {
        if (child.parent === id) {
          visit(childId);
        }
      }
      order.push(id);
    };
    visit(windowId);
    return order;
  }

  markClosing(windowId: string) {
    const window = this.windows.get(windowId);
    if (window) {
      window.closing = true;
    }
  }

  canRelease(windowId: string): boolean {
    for (const window of this.windows.values()) {
      if (window.parent === windowId) {
        return false;
      }
    }
    return true;
  }

  /** Called after HWND destruction and WebView completion, before the same view can be recreated. */
  release(windowId: string) {
    const window = this.windows.get(windowId);
    if (!window) {
      return;
    }
    if (!this.canRelease(windowId)) {
      throw new Error("Owned windows must release before their parent.");
    }
    if (window.modal && window.parent !== null) {
      this.unblock(window.parent);
    }
    this.windows.delete(windowId);
    this.blocked.delete(windowId);
  }
}
