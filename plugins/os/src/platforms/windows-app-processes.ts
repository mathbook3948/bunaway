import { dlopen, ptr } from "bun:ffi";
import { failWithCleanup } from "@bunaway/plugin";
import { KERNEL32, pick } from "@bunaway/plugin/win32";
import { BunawayError } from "@bunaway/protocol";
import { MAX_APP_PROCESSES, type OSAppProcess } from "#os/contract";

/** `TH32CS_SNAPPROCESS`: the snapshot lists processes only. */
const TH32CS_SNAPPROCESS = 0x2;
/** `PROCESS_QUERY_LIMITED_INFORMATION`: enough for GetProcessTimes and K32GetProcessMemoryInfo, and it opens protected processes too. */
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
/** `ERROR_NO_MORE_FILES`: Process32NextW found no further entry. */
const ERROR_NO_MORE_FILES = 18;
const INVALID_HANDLE_VALUE = 0xffffffffffffffffn;
/** Most entries one snapshot walk reads; a larger system list is an error instead of an endless loop. */
export const MAX_SNAPSHOT_ENTRIES = 65536;
/** Image name WebView2 runs its browser, renderer, GPU and utility processes from. */
const WEBVIEW2_IMAGE = "msedgewebview2.exe";

/** `PROCESSENTRY32W` on 64-bit Windows: eight DWORD-sized fields around a ULONG_PTR, then WCHAR[260]. */
export const PROCESSENTRY32W_BYTES = 568;
export const ENTRY_PID_OFFSET = 8;
export const ENTRY_PARENT_PID_OFFSET = 32;
export const ENTRY_IMAGE_OFFSET = 44;
const ENTRY_IMAGE_CHARS = 260;
/** `PROCESS_MEMORY_COUNTERS`: cb, PageFaultCount, then SIZE_T fields; WorkingSetSize is the third. */
export const PROCESS_MEMORY_COUNTERS_BYTES = 72;
export const COUNTERS_WORKING_SET_OFFSET = 16;
/** FILETIME counts 100 ns units. */
const FILETIME_UNITS_PER_MICROSECOND = 10n;

/** One row of the process snapshot. The image name only classifies a process; it is never returned. */
export interface ProcessEntry {
  pid: number;
  parentPid: number;
  image: string;
}

/** What GetProcessTimes and K32GetProcessMemoryInfo report for one opened process. */
export interface ProcessMetrics {
  /** FILETIME the process was created at; separates a live parent from a reused process ID. */
  creationTime: bigint;
  workingSetBytes: number;
  userMicros: number;
  systemMicros: number;
}

/** The two system queries the process tree needs, so the tree logic runs against fakes on any platform. */
export interface AppProcessBindings {
  /** Every process of the system at one instant. */
  snapshot(): ProcessEntry[];
  /** Metrics of one process, or null when the process cannot be opened for limited queries (or has ended). */
  metrics(pid: number): ProcessMetrics | null;
}

function failure(message: string): never {
  throw new BunawayError({
    code: "INTERNAL",
    message,
  });
}

/** Open kernel32.dll for process snapshots and metrics; the caller owns the library and closes it on dispose. */
export function openAppProcessApi() {
  return dlopen("kernel32.dll", {
    ...pick(KERNEL32, "CloseHandle", "GetLastError", "OpenProcess"),
    CreateToolhelp32Snapshot: {
      args: [
        "u32",
        "u32",
      ],
      returns: "u64",
    },
    Process32FirstW: {
      args: [
        "u64",
        "ptr",
      ],
      returns: "i32",
    },
    Process32NextW: {
      args: [
        "u64",
        "ptr",
      ],
      returns: "i32",
    },
    GetProcessTimes: {
      args: [
        "u64",
        "ptr",
        "ptr",
        "ptr",
        "ptr",
      ],
      returns: "i32",
    },
    K32GetProcessMemoryInfo: {
      args: [
        "u64",
        "ptr",
        "u32",
      ],
      returns: "i32",
    },
  });
}

