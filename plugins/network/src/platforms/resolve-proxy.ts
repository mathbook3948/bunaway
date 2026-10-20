import { dlopen, type Pointer, ptr, read, toArrayBuffer } from "bun:ffi";
import { KERNEL32, pick, win32CallError } from "@bunaway/plugin/win32";
import { BunawayError, isRecord } from "@bunaway/protocol";
import {
  AUTO_PROXY_WORKER_SOURCE,
  MAX_AUTO_PROXY_WORKERS,
  requestFromWorker,
} from "#network/platforms/auto-proxy-worker";
import {
  isImplicitDirect,
  type ProxyEntry,
  selectEntries,
} from "#network/platforms/proxy-rules";

const WINHTTP_ACCESS_TYPE_NAMED_PROXY = 3;
const ERROR_FILE_NOT_FOUND = 2;
/** `WINHTTP_CURRENT_USER_IE_PROXY_CONFIG` on x64: BOOL, padding, then three string pointers. */
const IE_PROXY_CONFIG_BYTES = 32;
/** Upper bound on a configuration string read from WinHTTP, in UTF-16 units. */
const MAX_CONFIG_CHARS = 32768;

/** The system proxy settings of the current user, as WinHTTP reads them from Internet Options. */
export type IeProxyConfig = {
  autoDetect: boolean;
  autoConfigUrl: string | null;
  proxy: string | null;
  bypass: string | null;
};
/** What automatic configuration chose for one URL. */
export type AutoProxyResult = {
  accessType: number;
  proxy: string | null;
  bypass: string | null;
};
export type AutoProxySource =
  | {
      kind: "detect";
    }
  | {
      kind: "script";
      url: string;
    };

