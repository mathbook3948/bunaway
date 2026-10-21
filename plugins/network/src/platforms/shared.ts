import type { NativeEnvironment } from "@bunaway/plugin";
import { BunawayError } from "@bunaway/protocol";
import type { z } from "zod";
import {
  type downloadIdInputSchema,
  type downloadInputSchema,
  type exchangeInputSchema,
  MAX_ACTIVE_DOWNLOADS,
  type requestInputSchema,
  type resolveHostInputSchema,
} from "#network/contract";
import { type DownloadEntry, download } from "#network/platforms/download";
import { request } from "#network/platforms/http";
import {
  hasActiveConnection,
  type OnlineWatchHost,
  startIntervalPolling,
  watchOnline,
} from "#network/platforms/online-state";
import {
  type HostLookup,
  resolveHost,
  systemLookup,
} from "#network/platforms/resolve-host";
import { exchange } from "#network/platforms/websocket";

const MAX_ACTIVE_REQUESTS = 16;
type RequestInput = z.output<typeof requestInputSchema>;
type ExchangeInput = z.output<typeof exchangeInputSchema>;
type ResolveHostInput = z.output<typeof resolveHostInputSchema>;
type DownloadInput = z.output<typeof downloadInputSchema>;
type DownloadIdInput = z.output<typeof downloadIdInputSchema>;

/**
 * Own cancellable requests on the selected host thread. Hosts with system event services also
 * get `network.onlineChanged`; the watcher stops when the adapter is disposed.
 */
export function initialize(
  environment?: NativeEnvironment,
  seams: Pick<OnlineWatchHost, "read" | "startPolling"> = {
    read: hasActiveConnection,
    startPolling: startIntervalPolling,
  },
) {
  const systemEvents = environment?.windows?.systemEvents;
  return {
    active: new Map<AbortController, Promise<unknown>>(),
    /** Started host lookups, including ones whose caller already left; getaddrinfo cannot be interrupted. */
    lookups: new Set<Promise<unknown>>(),
    /** Running downloads by the id their caller chose; an entry exists until its temporary file is gone. */
    downloads: new Map<string, DownloadEntry>(),
    disposed: false,
    stopOnlineWatch: systemEvents
      ? watchOnline({
          ...seams,
          publish: (online) =>
            systemEvents.publish(
              "network.onlineChanged",
              {
                online,
              },
              "network.isOnline",
            ),
          fail: (error) => console.error("Online state check failed.", error),
        })
      : undefined,
  };
}

/** Current connection state; fails after disposal like the other operations. */
export function runIsOnline(state: ReturnType<typeof initialize>): boolean {
  if (state.disposed) {
    throw new BunawayError({
      code: "CANCELLED",
      message: "Network adapter is disposed.",
    });
  }
  try {
    return hasActiveConnection();
  } catch {
    throw new BunawayError({
      code: "INTERNAL",
      message: "Online state could not be read.",
    });
  }
}

/** Apply one limit, deadline and cleanup path to HTTP and WebSocket work. */
export async function run<T>(
  state: ReturnType<typeof initialize>,
  timeoutMs: number,
  requestSignal: AbortSignal | undefined,
  execute: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (state.disposed) {
    throw new BunawayError({
      code: "CANCELLED",
      message: "Network adapter is disposed.",
    });
  }
  if (state.active.size >= MAX_ACTIVE_REQUESTS) {
    throw new BunawayError({
      code: "BUSY",
      message: "Too many network requests.",
    });
  }
  requestSignal?.throwIfAborted();
  const controller = new AbortController();
  const signal = AbortSignal.any([
    controller.signal,
    ...(requestSignal
      ? [
          requestSignal,
        ]
      : []),
  ]);
  const timer = setTimeout(
    () =>
      controller.abort(
        new BunawayError({
          code: "TIMEOUT",
          message: "Network request timed out.",
        }),
      ),
    timeoutMs,
  );
  const task = execute(signal);
  state.active.set(controller, task);
  try {
    return await task;
  } catch (error) {
    if (signal.aborted) {
      throw signal.reason instanceof BunawayError
        ? signal.reason
        : new BunawayError({
            code: "CANCELLED",
            message: "Network request was cancelled.",
          });
    }
    if (error instanceof BunawayError) {
      throw error;
    }
    throw new BunawayError({
      code: "INTERNAL",
      message: "Network request failed.",
    });
  } finally {
    clearTimeout(timer);
    state.active.delete(controller);
  }
}

export function runRequest(
  state: ReturnType<typeof initialize>,
  input: RequestInput,
  signal?: AbortSignal,
) {
  return run(state, input.timeoutMs, signal, (activeSignal) =>
    request(input, activeSignal),
  );
}

export function runExchange(
  state: ReturnType<typeof initialize>,
  input: ExchangeInput,
  signal?: AbortSignal,
) {
  return run(state, input.timeoutMs, signal, (activeSignal) =>
    exchange(input, activeSignal),
  );
}

