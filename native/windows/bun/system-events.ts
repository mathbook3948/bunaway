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
const WM_SETTINGCHANGE = 0x001a;
const WM_THEMECHANGED = 0x031a;
const WM_SYSCOLORCHANGE = 0x0015;
const WM_DWMCOLORIZATIONCOLORCHANGED = 0x0320;
const WM_POWERBROADCAST = 0x0218;
const WM_WTSSESSION_CHANGE = 0x02b1;
const PBT_APMPOWERSTATUSCHANGE = 0x000an;
const PBT_APMSUSPEND = 0x0004n;
const PBT_APMRESUMEAUTOMATIC = 0x0012n;
const PBT_APMRESUMESUSPEND = 0x0007n;
const WTS_SESSION_LOCK = 7n;
const WTS_SESSION_UNLOCK = 8n;
const lifecycleSignals = new Set<NativeSystemSignal>([
  "suspend",
  "resume",
  "sessionLocked",
  "sessionUnlocked",
]);

const signals = new Map<number, NativeSystemSignal>([
  [
    WM_SETTINGCHANGE,
    "settingChanged",
  ],
  [
    WM_THEMECHANGED,
    "themeChanged",
  ],
  [
    WM_SYSCOLORCHANGE,
    "colorsChanged",
  ],
  [
    WM_DWMCOLORIZATIONCOLORCHANGED,
    "accentChanged",
  ],
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
      if (this.disposed) {
        return;
      }
      let signal = signals.get(message);
      if (message === WM_POWERBROADCAST) {
        // WM_POWERBROADCAST, scalar event code only.
        if (wparam === PBT_APMPOWERSTATUSCHANGE) {
          signal = "powerStatusChanged";
        } else if (wparam === PBT_APMSUSPEND) {
          signal = "suspend";
        } else if (
          wparam === PBT_APMRESUMEAUTOMATIC ||
          wparam === PBT_APMRESUMESUSPEND
        ) {
          signal = "resume";
        }
      } else if (
        message === WM_WTSSESSION_CHANGE &&
        this.sessionSubscribers > 0
      ) {
        // WM_WTSSESSION_CHANGE
        if (wparam === WTS_SESSION_LOCK) {
          signal = "sessionLocked";
        } else if (wparam === WTS_SESSION_UNLOCK) {
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
    let removed = false;
    return () => {
      if (!removed) {
        if (sessions && this.sessionSubscribers === 1) {
          // Commit removal only after unregister succeeds, so the same disposer can retry.
          this.hooks.sessions(false);
        }
        if (this.subscribers.delete(subscriber) && sessions) {
          this.sessionSubscribers--;
        }
        removed = true;
      }
      if (this.subscribers.size === 0) {
        this.pending.length = 0;
        this.invalidations.clear();
        this.release();
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
    release?.();
    this.releaseWindow = undefined;
  }

  /** Release before Windows disposes its class and callback. Safe after partial adapter initialization. */
  dispose(): void {
    this.disposed = true;
    this.pending.length = 0;
    this.invalidations.clear();
    this.subscribers.clear();
    this.sessionSubscribers = 0;
    this.release();
  }
}
