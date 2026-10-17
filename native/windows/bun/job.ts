import { dlopen, ptr } from "bun:ffi";
import assert from "node:assert/strict";
import { mkdirSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import {
  type RelaunchCommand,
  relaunchCommandLine,
  relaunchCommandLineTooLong,
} from "./relaunch.ts";

const INVALID_HANDLE_VALUE = 0xffffffffffffffffn;
const GENERIC_READ = 0x80000000;
const GENERIC_WRITE = 0x40000000;
const OPEN_ALWAYS = 4;
const FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
const ERROR_SHARING_VIOLATION = 32;

const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS = 9;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
const JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION_CLASS = 1;
const JOB_OBJECT_BASIC_PROCESS_ID_LIST_CLASS = 3;
const ERROR_MORE_DATA = 234;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_ACCESS_DENIED = 5;
const PROCESS_TERMINATE = 0x0001;
const SYNCHRONIZE = 0x00100000;
const PROCESS_TERMINATION_ACCESS = PROCESS_TERMINATE | SYNCHRONIZE;

const JOBOBJECT_EXTENDED_LIMIT_INFORMATION_BYTES = 144;
const JOB_LIMIT_FLAGS_OFFSET = 16;
const JOBOBJECT_BASIC_ACCOUNTING_INFORMATION_BYTES = 48;
const ACTIVE_PROCESS_COUNT_OFFSET = 40;
const PROCESS_ID_LIST_HEADER_BYTES = 8;
const PROCESS_ID_COUNT_OFFSET = 4;
const PROCESS_ID_BYTES = 8;
const INITIAL_PROCESS_ID_CAPACITY = 128;
const MAX_PROCESS_ID_LIST_BYTES = 16 * 1024 * 1024;
const DEFAULT_DESCENDANT_CLEANUP_TIMEOUT_MS = 5000;
const PROCESS_EXIT_POLL_INTERVAL_MS = 10;
const WAIT_OBJECT_0 = 0;

const JOB_OBJECT_LIMIT_BREAKAWAY_OK = 0x0800;
const CREATE_UNICODE_ENVIRONMENT = 0x0400;
const CREATE_BREAKAWAY_FROM_JOB = 0x01000000;
const STARTUPINFOW_BYTES = 104; // Win64
const PROCESS_INFORMATION_BYTES = 24; // Win64
/** Longest wait for a previous host to release the app lock after a relaunch. */
const RELAUNCH_LOCK_WAIT_MS = 30000;
const RELAUNCH_LOCK_POLL_MS = 50;

/** Signals that another process already owns this app data directory. */
export class AppAlreadyRunningError extends Error {
  constructor() {
    super("App data directory is already in use.");
  }
}

let owned:
  | {
      handle: bigint;
      lock: bigint;
      dataRoot: string;
      api: ReturnType<typeof openBindings>;
    }
  | undefined;
function openBindings() {
  return dlopen("kernel32.dll", {
    CreateFileW: {
      args: [
        "ptr",
        "u32",
        "u32",
        "ptr",
        "u32",
        "u32",
        "u64",
      ],
      returns: "u64",
    },
    GetLastError: {
      args: [],
      returns: "u32",
    },
    CreateJobObjectW: {
      args: [
        "ptr",
        "ptr",
      ],
      returns: "u64",
    },
    GetCurrentProcess: {
      args: [],
      returns: "u64",
    },
    SetInformationJobObject: {
      args: [
        "u64",
        "i32",
        "ptr",
        "u32",
      ],
      returns: "i32",
    },
    QueryInformationJobObject: {
      args: [
        "u64",
        "i32",
        "ptr",
        "u32",
        "ptr",
      ],
      returns: "i32",
    },
    AssignProcessToJobObject: {
      args: [
        "u64",
        "u64",
      ],
      returns: "i32",
    },
    OpenProcess: {
      args: [
        "u32",
        "i32",
        "u32",
      ],
      returns: "u64",
    },
    TerminateProcess: {
      args: [
        "u64",
        "u32",
      ],
      returns: "i32",
    },
    WaitForSingleObject: {
      args: [
        "u64",
        "u32",
      ],
      returns: "u32",
    },
    CloseHandle: {
      args: [
        "u64",
      ],
      returns: "i32",
    },
    CreateProcessW: {
      args: [
        "ptr",
        "ptr",
        "ptr",
        "ptr",
        "i32",
        "u32",
        "ptr",
        "ptr",
        "ptr",
        "ptr",
      ],
      returns: "i32",
    },
  });
}
/**
 * Claims the app directory and assigns this host to a kill-on-close Job Object.
 * Repeated claims for this directory are harmless; ownership lasts until exit.
 */
export function containAppProcess(dataRoot: string) {
  mkdirSync(dataRoot, {
    recursive: true,
  });
  const canonical = realpathSync(dataRoot).toLowerCase();
  if (owned) {
    assert.equal(
      owned.dataRoot,
      canonical,
      "App process already owns another data directory",
    );
    return;
  }
  const api = openBindings();
  const name = Buffer.from(`${resolve(dataRoot, "host.lock")}\0`, "utf16le");
  // OPEN_ALWAYS, no sharing: preserve profiles but reject a second owner before app import.
  const lock = api.symbols.CreateFileW(
    ptr(name),
    (GENERIC_READ | GENERIC_WRITE) >>> 0,
    0,
    null,
    OPEN_ALWAYS,
    FILE_FLAG_OPEN_REPARSE_POINT,
    0n,
  );
  if (lock === INVALID_HANDLE_VALUE) {
    const error = api.symbols.GetLastError();
    api.close();
    if (error === ERROR_SHARING_VIOLATION) {
      throw new AppAlreadyRunningError();
    }
    throw new Error(`App lock failed (${error})`);
  }
  let handle = 0n;
  try {
    handle = api.symbols.CreateJobObjectW(null, null);
    assert(handle, "App Job creation failed");
    const limits = Buffer.alloc(JOBOBJECT_EXTENDED_LIMIT_INFORMATION_BYTES);
    limits.writeUInt32LE(
      JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
      JOB_LIMIT_FLAGS_OFFSET,
    );
    assert(
      api.symbols.SetInformationJobObject(
        handle,
        JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
        ptr(limits),
        limits.length,
      ),
      "App Job limits failed",
    );
    assert(
      api.symbols.AssignProcessToJobObject(
        handle,
        api.symbols.GetCurrentProcess(),
      ),
      "App Job assignment failed",
    );
    // Non-inheritable handle lives until process exit. Closing it here would kill
    // this process too; OS handle teardown also reaps remaining app descendants.
    // The OS also releases the file lock on normal exit or a crash; no stale-lock deletion.
    owned = {
      api,
      handle,
      lock,
      dataRoot: canonical,
    };
  } catch (error) {
    if (handle) {
      api.symbols.CloseHandle(handle);
    }
    api.symbols.CloseHandle(lock);
    api.close();
    throw error;
  }
}
/**
 * Claims the app directory for a process that `relaunch()` started. The previous host may still be
 * exiting and holds the lock until the OS tears it down, so a busy lock is retried until it
 * frees. After the deadline the claim fails like an ordinary second start, which then forwards its
 * arguments to the instance that owns the directory.
 */
export async function containAppProcessAfterRelaunch(
  dataRoot: string,
  timeoutMs = RELAUNCH_LOCK_WAIT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      containAppProcess(dataRoot);
      return;
    } catch (error) {
      if (
        !(error instanceof AppAlreadyRunningError) ||
        Date.now() >= deadline
      ) {
        throw error;
      }
      await Bun.sleep(RELAUNCH_LOCK_POLL_MS);
    }
  }
}