/** Resolve a host name with the system resolver under the shared request limit and deadline; at most 16 lookups run at once. */
export function runResolveHost(
  state: ReturnType<typeof initialize>,
  input: ResolveHostInput,
  signal?: AbortSignal,
  find: HostLookup = systemLookup,
) {
  return run(state, input.timeoutMs, signal, async (activeSignal) => {
    // A cancelled or timed-out call frees its request slot while its lookup keeps running, so the
    // running lookups carry their own limit to keep slow resolvers from queueing without bound.
    if (state.lookups.size >= MAX_ACTIVE_REQUESTS) {
      throw new BunawayError({
        code: "BUSY",
        message: "Too many host lookups.",
      });
    }
    return resolveHost(
      input.host,
      activeSignal,
      (host, family) => {
        const lookup = find(host, family);
        state.lookups.add(lookup);
        const release = () => state.lookups.delete(lookup);
        lookup.then(release, release);
        return lookup;
      },
      input.queryType,
    );
  });
}

function requireOpen(state: ReturnType<typeof initialize>) {
  if (state.disposed) {
    throw new BunawayError({
      code: "CANCELLED",
      message: "Network adapter is disposed.",
    });
  }
}

/** A download belongs to the source that started it; another source sees the same error as for an unknown id. */
function findDownload(
  state: ReturnType<typeof initialize>,
  source: string,
  downloadId: string,
) {
  const entry = state.downloads.get(downloadId);
  return entry?.source === source ? entry : undefined;
}

/**
 * Save a response body to a file under its own limits: at most four at once, a whole-download
 * deadline and a limit on the silence between body chunks. The call returns when the file is in
 * place or the download has failed and its temporary file is gone.
 */
export async function runDownload(
  state: ReturnType<typeof initialize>,
  source: string,
  input: DownloadInput,
  requestSignal?: AbortSignal,
) {
  requireOpen(state);
  if (state.downloads.size >= MAX_ACTIVE_DOWNLOADS) {
    throw new BunawayError({
      code: "BUSY",
      message: "Too many downloads.",
    });
  }
  if (state.downloads.has(input.downloadId)) {
    throw new BunawayError({
      code: "INVALID_ARGUMENT",
      message: "The download id is already in use.",
    });
  }
  requestSignal?.throwIfAborted();
  const controller = new AbortController();
  const signal = AbortSignal.any([
    controller.signal,
    ...(requestSignal
      ? [
          requestSignal,
        ]
      : []),
  ]);
  const timeout = (message: string) => () =>
    controller.abort(
      new BunawayError({
        code: "TIMEOUT",
        message,
      }),
    );
  const deadline = setTimeout(timeout("Download timed out."), input.timeoutMs);
  let idle = setTimeout(timeout("Download stalled."), input.idleTimeoutMs);
  const entry: DownloadEntry = {
    source,
    controller,
    task: Promise.resolve(),
    receivedBytes: 0,
    totalBytes: null,
  };
  const touch = () => {
    clearTimeout(idle);
    idle = setTimeout(timeout("Download stalled."), input.idleTimeoutMs);
  };
  const task = (async () => {
    try {
      return await download(input, signal, entry, touch);
    } catch (error) {
      if (signal.aborted) {
        throw signal.reason instanceof BunawayError
          ? signal.reason
          : new BunawayError({
              code: "CANCELLED",
              message: "Download was cancelled.",
            });
      }
      if (error instanceof BunawayError) {
        throw error;
      }
      // The cause stays in the log; the caller only learns that the download failed.
      console.error("Download failed.", error);
      throw new BunawayError({
        code: "INTERNAL",
        message: "Download failed.",
      });
    } finally {
      clearTimeout(deadline);
      clearTimeout(idle);
      // Ends the connection of a download that stopped before its body was read to the end.
      controller.abort();
      state.downloads.delete(input.downloadId);
    }
  })();
  entry.task = task;
  state.downloads.set(input.downloadId, entry);
  return task;
}

/** Bytes received so far by a running download of the same source. */
export function runDownloadStatus(
  state: ReturnType<typeof initialize>,
  source: string,
  { downloadId }: DownloadIdInput,
) {
  requireOpen(state);
  const entry = findDownload(state, source, downloadId);
  if (!entry) {
    throw new BunawayError({
      code: "INVALID_ARGUMENT",
      message: "Unknown download.",
    });
  }
  return {
    receivedBytes: entry.receivedBytes,
    totalBytes: entry.totalBytes,
  };
}

/** Stop a download of the same source and wait until its temporary file is removed; unknown or finished ids succeed. */
export async function runCancelDownload(
  state: ReturnType<typeof initialize>,
  source: string,
  { downloadId }: DownloadIdInput,
) {
  const entry = findDownload(state, source, downloadId);
  if (entry) {
    entry.controller.abort(
      new BunawayError({
        code: "CANCELLED",
        message: "Download was cancelled.",
      }),
    );
    await Promise.allSettled([
      entry.task,
    ]);
  }
  return {};
}

/** Cancel and drain all in-flight work; repeated cleanup is safe. */
export async function dispose(state: ReturnType<typeof initialize>) {
  if (!state.disposed) {
    state.disposed = true;
    state.stopOnlineWatch?.();
    for (const controller of state.active.keys()) {
      controller.abort(
        new BunawayError({
          code: "CANCELLED",
          message: "Network adapter is disposed.",
        }),
      );
    }
  }
  for (const entry of state.downloads.values()) {
    entry.controller.abort(
      new BunawayError({
        code: "CANCELLED",
        message: "Network adapter is disposed.",
      }),
    );
  }
  await Promise.allSettled([
    ...state.active.values(),
    ...[
      ...state.downloads.values(),
    ].map((entry) => entry.task),
  ]);
}
