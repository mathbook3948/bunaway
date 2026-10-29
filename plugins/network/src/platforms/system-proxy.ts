import { BunawayError } from "@bunaway/protocol";
import { MAX_AUTO_PROXY_WORKERS } from "#network/platforms/auto-proxy-worker";
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
 * Lets at most `limit` lookups run at once and makes the others wait for a turn, so a burst of
 * requests under automatic detection queues behind the worker limit instead of failing with
 * `BUSY`. A waiting caller leaves when its signal aborts (cancellation or the request deadline).
 */
export class LookupGate {
  private running = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly limit: number = MAX_AUTO_PROXY_WORKERS) {}

  async run<T>(signal: AbortSignal, task: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    if (this.running < this.limit) {
      this.running += 1;
    } else {
      // The slot is handed over by the caller that finishes, so the count stays as it is.
      await this.waitForTurn(signal);
    }
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next) {
        next();
      } else {
        this.running -= 1;
      }
    }
  }

  private waitForTurn(signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const turn = () => {
        signal.removeEventListener("abort", leave);
        resolve();
      };
      const leave = () => {
        this.waiting.splice(this.waiting.indexOf(turn), 1);
        reject(signal.reason);
      };
      this.waiting.push(turn);
      signal.addEventListener("abort", leave, {
        once: true,
      });
    });
  }
}

/**
 * Choose the proxy for a request from the current user's system settings, the way `resolveProxy`
 * reports them: the first HTTP or HTTPS proxy of the route, or none when the route is direct.
 * WebSocket URLs are looked up as the HTTP URL they upgrade from.
 *
 * - A proxy named by an environment variable wins, and the lookup is skipped.
 * - A route with only SOCKS proxies fails: Bun cannot use one, and connecting directly would
 *   bypass the route the administrator set.
 * - Lookups beyond the worker limit wait for a turn within the request's own deadline.
 * - A settings read that fails is logged without the address and the request goes direct. Any
 *   other failure (timeout, cancellation, a list with credentials, a broken worker) fails the
 *   request.
 */
export async function systemProxyFor(
  api: () => WinHttpApi,
  urlText: string,
  timeoutMs: number,
  signal: AbortSignal,
  gate?: LookupGate,
): Promise<string | undefined> {
  const url = new URL(urlText);
  const secure = url.protocol === "https:" || url.protocol === "wss:";
  if (hasEnvironmentProxy(secure ? "https" : "http")) {
    return undefined;
  }
  url.protocol = secure ? "https:" : "http:";
  let entries: ProxyEntry[];
  // Only a failure to read the settings goes direct. Every other failure, such as a list the
  // plugin refuses or a broken lookup worker, fails the request instead of bypassing the route.
  let unreadable = false;
  const lookup = async () => {
    let native: WinHttpApi;
    try {
      native = api();
    } catch (error) {
      unreadable = true;
      throw error;
    }
    const guarded: WinHttpApi = {
      ieProxyConfig: () => {
        try {
          return native.ieProxyConfig();
        } catch (error) {
          unreadable = true;
          throw error;
        }
      },
      autoProxyForUrl: (...args) => native.autoProxyForUrl(...args),
    };
    return resolveProxy(guarded, url.href, timeoutMs, signal);
  };
  try {
    entries = await (gate ? gate.run(signal, lookup) : lookup());
  } catch (error) {
    if (!unreadable || signal.aborted) {
      throw error;
    }
    console.error(
      "System proxy settings could not be read; connecting directly.",
    );
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
