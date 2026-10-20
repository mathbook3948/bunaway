import { dlopen, type Pointer, ptr, read, toArrayBuffer } from "bun:ffi";
import { KERNEL32, pick, wide, win32CallError } from "@bunaway/plugin/win32";
import { BunawayError } from "@bunaway/protocol";
import {
  isImplicitDirect,
  type ProxyEntry,
  selectEntries,
} from "#network/platforms/proxy-rules";

const WINHTTP_ACCESS_TYPE_NO_PROXY = 1;
const WINHTTP_ACCESS_TYPE_NAMED_PROXY = 3;
const WINHTTP_AUTOPROXY_AUTO_DETECT = 0x1;
const WINHTTP_AUTOPROXY_CONFIG_URL = 0x2;
/** Find the script address with DHCP, then DNS (`wpad`). */
const WINHTTP_AUTO_DETECT_TYPE_DHCP = 0x1;
const WINHTTP_AUTO_DETECT_TYPE_DNS_A = 0x2;
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_WINHTTP_INVALID_URL = 12005;
const ERROR_WINHTTP_UNRECOGNIZED_SCHEME = 12006;
/** `WINHTTP_CURRENT_USER_IE_PROXY_CONFIG` on x64: BOOL, padding, then three string pointers. */
const IE_PROXY_CONFIG_BYTES = 32;
/** `WINHTTP_AUTOPROXY_OPTIONS` on x64. */
const AUTOPROXY_OPTIONS_BYTES = 32;
/** `WINHTTP_PROXY_INFO` on x64: access type, padding, then two string pointers. */
const PROXY_INFO_BYTES = 24;
/** Upper bound on a configuration string read from WinHTTP, in UTF-16 units. */
const MAX_CONFIG_CHARS = 32768;
/** Longest wait for the script download and the name lookups that WinHTTP makes for one call. */
const MAX_AUTO_PROXY_STEP_MS = 5000;

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
  ): AutoProxyResult | number;
}

function failure(message: string): never {
  throw new BunawayError({
    code: "INTERNAL",
    message,
  });
}

/** Open winhttp.dll with the shared kernel32 memory calls; the caller closes both. */
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
      WinHttpOpen: {
        args: [
          "ptr",
          "u32",
          "ptr",
          "ptr",
          "u32",
        ],
        returns: "u64",
      },
      WinHttpSetTimeouts: {
        args: [
          "u64",
          "i32",
          "i32",
          "i32",
          "i32",
        ],
        returns: "i32",
      },
      WinHttpGetProxyForUrl: {
        args: [
          "u64",
          "ptr",
          "ptr",
          "ptr",
        ],
        returns: "i32",
      },
      WinHttpCloseHandle: {
        args: [
          "u64",
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

/** Adapt the loaded WinHTTP symbols to the narrow interface above. */
export function winHttpApi(
  libraries: ReturnType<typeof openWinHttp>,
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
    autoProxyForUrl(url, source, timeoutMs) {
      const session = winhttp.symbols.WinHttpOpen(
        null,
        WINHTTP_ACCESS_TYPE_NO_PROXY,
        null,
        null,
        0,
      );
      if (session === 0n) {
        return failure("Windows proxy lookup could not start.");
      }
      const options = Buffer.alloc(AUTOPROXY_OPTIONS_BYTES);
      const script = source.kind === "script" ? wide(source.url) : null;
      if (script) {
        options.writeUInt32LE(WINHTTP_AUTOPROXY_CONFIG_URL, 0);
        options.writeBigUInt64LE(BigInt(ptr(script)), 8);
      } else {
        options.writeUInt32LE(WINHTTP_AUTOPROXY_AUTO_DETECT, 0);
        options.writeUInt32LE(
          WINHTTP_AUTO_DETECT_TYPE_DHCP | WINHTTP_AUTO_DETECT_TYPE_DNS_A,
          4,
        );
      }
      // fAutoLogonIfChallenged stays FALSE (offset 28): no logon credentials are offered to the script host.
      const info = Buffer.alloc(PROXY_INFO_BYTES);
      const target = wide(url);
      try {
        const step = Math.min(timeoutMs, MAX_AUTO_PROXY_STEP_MS);
        winhttp.symbols.WinHttpSetTimeouts(session, step, step, step, step);
        const error = win32CallError(
          () =>
            winhttp.symbols.WinHttpGetProxyForUrl(
              session,
              ptr(target),
              ptr(options),
              ptr(info),
            ),
          lastError,
        );
        const [proxy = null, bypass = null] = takeStrings(
          libraries,
          [
            8,
            16,
          ].map((offset) => info.readBigUInt64LE(offset)),
        );
        return error === 0
          ? {
              accessType: info.readUInt32LE(0),
              proxy,
              bypass,
            }
          : error;
      } finally {
        winhttp.symbols.WinHttpCloseHandle(session);
      }
    },
  };
}

/** Errors that mean the request itself was wrong, not that automatic configuration is unavailable. */
function isRequestError(error: number): boolean {
  return (
    error === ERROR_INVALID_PARAMETER ||
    error === ERROR_WINHTTP_INVALID_URL ||
    error === ERROR_WINHTTP_UNRECOGNIZED_SCHEME
  );
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
 * WinHTTP answers synchronously and cannot be cancelled, so cancellation and the deadline are
 * checked between steps; each automatic step is bounded by the time left of the deadline (at most
 * `MAX_AUTO_PROXY_STEP_MS`). Settings that need no script are answered without a WinHTTP session.
 */
export function resolveProxy(
  api: WinHttpApi,
  urlText: string,
  timeoutMs: number,
  signal: AbortSignal,
  now: () => number = Date.now,
): ProxyEntry[] {
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
    // The native call cannot be interrupted, so the deadline is spent across the steps instead.
    const remaining = timeoutMs - (now() - startedAt);
    if (remaining <= 0) {
      throw new BunawayError({
        code: "TIMEOUT",
        message: "Network request timed out.",
      });
    }
    const found = api.autoProxyForUrl(scriptUrl(url), source, remaining);
    if (typeof found === "number") {
      if (isRequestError(found)) {
        return failure("Windows proxy lookup rejected the URL.");
      }
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