/** Run `use` on an owned handle and close it exactly once; a failed close is an error unless `use` already failed. */
export function withHandle<T>(
  closeHandle: (handle: bigint) => number,
  handle: bigint,
  use: (handle: bigint) => T,
): T {
  const close = () => {
    if (!closeHandle(handle)) {
      failure("Windows process handle could not be closed.");
    }
  };
  let result: T;
  try {
    result = use(handle);
  } catch (error) {
    return failWithCleanup(error, close, "Windows process query failed.");
  }
  close();
  return result;
}

/** Decode one `PROCESSENTRY32W`; an image name without a terminator is malformed. */
export function parseProcessEntry(entry: Buffer): ProcessEntry {
  let chars = 0;
  while (
    chars < ENTRY_IMAGE_CHARS &&
    entry.readUInt16LE(ENTRY_IMAGE_OFFSET + chars * 2) !== 0
  ) {
    chars += 1;
  }
  if (chars === ENTRY_IMAGE_CHARS) {
    failure("Windows process entry is malformed.");
  }
  return {
    pid: entry.readUInt32LE(ENTRY_PID_OFFSET),
    parentPid: entry.readUInt32LE(ENTRY_PARENT_PID_OFFSET),
    image: entry.toString(
      "utf16le",
      ENTRY_IMAGE_OFFSET,
      ENTRY_IMAGE_OFFSET + chars * 2,
    ),
  };
}

/** The snapshot cursor calls `readSnapshotEntries` walks; each fills the given `PROCESSENTRY32W` buffer. */
export interface SnapshotCursor {
  first(entry: Buffer): boolean;
  next(entry: Buffer): boolean;
  lastError(): number;
}

/**
 * Read every entry of one snapshot. The walk ends when `Process32NextW` returns FALSE; the only
 * documented reason is ERROR_NO_MORE_FILES. A FALSE result can read back as error 0 because Bun's
 * FFI layer may overwrite the last error between the call and `GetLastError`, and the call cannot
 * be repeated (the cursor has advanced), so 0 counts as the end too and any other code fails.
 * More than `MAX_SNAPSHOT_ENTRIES` entries is an error instead of a shortened list.
 */
export function readSnapshotEntries(cursor: SnapshotCursor): ProcessEntry[] {
  const entries: ProcessEntry[] = [];
  const buffer = Buffer.alloc(PROCESSENTRY32W_BYTES);
  buffer.writeUInt32LE(PROCESSENTRY32W_BYTES, 0);
  let ok = cursor.first(buffer);
  while (ok) {
    if (entries.length >= MAX_SNAPSHOT_ENTRIES) {
      failure("Windows process list is too long.");
    }
    entries.push(parseProcessEntry(buffer));
    ok = cursor.next(buffer);
  }
  const code = cursor.lastError();
  if (code !== 0 && code !== ERROR_NO_MORE_FILES) {
    failure("Windows process snapshot failed.");
  }
  return entries;
}

function snapshot(api: ReturnType<typeof openAppProcessApi>): ProcessEntry[] {
  const handle = api.symbols.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (handle === INVALID_HANDLE_VALUE || handle === 0n) {
    failure("Windows process snapshot failed.");
  }
  return withHandle(api.symbols.CloseHandle, handle, (snap) =>
    readSnapshotEntries({
      first: (entry) => api.symbols.Process32FirstW(snap, ptr(entry)) !== 0,
      next: (entry) => api.symbols.Process32NextW(snap, ptr(entry)) !== 0,
      lastError: () => api.symbols.GetLastError(),
    }),
  );
}

