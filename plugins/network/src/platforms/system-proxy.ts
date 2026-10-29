import { BunawayError } from "@bunaway/protocol";
import type { ProxyEntry } from "#network/platforms/proxy-rules";
import {
  resolveProxy,
  type WinHttpApi,
} from "#network/platforms/resolve-proxy";

/**
 * The proxy a request should use, as an address for Bun, or undefined for a direct connection.
 * Called inside the request's own deadline and cancellation, so the lookup ends with them.
 */
export type ProxyFor = (
  url: string,
  timeoutMs: number,
  signal: AbortSignal,
) => Promise<string | undefined>;

/** Bun's `fetch` reads these itself; a proxy set here keeps priority over the system settings. */
const ENV_PROXY_NAMES = {
  http: [
    "http_proxy",
    "HTTP_PROXY",
  ],
  https: [
    "https_proxy",
    "HTTPS_PROXY",
  ],
} as const;

function hasEnvironmentProxy(scheme: "http" | "https"): boolean {
  return ENV_PROXY_NAMES[scheme].some((name) => Boolean(process.env[name]));
}

/**
 * Choose the proxy for a request from the current user's system settings, the way `resolveProxy`
 * reports them: the first HTTP or HTTPS proxy of the route, or none when the route is direct.
 * WebSocket URLs are looked up as the HTTP URL they upgrade from.
 *
 * - A proxy named by an environment variable wins, and the lookup is skipped.
 * - A route with only SOCKS proxies fails: Bun cannot use one, and connecting directly would
 *   bypass the route the administrator set.
 * - A lookup that times out, is cancelled or exceeds the worker limit fails the request the same
 *   way. A settings read that fails is logged without the address and the request goes direct.
 */
export async function systemProxyFor(
  api: () => WinHttpApi,
  urlText: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<string | undefined> {
  const url = new URL(urlText);
  const secure = url.protocol === "https:" || url.protocol === "wss:";
  if (hasEnvironmentProxy(secure ? "https" : "http")) {
    return undefined;
  }
  url.protocol = secure ? "https:" : "http:";
  let entries: ProxyEntry[];
  try {
    entries = await resolveProxy(api(), url.href, timeoutMs, signal);
  } catch (error) {
    if (
      signal.aborted ||
      (error instanceof BunawayError && error.code !== "INTERNAL")
    ) {
      throw error;
    }
    console.error("System proxy lookup failed; connecting directly.");
    return undefined;
  }
  for (const entry of entries) {
    if (
      entry.kind === "proxy" &&
      (entry.scheme === "http" || entry.scheme === "https")
    ) {
      return `${entry.scheme}://${entry.host}:${entry.port}`;
    }
  }
  if (entries.some((entry) => entry.kind === "proxy")) {
    throw new BunawayError({
      code: "INTERNAL",
      message: "SOCKS proxy is not supported.",
    });
  }
  return undefined;
}