/** The native calls the lookup needs, so the decision logic runs without WinHTTP. */
export interface WinHttpApi {
  /** Internet Options proxy settings; null when the user has none. */
  ieProxyConfig(): IeProxyConfig | null;
  /** Automatic proxy configuration for a URL: the result, or the Win32 error that ended the attempt. */
  autoProxyForUrl(
    url: string,
    source: AutoProxySource,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<AutoProxyResult | number>;
}

function failure(message: string): never {
  throw new BunawayError({
    code: "INTERNAL",
    message,
  });
}

/** Open winhttp.dll for the settings read, with the shared kernel32 memory calls; the caller closes both. */
export function openWinHttp() {
  const kernel = dlopen("kernel32.dll", {
    ...pick(KERNEL32, "GetLastError", "GlobalFree"),
  });
  try {
    const winhttp = dlopen("winhttp.dll", {
      WinHttpGetIEProxyConfigForCurrentUser: {
        args: [
          "ptr",
        ],
        returns: "i32",
      },
    });
    return {
      kernel,
      winhttp,
    };
  } catch (error) {
    kernel.close();
    throw error;
  }
}

/** Read and free one WinHTTP-allocated UTF-16 string; null for a null pointer. */
function takeString(
  libraries: ReturnType<typeof openWinHttp>,
  address: bigint,
): string | null {
  if (address === 0n) {
    return null;
  }
  const pointer = Number(address) as Pointer;
  try {
    let chars = 0;
    while (read.u16(pointer, chars * 2) !== 0) {
      chars += 1;
      if (chars > MAX_CONFIG_CHARS) {
        return failure("Windows proxy setting is too long.");
      }
    }
    return Buffer.from(toArrayBuffer(pointer, 0, chars * 2)).toString(
      "utf16le",
    );
  } finally {
    libraries.kernel.symbols.GlobalFree(pointer);
  }
}

/** Take several strings so a failure on one still frees the others. */
function takeStrings(
  libraries: ReturnType<typeof openWinHttp>,
  addresses: bigint[],
): (string | null)[] {
  let failed: unknown;
  const strings = addresses.map((address) => {
    try {
      return takeString(libraries, address);
    } catch (error) {
      failed = error;
      return null;
    }
  });
  if (failed) {
    throw failed;
  }
  return strings;
}

/** The worker's reply as a result or a Win32 error code; anything else is a failed lookup. */
function parseReply(reply: unknown): AutoProxyResult | number {
  if (isRecord(reply)) {
    if (typeof reply.error === "number") {
      return reply.error;
    }
    const found = reply.found;
    if (
      isRecord(found) &&
      typeof found.accessType === "number" &&
      (found.proxy === null || typeof found.proxy === "string") &&
      (found.bypass === null || typeof found.bypass === "string")
    ) {
      return {
        accessType: found.accessType,
        proxy: found.proxy,
        bypass: found.bypass,
      };
    }
  }
  return failure("Windows proxy lookup failed.");
}

/** Adapt the loaded WinHTTP symbols and the lookup workers to the narrow interface above. */
export function winHttpApi(
  libraries: ReturnType<typeof openWinHttp>,
  workers: Set<Worker>,
): WinHttpApi {
  const { winhttp, kernel } = libraries;
  const lastError = () => kernel.symbols.GetLastError();
  return {
    ieProxyConfig() {
      const config = Buffer.alloc(IE_PROXY_CONFIG_BYTES);
      const error = win32CallError(
        () =>
          winhttp.symbols.WinHttpGetIEProxyConfigForCurrentUser(ptr(config)),
        lastError,
      );
      // The strings are allocated even when the caller only wants some of them: read and free all.
      const [autoConfigUrl = null, proxy = null, bypass = null] = takeStrings(
        libraries,
        [
          8,
          16,
          24,
        ].map((offset) => config.readBigUInt64LE(offset)),
      );
      if (error === ERROR_FILE_NOT_FOUND) {
        return null;
      }
      if (error !== 0) {
        return failure("Windows proxy settings could not be read.");
      }
      return {
        autoDetect: config.readUInt32LE(0) !== 0,
        autoConfigUrl,
        proxy,
        bypass,
      };
    },
    async autoProxyForUrl(url, source, timeoutMs, signal) {
      // The blocking WinHTTP calls run in a worker; see `AUTO_PROXY_SYMBOLS`.
      const reply = await requestFromWorker({
        source: AUTO_PROXY_WORKER_SOURCE,
        request: {
          url,
          source,
          timeoutMs,
        },
        signal,
        workers,
        limit: MAX_AUTO_PROXY_WORKERS,
      });
      return parseReply(reply);
    },
  };
}

/** The URL as a proxy script sees it: no user information or fragment, and for https only the origin. */
function scriptUrl(url: URL): string {
  return url.protocol === "https:"
    ? `${url.origin}/`
    : `${url.origin}${url.pathname}${url.search}`;
}

/**
 * The route the system would use for `urlText`, from the current user's Internet Options as
 * WinHTTP reads them, in the order Windows applies: loopback and link-local hosts go direct,
 * automatic detection, the configured script, then the manual proxy list with its bypass list.
 * A script that cannot be found or run falls through to the next source, like browsers do. Proxy
 * credentials are not read or returned, and the script lookup does not log on with the user's
 * credentials.
 *
 * The blocking WinHTTP calls run in a worker, so the host thread keeps serving other work while
 * a lookup waits. Aborting the signal (cancellation or the deadline) ends the wait at once and
 * the worker is terminated; the native call it may still be inside finishes on its own. Each
 * automatic step gets the time left of the deadline. Settings that need no script are answered
 * from the settings read alone, without a worker.
 */
export async function resolveProxy(
  api: WinHttpApi,
  urlText: string,
  timeoutMs: number,
  signal: AbortSignal,
  now: () => number = Date.now,
): Promise<ProxyEntry[]> {
  const url = new URL(urlText);
  const startedAt = now();
  signal.throwIfAborted();
  if (isImplicitDirect(url.hostname)) {
    return [
      {
        kind: "direct",
      },
    ];
  }
  const config = api.ieProxyConfig();
  if (!config) {
    return [
      {
        kind: "direct",
      },
    ];
  }
  const sources: AutoProxySource[] = [];
  if (config.autoDetect) {
    sources.push({
      kind: "detect",
    });
  }
  if (config.autoConfigUrl) {
    sources.push({
      kind: "script",
      url: config.autoConfigUrl,
    });
  }
  for (const source of sources) {
    signal.throwIfAborted();
    const remaining = timeoutMs - (now() - startedAt);
    if (remaining <= 0) {
      throw new BunawayError({
        code: "TIMEOUT",
        message: "Network request timed out.",
      });
    }
    const found = await api.autoProxyForUrl(
      scriptUrl(url),
      source,
      remaining,
      signal,
    );
    // A source that fails, such as an unreachable or malformed script address, falls through to
    // the next one.
    if (typeof found === "number") {
      continue;
    }
    if (found.accessType === WINHTTP_ACCESS_TYPE_NAMED_PROXY) {
      return selectEntries(found.proxy, found.bypass, url);
    }
    return [
      {
        kind: "direct",
      },
    ];
  }
  signal.throwIfAborted();
  return selectEntries(config.proxy, config.bypass, url);
}
