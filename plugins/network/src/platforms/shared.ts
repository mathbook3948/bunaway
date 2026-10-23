import type { NativeEnvironment } from "@bunaway/plugin";
import { BunawayError } from "@bunaway/protocol";
import type { z } from "zod";
import {
  type downloadIdInputSchema,
  type downloadInputSchema,
  type exchangeInputSchema,
  MAX_ACTIVE_DOWNLOADS,
  MAX_ACTIVE_UPLOADS,
  type requestInputSchema,
  type resolveHostInputSchema,
  type uploadIdInputSchema,
  type uploadInputSchema,
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
import { type UploadEntry, upload } from "#network/platforms/upload";
import { exchange } from "#network/platforms/websocket";

const MAX_ACTIVE_REQUESTS = 16;
type RequestInput = z.output<typeof requestInputSchema>;
type ExchangeInput = z.output<typeof exchangeInputSchema>;
type ResolveHostInput = z.output<typeof resolveHostInputSchema>;
type DownloadInput = z.output<typeof downloadInputSchema>;
type DownloadIdInput = z.output<typeof downloadIdInputSchema>;
type UploadInput = z.output<typeof uploadInputSchema>;
type UploadIdInput = z.output<typeof uploadIdInputSchema>;

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
    /** Running uploads by the id their caller chose; an entry exists until its file is closed. */
    uploads: new Map<string, UploadEntry>(),
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

/** What downloads and uploads share: the owning source, the abort handle and the running task. */
type TransferEntry = {
  readonly source: string;
  readonly controller: AbortController;
  task: Promise<unknown>;
};

type TransferSpec<E extends TransferEntry> = {
  /** Lower case name used in errors, "download" or "upload". */
  noun: string;
  registry: Map<string, E>;
  id: string;
  maxActive: number;
  timeoutMs: number;
  idleTimeoutMs: number;
};

/**
 * Run one transfer under the limits that downloads and uploads share: a caller-chosen id that is
 * free, a cap on transfers in flight, a whole-transfer deadline and a limit on silence that
 * `touch` restarts. The entry stays registered until `execute` has cleaned up after itself, and
 * the connection is always ended.
 */
function runTransfer<E extends TransferEntry, T>(
  spec: TransferSpec<E>,
  requestSignal: AbortSignal | undefined,
  makeEntry: (controller: AbortController) => E,
  execute: (signal: AbortSignal, entry: E, touch: () => void) => Promise<T>,
): Promise<T> {
  const { noun, registry, id } = spec;
  const label = `${noun[0]?.toUpperCase()}${noun.slice(1)}`;
  if (registry.has(id)) {
    throw new BunawayError({
      code: "INVALID_ARGUMENT",
      message: `The ${noun} id is already in use.`,
    });
  }
  if (registry.size >= spec.maxActive) {
    throw new BunawayError({
      code: "BUSY",
      message: `Too many ${noun}s.`,
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
  const deadline = setTimeout(timeout(`${label} timed out.`), spec.timeoutMs);
  let idle = setTimeout(timeout(`${label} stalled.`), spec.idleTimeoutMs);
  const entry = makeEntry(controller);
  const touch = () => {
    clearTimeout(idle);
    idle = setTimeout(timeout(`${label} stalled.`), spec.idleTimeoutMs);
  };
  const task = (async () => {
    try {
      return await execute(signal, entry, touch);
    } catch (error) {
      if (signal.aborted) {
        throw signal.reason instanceof BunawayError
          ? signal.reason
          : new BunawayError({
              code: "CANCELLED",
              message: `${label} was cancelled.`,
            });
      }
      if (error instanceof BunawayError) {
        throw error;
      }
      // The cause stays in the log; the caller only learns that the transfer failed.
      console.error(`${label} failed.`, error);
      throw new BunawayError({
        code: "INTERNAL",
        message: `${label} failed.`,
      });
    } finally {
      clearTimeout(deadline);
      clearTimeout(idle);
      // Ends the connection of a transfer that stopped before its body was read to the end.
      controller.abort();
      registry.delete(id);
    }
  })();
  entry.task = task;
  registry.set(id, entry);
  return task;
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
  return runTransfer(
    {
      noun: "download",
      registry: state.downloads,
      id: input.downloadId,
      maxActive: MAX_ACTIVE_DOWNLOADS,
      timeoutMs: input.timeoutMs,
      idleTimeoutMs: input.idleTimeoutMs,
    },
    requestSignal,
    (controller): DownloadEntry => ({
      source,
      controller,
      task: Promise.resolve(),
      receivedBytes: 0,
      totalBytes: null,
    }),
    (signal, entry, touch) => download(input, signal, entry, touch),
  );
}

/**
 * Send a file as a request body under the same kind of limits as a download: at most four at
 * once, a whole-upload deadline and a limit on the silence between file chunks. The call returns
 * with the server's bounded answer once the file is closed.
 */
export async function runUpload(
  state: ReturnType<typeof initialize>,
  source: string,
  input: UploadInput,
  requestSignal?: AbortSignal,
) {
  requireOpen(state);
  return runTransfer(
    {
      noun: "upload",
      registry: state.uploads,
      id: input.uploadId,
      maxActive: MAX_ACTIVE_UPLOADS,
      timeoutMs: input.timeoutMs,
      idleTimeoutMs: input.idleTimeoutMs,
    },
    requestSignal,
    (controller): UploadEntry => ({
      source,
      controller,
      task: Promise.resolve(),
      sentBytes: 0,
      totalBytes: null,
    }),
    (signal, entry, touch) => upload(input, signal, entry, touch),
  );
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

/** Bytes read so far by a running upload of the same source. */
export function runUploadStatus(
  state: ReturnType<typeof initialize>,
  source: string,
  { uploadId }: UploadIdInput,
) {
  requireOpen(state);
  const entry = state.uploads.get(uploadId);
  if (entry?.source !== source) {
    throw new BunawayError({
      code: "INVALID_ARGUMENT",
      message: "Unknown upload.",
    });
  }
  return {
    sentBytes: entry.sentBytes,
    totalBytes: entry.totalBytes,
  };
}

/** Stop an upload of the same source and wait until its file is closed; unknown or finished ids succeed. */
export async function runCancelUpload(
  state: ReturnType<typeof initialize>,
  source: string,
  { uploadId }: UploadIdInput,
) {
  const entry = state.uploads.get(uploadId);
  if (entry?.source === source) {
    entry.controller.abort(
      new BunawayError({
        code: "CANCELLED",
        message: "Upload was cancelled.",
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
  const transfers = [
    ...state.downloads.values(),
    ...state.uploads.values(),
  ];
  for (const entry of transfers) {
    entry.controller.abort(
      new BunawayError({
        code: "CANCELLED",
        message: "Network adapter is disposed.",
      }),
    );
  }
  await Promise.allSettled([
    ...state.active.values(),
    ...transfers.map((entry) => entry.task),
  ]);
}
