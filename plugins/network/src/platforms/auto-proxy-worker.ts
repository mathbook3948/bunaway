import type { FFIFunction } from "bun:ffi";
import { KERNEL32, pick } from "@bunaway/plugin/win32";
import { BunawayError } from "@bunaway/protocol";

/**
 * WinHTTP symbols the automatic proxy lookup calls. `WinHttpGetProxyForUrl` blocks for as long as
 * address detection and the script download take, so these calls run in a worker thread and the
 * host thread keeps serving requests. The worker declares them from this one table.
 */
export const AUTO_PROXY_SYMBOLS = {
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
} as const satisfies Record<string, FFIFunction>;

/** Most automatic lookups that may hold a worker at once, counting ones whose caller already left but whose native call has not returned. */
export const MAX_AUTO_PROXY_WORKERS = 4;

/**
 * Source of the worker module. It is a string, not a file, because the plugin build bundles one
 * entry point and does not carry a separate worker file. The module is self-contained: it
 * imports only `bun:ffi` and receives the symbol tables below.
 *
 * Protocol: one request `{ url, source, timeoutMs }`, one reply that is `{ found }` with
 * `{ accessType, proxy, bypass }`, `{ error }` with the Win32 error code, or `{ fail }` with a
 * message. The reply never carries pointers: every WinHTTP string is copied and freed before it
 * is sent.
 */
const WORKER_BODY = `
import { dlopen, ptr, read, toArrayBuffer } from "bun:ffi";

const WINHTTP_ACCESS_TYPE_NO_PROXY = 1;
const WINHTTP_AUTOPROXY_AUTO_DETECT = 0x1;
const WINHTTP_AUTOPROXY_CONFIG_URL = 0x2;
// Find the script address with DHCP, then DNS (wpad).
const AUTO_DETECT_DHCP_AND_DNS = 0x3;
// WINHTTP_AUTOPROXY_OPTIONS and WINHTTP_PROXY_INFO on x64.
const AUTOPROXY_OPTIONS_BYTES = 32;
const PROXY_INFO_BYTES = 24;
const MAX_CONFIG_CHARS = 32768;
const ERROR_UNKNOWN = 0xffffffff;

const kernel = dlopen("kernel32.dll", KERNEL_SYMBOLS);
const winhttp = dlopen("winhttp.dll", WINHTTP_SYMBOLS);

function wide(text) {
  return Buffer.concat([Buffer.from(text, "utf16le"), Buffer.alloc(2)]);
}

// Copy and free one WinHTTP-allocated string. Returns undefined when it is too long to accept.
function takeString(address) {
  if (address === 0n) {
    return null;
  }
  const pointer = Number(address);
  try {
    let chars = 0;
    while (read.u16(pointer, chars * 2) !== 0) {
      chars += 1;
      if (chars > MAX_CONFIG_CHARS) {
        return undefined;
      }
    }
    return Buffer.from(toArrayBuffer(pointer, 0, chars * 2)).toString("utf16le");
  } finally {
    kernel.symbols.GlobalFree(pointer);
  }
}

// A failing call leaves a nonzero last error. A zero read means the FFI layer overwrote it; the
// call is not repeated (it may have waited the whole time budget), the error is reported as unknown.
function callError(call) {
  if (call()) {
    return 0;
  }
  const code = kernel.symbols.GetLastError();
  return code === 0 ? ERROR_UNKNOWN : code;
}

function lookup(request) {
  const session = winhttp.symbols.WinHttpOpen(null, WINHTTP_ACCESS_TYPE_NO_PROXY, null, null, 0);
  if (session === 0n) {
    return { fail: "Windows proxy lookup could not start." };
  }
  const options = Buffer.alloc(AUTOPROXY_OPTIONS_BYTES);
  const script = request.source.kind === "script" ? wide(request.source.url) : null;
  if (script) {
    options.writeUInt32LE(WINHTTP_AUTOPROXY_CONFIG_URL, 0);
    options.writeBigUInt64LE(BigInt(ptr(script)), 8);
  } else {
    options.writeUInt32LE(WINHTTP_AUTOPROXY_AUTO_DETECT, 0);
    options.writeUInt32LE(AUTO_DETECT_DHCP_AND_DNS, 4);
  }
  // fAutoLogonIfChallenged stays FALSE (offset 28): no logon credentials are offered to the script host.
  const info = Buffer.alloc(PROXY_INFO_BYTES);
  const target = wide(request.url);
  try {
    // The four timeouts apply one after another, so each gets a quarter of the time left.
    const phaseMs = Math.max(1, Math.floor(request.timeoutMs / 4));
    if (!winhttp.symbols.WinHttpSetTimeouts(session, phaseMs, phaseMs, phaseMs, phaseMs)) {
      return { fail: "Windows proxy lookup timeouts could not be set." };
    }
    const error = callError(() =>
      winhttp.symbols.WinHttpGetProxyForUrl(session, ptr(target), ptr(options), ptr(info)),
    );
    // Free both strings even when the call failed.
    const proxy = takeString(info.readBigUInt64LE(8));
    const bypass = takeString(info.readBigUInt64LE(16));
    if (error !== 0) {
      return { error };
    }
    if (proxy === undefined || bypass === undefined) {
      return { fail: "Windows proxy setting is too long." };
    }
    return { found: { accessType: info.readUInt32LE(0), proxy, bypass } };
  } finally {
    winhttp.symbols.WinHttpCloseHandle(session);
    // The native call only saw these buffers' addresses: keep them reachable until it returned.
    script?.fill(0, 0, 0);
    target.fill(0, 0, 0);
    options.fill(0, 0, 0);
  }
}

self.onmessage = (event) => {
  let reply;
  try {
    reply = lookup(event.data);
  } catch {
    reply = { fail: "Windows proxy lookup failed." };
  }
  postMessage(reply);
  kernel.close();
  winhttp.close();
};
`;

