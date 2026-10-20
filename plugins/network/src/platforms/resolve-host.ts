import { lookup } from "node:dns/promises";
import { MAX_RESOLVED_ENDPOINTS } from "#network/contract";

type Endpoint = {
  address: string;
  family: "ipv4" | "ipv6";
};
const FAMILY_OF_QUERY_TYPE = {
  A: 4,
  AAAA: 6,
} as const;

/** Resolver seam, so address mapping and cancellation run without real DNS. */
export type HostLookup = (
  host: string,
  family?: 4 | 6,
) => Promise<
  readonly {
    address: string;
    family: number;
  }[]
>;

export const systemLookup: HostLookup = (host, family) =>
  lookup(host, {
    all: true,
    ...(family === undefined
      ? {}
      : {
          family,
        }),
  });

/**
 * Resolve a name with the operating system resolver (getaddrinfo), which applies the hosts file,
 * search suffixes and the system DNS configuration like the host resolver behind Electron's
 * `net.resolveHost()`. Addresses keep resolver order and repeats are removed. `queryType` limits the
 * result to one address family like Electron's `queryType`. The family is requested from the
 * resolver directly: an unspecified lookup may skip the AAAA query when the machine has no usable
 * IPv6 (macOS does by default), which would turn "AAAA" into an empty list for a name that has
 * IPv6 addresses. A name without an address of that family fails like an unknown name. An IP
 * literal of the other family is returned as it is by the resolver, so the result is also checked
 * and gives an empty list.
 *
 * getaddrinfo cannot be interrupted. On abort the call rejects at once and the lookup finishes in
 * the background, so cancellation and the deadline do not wait for a slow resolver. The caller
 * bounds those background lookups (see `runResolveHost`).
 */
export async function resolveHost(
  host: string,
  signal: AbortSignal,
  find: HostLookup = systemLookup,
  queryType?: "A" | "AAAA",
): Promise<{
  endpoints: Endpoint[];
}> {
  signal.throwIfAborted();
  const wanted = queryType && FAMILY_OF_QUERY_TYPE[queryType];
  const pending = find(host, wanted);
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
    const found = family === 6 ? 6 : 4;
    if (wanted !== undefined && found !== wanted) {
      continue;
    }
    if (!seen.has(address)) {
      seen.add(address);
      endpoints.push({
        address,
        family: found === 6 ? "ipv6" : "ipv4",
      });
    }
  }
  return {
    endpoints: endpoints.slice(0, MAX_RESOLVED_ENDPOINTS),
  };
}
