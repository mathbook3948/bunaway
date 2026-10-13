import type {
  NativeSystemEvents,
  NativeSystemSignal,
} from "@bunaway/plugin-api/native";
import type { JsonValue, NativeRegistry, Policy } from "@bunaway/protocol";

/** Recheck each live subscription and its independent read-operation grant before delivery. */
export function publishSystemEvent<
  T extends {
    policy: {
      host: Policy["backend"];
    };
    eventRoute(event: string): unknown;
  },
>(
  registry: Pick<NativeRegistry, "operations" | "allowed">,
  recipients: Iterable<T>,
  event: string,
  payload: JsonValue,
  requiredOperation: string,
  send: (recipient: T, event: string, payload: JsonValue) => void,
): void {
  if (!registry.operations.has(requiredOperation)) {
    return;
  }
  for (const recipient of recipients) {
    if (
      recipient.eventRoute(event) &&
      registry.allowed(recipient.policy.host, {
        operation: requiredOperation,
        payload: null,
      })
    ) {
      send(recipient, event, payload);
    }
  }
}

// These broadcasts reach top-level windows, including hidden windows, but not message-only windows.
const MAX_PENDING_SIGNALS = 128;
const lifecycleSignals = new Set<NativeSystemSignal>([
  "suspend",
  "resume",
  "sessionLocked",
  "sessionUnlocked",
]);

const signals = new Map<number, NativeSystemSignal>([
  [
    0x001a,
    "settingChanged",
  ], // WM_SETTINGCHANGE
  [
    0x031a,
    "themeChanged",
  ], // WM_THEMECHANGED
  [
    0x0015,
    "colorsChanged",
  ], // WM_SYSCOLORCHANGE
  [
    0x0320,
    "accentChanged",
  ], // WM_DWMCOLORIZATIONCOLORCHANGED
]);

/** Owns a lazily acquired notification window and bounded post-pump invalidations. */
export class SystemEvents implements NativeSystemEvents {
  private readonly subscribers = new Set<
    (signal: NativeSystemSignal) => void
  >();
  private readonly pending: NativeSystemSignal[] = [];
  private readonly invalidations = new Set<NativeSystemSignal>();
  private sessionSubscribers = 0;
  private overflow = false;
  private releaseWindow: (() => void) | undefined;
  private disposed = false;

  constructor(
    private readonly hooks: {
      open(receive: (message: number, wparam: bigint) => void): () => void;
      sessions(enable: boolean): void;
      publish(
        event: string,
        payload: JsonValue,
        requiredOperation: string,
      ): void;
      report(error: unknown): void;
    },
  ) {}

  /** Acquire on the first subscription, release on the last; returned cleanup is repeatable. */
  subscribe(
    receive: (signal: NativeSystemSignal) => void,
    options: {
      sessionNotifications?: boolean;
    } = {},
  ): () => void {
    if (this.disposed) {
      throw new Error("System event service is disposed.");
    }
    this.releaseWindow ??= this.hooks.open((message, wparam) => {
      let signal = signals.get(message);
      if (message === 0x0218) {
        // WM_POWERBROADCAST, scalar event code only.
        if (wparam === 0x000an) {
          signal = "powerStatusChanged";
        } else if (wparam === 0x0004n) {
          signal = "suspend";
        } else if (wparam === 0x0012n || wparam === 0x0007n) {
          signal = "resume";
        }
      } else if (message === 0x02b1 && this.sessionSubscribers > 0) {
        // WM_WTSSESSION_CHANGE
        if (wparam === 7n) {
          signal = "sessionLocked";
        } else if (wparam === 8n) {
          signal = "sessionUnlocked";
        }
      }
      if (!signal) {
        return;
      }
      if (lifecycleSignals.has(signal)) {
        if (this.pending.at(-1) === signal) {
          return;
        }
      } else {
        if (this.invalidations.has(signal)) {
          return;
        }
        this.invalidations.add(signal);
      }
      if (this.pending.length >= MAX_PENDING_SIGNALS) {
        this.overflow = true;
        return;
      }
      this.pending.push(signal);
    });
    const sessions = options.sessionNotifications === true;
    if (sessions && this.sessionSubscribers === 0) {
      try {
        this.hooks.sessions(true);
      } catch (error) {
        if (this.subscribers.size === 0) {
          this.releaseWindow?.();
          this.releaseWindow = undefined;
        }
        throw error;
      }
    }
    if (sessions) {
      this.sessionSubscribers++;
    }
    // Each registration owns its lifetime, even when callers pass the same callback twice.
    const subscriber = (signal: NativeSystemSignal) => receive(signal);
    this.subscribers.add(subscriber);
    return () => {
      if (!this.subscribers.delete(subscriber)) {
        return;
      }
      if (sessions && --this.sessionSubscribers === 0) {
        try {
          this.hooks.sessions(false);
        } catch (error) {
          // The window owner also retries unregister during destruction.
          if (this.subscribers.size === 0) {
            this.release();
          }
          throw error;
        }
      }
      if (this.subscribers.size === 0) {
        this.pending.length = 0;
        this.invalidations.clear();
        this.releaseWindow?.();
        this.releaseWindow = undefined;
      }
    };
  }

  publish(event: string, payload: JsonValue, requiredOperation: string): void {
    if (!this.disposed) {
      this.hooks.publish(event, payload, requiredOperation);
    }
  }

  /** Run outside WndProc. Reentrant notifications remain queued for the next pump. */
  flush(): void {
    if (this.overflow) {
      throw new Error("Native system notification queue full.");
    }
    const pending = this.pending.splice(0);
    this.invalidations.clear();
    for (const signal of pending) {
      for (const subscriber of [
        ...this.subscribers,
      ]) {
        if (!this.subscribers.has(subscriber)) {
          continue;
        }
        try {
          subscriber(signal);
        } catch (error) {
          // Keep subscriptions and native resources intact; the next signal can recover a failed read.
          this.hooks.report(error);
        }
      }
    }
  }

  private release(): void {
    const release = this.releaseWindow;
    this.releaseWindow = undefined;
    release?.();
  }

  /** Release before Windows disposes its class and callback. Safe after partial adapter initialization. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.pending.length = 0;
    this.invalidations.clear();
    this.subscribers.clear();
    this.sessionSubscribers = 0;
    this.release();
  }
}