/** Builds a sorted UTF-16 environment block, which `CreateProcessW` expects. */
function environmentBlock(env: RelaunchCommand["env"]): Buffer {
  const entries = Object.entries(env)
    .filter(
      (
        entry,
      ): entry is [
        string,
        string,
      ] => entry[1] !== undefined,
    )
    .sort(([a], [b]) => {
      const left = a.toUpperCase();
      const right = b.toUpperCase();
      return left < right ? -1 : left > right ? 1 : 0;
    });
  return Buffer.from(
    `${entries.map(([name, value]) => `${name}=${value}\0`).join("")}\0`,
    "utf16le",
  );
}

/**
 * Starts a process that is not part of this app's Job, so it survives this host's exit.
 * The Job is made breakaway-capable only for this call. Throws when Windows refuses, for example
 * because an outer Job (a CI runner or launcher) forbids breakaway; the caller then reports the
 * failure and exits without a new process. Requires an active app Job.
 *
 * Returns the error when the process started but the Job's breakaway permission could not be
 * withdrawn afterwards; the launch itself succeeded, so it is a diagnostic and not a failure.
 */
export function startOutsideAppJob(command: RelaunchCommand): unknown {
  assert(owned);
  const { api, handle } = owned;
  const line = relaunchCommandLine(command);
  if (relaunchCommandLineTooLong(line)) {
    throw new Error("Relaunch command line is too long");
  }
  const setFlags = (flags: number) => {
    const limits = Buffer.alloc(JOBOBJECT_EXTENDED_LIMIT_INFORMATION_BYTES);
    limits.writeUInt32LE(flags, JOB_LIMIT_FLAGS_OFFSET);
    assert(
      api.symbols.SetInformationJobObject(
        handle,
        JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
        ptr(limits),
        limits.length,
      ),
      "App Job limits failed",
    );
  };
  const application = Buffer.from(`${command.executable}\0`, "utf16le");
  const commandLine = Buffer.from(`${line}\0`, "utf16le");
  const cwd = Buffer.from(`${command.cwd}\0`, "utf16le");
  const environment = environmentBlock(command.env);
  const startup = Buffer.alloc(STARTUPINFOW_BYTES);
  startup.writeUInt32LE(STARTUPINFOW_BYTES, 0);
  const information = Buffer.alloc(PROCESS_INFORMATION_BYTES);
  setFlags(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK);
  try {
    // Handles are not inherited: the new host must not share this host's pipes or the lock file.
    if (
      !api.symbols.CreateProcessW(
        ptr(application),
        ptr(commandLine),
        null,
        null,
        0,
        CREATE_BREAKAWAY_FROM_JOB | CREATE_UNICODE_ENVIRONMENT,
        ptr(environment),
        ptr(cwd),
        ptr(startup),
        ptr(information),
      )
    ) {
      throw new Error(
        `Relaunch CreateProcessW failed (Win32 ${api.symbols.GetLastError()})`,
      );
    }
    api.symbols.CloseHandle(information.readBigUInt64LE(0));
    api.symbols.CloseHandle(information.readBigUInt64LE(8));
  } catch (error) {
    try {
      setFlags(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE);
    } catch (restoreError) {
      // A restore failure must not hide why the launch failed; it is kept as the cause instead.
      if (error instanceof Error && error.cause === undefined) {
        error.cause = restoreError;
      }
    }
    throw error;
  }
  try {
    setFlags(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE);
  } catch (restoreError) {
    // The new process is already running, so this is not a launch failure: report it separately.
    return restoreError;
  }
}