function metrics(
  api: ReturnType<typeof openAppProcessApi>,
  pid: number,
): ProcessMetrics | null {
  const handle = api.symbols.OpenProcess(
    PROCESS_QUERY_LIMITED_INFORMATION,
    0,
    pid,
  );
  if (handle === 0n) {
    // Protected and already ended processes cannot be opened; their metrics are unknown, not an error.
    return null;
  }
  // A process that ends between OpenProcess and the queries makes them fail; that is the same
  // unknown-metrics case, not a failure of the whole list.
  return withHandle(api.symbols.CloseHandle, handle, (target) => {
    // Creation, exit, kernel and user FILETIMEs, one after another.
    const times = new BigUint64Array(4);
    if (
      !api.symbols.GetProcessTimes(
        target,
        ptr(times, 0),
        ptr(times, 8),
        ptr(times, 16),
        ptr(times, 24),
      )
    ) {
      return null;
    }
    const counters = Buffer.alloc(PROCESS_MEMORY_COUNTERS_BYTES);
    counters.writeUInt32LE(PROCESS_MEMORY_COUNTERS_BYTES, 0);
    if (
      !api.symbols.K32GetProcessMemoryInfo(
        target,
        ptr(counters),
        PROCESS_MEMORY_COUNTERS_BYTES,
      )
    ) {
      return null;
    }
    const workingSet = counters.readBigUInt64LE(COUNTERS_WORKING_SET_OFFSET);
    const kernel = (times[2] ?? 0n) / FILETIME_UNITS_PER_MICROSECOND;
    const user = (times[3] ?? 0n) / FILETIME_UNITS_PER_MICROSECOND;
    const limit = BigInt(Number.MAX_SAFE_INTEGER);
    if (workingSet > limit || kernel > limit || user > limit) {
      failure("Windows process metrics are out of range.");
    }
    return {
      creationTime: times[0] ?? 0n,
      workingSetBytes: Number(workingSet),
      userMicros: Number(user),
      systemMicros: Number(kernel),
    };
  });
}

/** Adapt the loaded kernel32.dll symbols to the narrow interface above. */
export function appProcessBindings(
  api: ReturnType<typeof openAppProcessApi>,
): AppProcessBindings {
  return {
    snapshot: () => snapshot(api),
    metrics: (pid) => metrics(api, pid),
  };
}

/**
 * The process tree rooted at `rootPid`, the app's own process, in breadth-first order with
 * siblings by ascending process ID. Parent links come from one snapshot, so a link whose parent
 * has since ended may name a reused process ID: a child that was created before its listed
 * parent is dropped, which rejects the stale link. A tree larger than `MAX_APP_PROCESSES` is an
 * error instead of a shortened list.
 */
export function listAppProcesses(
  bindings: AppProcessBindings,
  rootPid: number,
): OSAppProcess[] {
  const entries = bindings.snapshot();
  const root = entries.find((entry) => entry.pid === rootPid);
  if (root === undefined) {
    return failure("Windows app process is missing from the process list.");
  }
  const children = new Map<number, ProcessEntry[]>();
  for (const entry of entries) {
    if (entry.pid === entry.parentPid) {
      continue;
    }
    const siblings = children.get(entry.parentPid) ?? [];
    siblings.push(entry);
    children.set(entry.parentPid, siblings);
  }
  const queue: {
    entry: ProcessEntry;
    kind: OSAppProcess["kind"];
    metrics: ProcessMetrics | null;
  }[] = [
    {
      entry: root,
      kind: "app",
      metrics: bindings.metrics(root.pid),
    },
  ];
  const seen = new Set<number>([
    root.pid,
  ]);
  const processes: OSAppProcess[] = [];
  for (let index = 0; index < queue.length; index += 1) {
    const node = queue[index];
    if (node === undefined) {
      break;
    }
    if (processes.length >= MAX_APP_PROCESSES) {
      failure("Windows app process list is too long.");
    }
    processes.push({
      pid: node.entry.pid,
      parentPid: node.entry.parentPid,
      kind: node.kind,
      metrics: node.metrics && {
        workingSetBytes: node.metrics.workingSetBytes,
        cpuTime: {
          userMicros: node.metrics.userMicros,
          systemMicros: node.metrics.systemMicros,
        },
      },
    });
    const next = (children.get(node.entry.pid) ?? []).sort(
      (left, right) => left.pid - right.pid,
    );
    for (const child of next) {
      if (seen.has(child.pid)) {
        continue;
      }
      const childMetrics = bindings.metrics(child.pid);
      if (
        node.metrics !== null &&
        childMetrics !== null &&
        childMetrics.creationTime < node.metrics.creationTime
      ) {
        continue;
      }
      seen.add(child.pid);
      queue.push({
        entry: child,
        kind:
          node.kind === "webview2" ||
          child.image.toLowerCase() === WEBVIEW2_IMAGE
            ? "webview2"
            : "other",
        metrics: childMetrics,
      });
    }
  }
  return processes;
}
