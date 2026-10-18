import { lookup } from "node:dns/promises";
import { MAX_RESOLVED_ENDPOINTS } from "#network/contract";

type Endpoint = {
  address: string;
  family: "ipv4" | "ipv6";
};
/** Resolver seam, so address mapping and cancellation run without real DNS. */
export type HostLookup = (host: string) => Promise<
  readonly {
    address: string;
    family: number;
  }[]
>;

export const systemLookup: HostLookup = (host) =>
  lookup(host, {
    all: true,
  });

/**
 * Resolve a name with the operating system resolver (getaddrinfo), which applies the hosts file,
 * search suffixes and the system DNS configuration like the host resolver behind Electron's
 * `net.resolveHost()`. Addresses keep resolver order and repeats are removed.
 *
 * getaddrinfo cannot be interrupted. On abort the call rejects at once and the lookup finishes in
 * the background, so cancellation and the deadline do not wait for a slow resolver. The caller
 * bounds those background lookups (see `runResolveHost`).
 */
export async function resolveHost(
  host: string,
  signal: AbortSignal,
  find: HostLookup = systemLookup,
): Promise<{
  endpoints: Endpoint[];
}> {
  signal.throwIfAborted();
  const pending = find(host);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, {
      once: true,
    });
  });
  let addresses: Awaited<typeof pending>;
  try {
    addresses = await Promise.race([
      pending,
      aborted,
    ]);
  } finally {
    // Drop the listener so a finished call does not stay subscribed to a longer-lived signal.
    if (onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
  }
  const seen = new Set<string>();
  const endpoints: Endpoint[] = [];
  for (const { address, family } of addresses) {
    if (!seen.has(address)) {
      seen.add(address);
      endpoints.push({
        address,
        family: family === 6 ? "ipv6" : "ipv4",
      });
    }
  }
  return {
    endpoints: endpoints.slice(0, MAX_RESOLVED_ENDPOINTS),
  };
}