/**
 * Requires an active app Job.
 * Returns its live descendants, excluding this Bun host.
 */
export function activeDescendants(): number {
  assert(owned);
  const accounting = Buffer.alloc(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION_BYTES);
  assert(
    owned.api.symbols.QueryInformationJobObject(
      owned.handle,
      JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION_CLASS,
      ptr(accounting),
      accounting.length,
      null,
    ),
    "App Job query failed",
  );
  return Math.max(0, accounting.readUInt32LE(ACTIVE_PROCESS_COUNT_OFFSET) - 1); // exclude this Bun process
}

// The development-server worker remains alive until its Job descendants exit.
// A worker exit notification alone does not establish that their ports are free.
/**
 * Terminates app descendants and waits for exit.
 * Requires an active app Job; rejects on timeout or Win32 failure.
 */
export async function terminateAppDescendants(
  timeoutMs = DEFAULT_DESCENDANT_CLEANUP_TIMEOUT_MS,
): Promise<void> {
  assert(owned);
  const { api, handle } = owned;
  const deadline = Date.now() + timeoutMs;
  while (activeDescendants() > 0) {
    assert(Date.now() < deadline, "App Job descendant cleanup timed out");
    let list = Buffer.alloc(
      PROCESS_ID_LIST_HEADER_BYTES +
        PROCESS_ID_BYTES * INITIAL_PROCESS_ID_CAPACITY,
    ); // JOBOBJECT_BASIC_PROCESS_ID_LIST, Win64
    while (
      !api.symbols.QueryInformationJobObject(
        handle,
        JOB_OBJECT_BASIC_PROCESS_ID_LIST_CLASS,
        ptr(list),
        list.length,
        null,
      )
    ) {
      assert.equal(
        api.symbols.GetLastError(),
        ERROR_MORE_DATA,
        "App Job process inventory failed",
      );
      assert(
        list.length < MAX_PROCESS_ID_LIST_BYTES,
        "App Job process inventory is too large",
      );
      list = Buffer.alloc(list.length * 2);
    }
    const count = list.readUInt32LE(PROCESS_ID_COUNT_OFFSET);
    for (let index = 0; index < count; index++) {
      const pid = Number(
        list.readBigUInt64LE(
          PROCESS_ID_LIST_HEADER_BYTES + index * PROCESS_ID_BYTES,
        ),
      );
      if (pid === process.pid) {
        continue;
      }
      const processHandle = api.symbols.OpenProcess(
        PROCESS_TERMINATION_ACCESS,
        0,
        pid,
      );
      if (!processHandle) {
        assert.equal(
          api.symbols.GetLastError(),
          ERROR_INVALID_PARAMETER,
          `Cannot open Job descendant ${pid}`,
        ); // already exited
        continue;
      }
      try {
        if (
          api.symbols.WaitForSingleObject(processHandle, 0) !== WAIT_OBJECT_0
        ) {
          const terminated = api.symbols.TerminateProcess(processHandle, 1);
          const terminationError = terminated ? 0 : api.symbols.GetLastError();
          if (!terminated) {
            // A self-exiting process can deny termination before its handle is signaled.
            assert.equal(
              terminationError,
              ERROR_ACCESS_DENIED,
              `Cannot terminate Job descendant ${pid} (Win32 ${terminationError})`,
            );
            while (
              api.symbols.WaitForSingleObject(processHandle, 0) !==
              WAIT_OBJECT_0
            ) {
              assert(
                Date.now() < deadline,
                `Job descendant ${pid} did not finish exiting`,
              );
              await Bun.sleep(PROCESS_EXIT_POLL_INTERVAL_MS);
            }
          }
        }
      } finally {
        api.symbols.CloseHandle(processHandle);
      }
    }
    await Bun.sleep(PROCESS_EXIT_POLL_INTERVAL_MS);
  }
}
