import { networkInterfaces } from "node:os";

/** How often the interface list is compared with the last published value. */
export const ONLINE_POLL_INTERVAL_MS = 2000;

type InterfaceAddress = {
  address: string;
  internal: boolean;
};
type InterfaceTable = Record<string, readonly InterfaceAddress[] | undefined>;

const IPV4_LINK_LOCAL_PREFIX = "169.254.";
/** fe80::/10 covers the first hextets fe80 through febf. */
const IPV6_LINK_LOCAL_FIRST_HEXTET_MIN = 0xfe80;
const IPV6_LINK_LOCAL_FIRST_HEXTET_MAX = 0xfebf;

/** IPv4 169.254.0.0/16 and IPv6 fe80::/10, which interfaces assign without any network. */
function isLinkLocal(address: string): boolean {
  if (address.startsWith(IPV4_LINK_LOCAL_PREFIX)) {
    return true;
  }
  const firstHextet = Number.parseInt(address.split(":")[0] ?? "", 16);
  return (
    address.includes(":") &&
    firstHextet >= IPV6_LINK_LOCAL_FIRST_HEXTET_MIN &&
    firstHextet <= IPV6_LINK_LOCAL_FIRST_HEXTET_MAX
  );
}

/**
 * Whether any interface holds a routable-class address: not loopback and not link-local.
 *
 * Bun lists addresses of operational adapters only (GetAdaptersAddresses on Windows, getifaddrs
 * on macOS). This corresponds to the active-connection check behind Electron's `net.isOnline()`
 * (Chromium `NetworkChangeNotifier::IsOffline()`), and says nothing about captive portals or
 * internet reachability. Link-local addresses are ignored so a failed DHCP lease, or the
 * fe80 addresses of macOS system interfaces (awdl, utun, bridge), do not count as a connection.
 * Virtual adapters (VPN, Hyper-V, WSL, Docker) that hold any other address do count.
 */
export function hasActiveConnection(
  interfaces: InterfaceTable = networkInterfaces(),
): boolean {
  return Object.values(interfaces).some((addresses) =>
    addresses?.some((entry) => !entry.internal && !isLinkLocal(entry.address)),
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
 * The first successful read is the baseline and is not published. If it fails, the failure is
 * reported to `fail` and the baseline is taken on a later tick, also without publishing. A
 * failing read or publish later on keeps the previous baseline and is retried on the next tick.
 * Returns a stop function that is safe to call repeatedly.
 */
export function watchOnline(host: OnlineWatchHost): () => void {
  let lastPublished: boolean | undefined;
  let stopped = false;
  const check = () => {
    try {
      const online = host.read();
      if (lastPublished === undefined) {
        lastPublished = online;
      } else if (online !== lastPublished) {
        host.publish(online);
        lastPublished = online;
      }
    } catch (error) {
      host.fail(error);
    }
  };
  check();
  const stopPolling = host.startPolling(() => {
    if (!stopped) {
      check();
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