/** The complete worker module, with the shared symbol tables inlined as JSON. */
export const AUTO_PROXY_WORKER_SOURCE = `const KERNEL_SYMBOLS = ${JSON.stringify(
  pick(KERNEL32, "GetLastError", "GlobalFree"),
)};
const WINHTTP_SYMBOLS = ${JSON.stringify(AUTO_PROXY_SYMBOLS)};
${WORKER_BODY}`;

/** Start a worker from module source; the seam lets tests run any source. */
export function startWorker(source: string): {
  worker: Worker;
  release(): void;
} {
  const url = URL.createObjectURL(
    new Blob(
      [
        source,
      ],
      {
        type: "text/javascript",
      },
    ),
  );
  return {
    worker: new Worker(url),
    release: () => URL.revokeObjectURL(url),
  };
}

/**
 * Send one request to a fresh worker running `source` and wait for its one reply.
 *
 * The caller leaves at once on abort, a worker error or the reply. An aborted worker is not
 * terminated: it may be inside a native call, and stopping its thread there would skip the
 * cleanup that follows the call. It keeps its slot in `workers` until it replies (the native call
 * has returned and its handles are closed) or fails, and only then is terminated. At `limit` a
 * request is refused with `BUSY`, so slow lookups cannot pile up. The owner terminates whatever
 * remains on dispose.
 */
export async function requestFromWorker(
  options: {
    source: string;
    request: unknown;
    signal: AbortSignal;
    workers: Set<Worker>;
    limit: number;
  },
  start: typeof startWorker = startWorker,
): Promise<unknown> {
  const { source, request, signal, workers, limit } = options;
  signal.throwIfAborted();
  if (workers.size >= limit) {
    throw new BunawayError({
      code: "BUSY",
      message: "Too many proxy lookups.",
    });
  }
  const { worker, release } = start(source);
  workers.add(worker);
  return new Promise((resolve, reject) => {
    let settled = false;
    let done = false;
    const settle = (action: () => void) => {
      if (!settled) {
        settled = true;
        signal.removeEventListener("abort", onAbort);
        action();
      }
    };
    // The worker has no native call in flight any more: free its slot and thread.
    const retire = () => {
      if (!done) {
        done = true;
        release();
        workers.delete(worker);
        void worker.terminate();
      }
    };
    const fail = () => {
      settle(() =>
        reject(
          new BunawayError({
            code: "INTERNAL",
            message: "Windows proxy lookup failed.",
          }),
        ),
      );
      retire();
    };
    const onAbort = () => settle(() => reject(signal.reason));
    signal.addEventListener("abort", onAbort, {
      once: true,
    });
    worker.onmessage = (event: MessageEvent) => {
      settle(() => resolve(event.data));
      retire();
    };
    worker.onerror = fail;
    worker.onmessageerror = fail;
    worker.addEventListener("close", fail);
    worker.postMessage(request);
  });
}
