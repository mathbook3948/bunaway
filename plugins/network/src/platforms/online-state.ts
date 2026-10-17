import { networkInterfaces } from "node:os";

/** How often the interface list is compared with the last published value. */
export const ONLINE_POLL_INTERVAL_MS = 2000;

type InterfaceTable = Record<
  string,
  | readonly {
      internal: boolean;
    }[]
  | undefined
>;

/**
 * Whether any non-loopback interface holds an address.
 *
 * Bun lists addresses of operational adapters only (GetAdaptersAddresses on Windows, getifaddrs
 * on macOS) and marks loopback as internal. This matches the question Chromium's
 * `NetworkChangeNotifier::IsOffline()` answers for Electron's `net.isOnline()`: a local network
 * connection exists. It says nothing about captive portals or whether the internet is reachable.
 */
export function hasActiveConnection(
  interfaces: InterfaceTable = networkInterfaces(),
): boolean {
  return Object.values(interfaces).some((addresses) =>
    addresses?.some((address) => !address.internal),
  );
}

/** Environment seams, so change detection runs without real interfaces or timers. */
export type OnlineWatchHost = {
  read(): boolean;
  publish(online: boolean): void;
  /** Starts a repeating timer and returns its stop function. */
  startPolling(poll: () => void, intervalMs: number): () => void;
  /** Receives failures of the timer-driven check, which has no caller to propagate to. */
  fail(error: unknown): void;
};

/**
 * Publish only when the observed value differs from the last published one.
 *
 * The first read is the baseline and is not published. A failing read or publish is reported to
 * `fail`, keeps the previous baseline and is retried on the next tick. Returns a stop function
 * that is safe to call repeatedly.
 */
export function watchOnline(host: OnlineWatchHost): () => void {
  let lastPublished = host.read();
  let stopped = false;
  const stopPolling = host.startPolling(() => {
    if (stopped) {
      return;
    }
    try {
      const online = host.read();
      if (online !== lastPublished) {
        host.publish(online);
        lastPublished = online;
      }
    } catch (error) {
      host.fail(error);
    }
  }, ONLINE_POLL_INTERVAL_MS);
  return () => {
    stopped = true;
    stopPolling();
  };
}

/** Poll with an unreferenced timer, so the watcher never keeps the process alive. */
export function startIntervalPolling(
  poll: () => void,
  intervalMs: number,
): () => void {
  const timer = setInterval(poll, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
