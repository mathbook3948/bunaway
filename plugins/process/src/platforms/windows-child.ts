import { ptr } from "bun:ffi";
import { win32CallError } from "@bunaway/plugin/win32";
import { BunawayError } from "@bunaway/protocol";
import type {
  ChildExit,
  ChildState,
  SpawnedChild,
  WriteOutcome,
} from "#process/platforms/spawn-child";
import { openProcessBindings } from "#process/platforms/windows-process-bindings";
import {
  CLEANUP_TIMEOUT_MS,
  CREATE_NO_WINDOW,
  CREATE_UNICODE_ENVIRONMENT,
  ERROR_BROKEN_PIPE,
  ERROR_INSUFFICIENT_BUFFER,
  ERROR_IO_INCOMPLETE,
  ERROR_IO_PENDING,
  ERROR_NO_DATA,
  ERROR_NOT_FOUND,
  ERROR_OPERATION_ABORTED,
  ERROR_PIPE_CONNECTED,
  EXTENDED_STARTUPINFO_PRESENT,
  FILE_FLAG_FIRST_PIPE_INSTANCE,
  FILE_FLAG_OVERLAPPED,
  GENERIC_READ,
  HANDLE_FLAG_INHERIT,
  INVALID_HANDLE_VALUE,
  JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION,
  JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
  JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
  OPEN_EXISTING,
  PIPE_ACCESS_OUTBOUND,
  PIPE_BUFFER_BYTES,
  PIPE_REJECT_REMOTE_CLIENTS,
  POLL_INTERVAL_MS,
  PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
  PROC_THREAD_ATTRIBUTE_JOB_LIST,
  STARTF_USESTDHANDLES,
  WAIT_OBJECT_0,
  WAIT_TIMEOUT,
} from "#process/platforms/windows-process-constants";

/** Cleanup failure must take precedence over the original cancellation reason. */
export class ProcessCleanupError extends BunawayError {
  constructor() {
    super({
      code: "INTERNAL",
      message: "Process cleanup failed.",
    });
  }
}

/** What to launch and how stdin is connected: `nul` is an empty input, `pipe` accepts writes. */
export interface WindowsChildOptions {
  executablePath: string;
  args: readonly string[];
  stdin: "nul" | "pipe";
}

interface OutputPipe {
  read: bigint;
  write: bigint;
  ended: boolean;
}

// Windows programs using the standard argv parser require doubled backslashes
// before quotes and the closing quote. No shell is involved in this command line.
function quoteArgument(value: string) {
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1")}"`;
}

/** Snapshot Bun's trusted environment, including dotenv values absent from the OS block. */
function runnerEnvironment() {
  const entries = Object.entries(process.env).filter(
    (
      entry,
    ): entry is [
      string,
      string,
    ] => entry[1] !== undefined,
  );
  for (const [name, value] of entries) {
    // Environment strings are NUL separated. Reject malformed trusted state
    // instead of accidentally turning one value into another variable.
    const driveDirectory = /^=[A-Za-z]:$/.test(name);
    if (
      name.length === 0 ||
      name.includes("\0") ||
      (name.includes("=") && !driveDirectory) ||
      value.includes("\0")
    ) {
      throw new BunawayError({
        code: "INTERNAL",
        message: "Process environment is invalid.",
      });
    }
  }
  // Windows requires case-insensitive Unicode order, independent of locale.
  entries.sort(([left], [right]) => {
    const a = left.toUpperCase();
    const b = right.toUpperCase();
    if (a < b) {
      return -1;
    }
    return a > b ? 1 : 0;
  });
  return Buffer.from(
    `${entries.map(([name, value]) => `${name}=${value}`).join("\0")}\0\0`,
    "utf16le",
  );
}

/**
 * One Win32 child created atomically inside its own kill-on-close Job, with private pipes.
 * The inherited host Job remains an ancestor; neither Job allows breakaway. Only the three
 * standard handles are inherited, never the Job handle. The instance owns every handle until
 * `release`, which runs on the thread that launched it.
 */
export class WindowsProcessChild implements SpawnedChild {
  pid = 0;
  private readonly api = openProcessBindings();
  private readonly handles = new Set<bigint>();
  private readonly pipes = {
    stdout: emptyPipe(),
    stderr: emptyPipe(),
  };
  private readonly overlapped = Buffer.alloc(32); // OVERLAPPED, Win64
  private readonly transferred = Buffer.alloc(4);
  private readonly security = Buffer.alloc(24); // SECURITY_ATTRIBUTES, Win64
  private job = 0n;
  private child = 0n;
  private writer = 0n;
  private attributes:
    | {
        list: Buffer;
        values: Buffer[];
      }
    | undefined;
  private exit: ChildExit | undefined;
  private closing = false;
  /** A cancelled write the kernel had not finished; pinned so its buffer outlives the call. */
  private stuckWrite: Buffer | undefined;
  private activeWrite: Promise<WriteOutcome> | undefined;
  private released: Promise<void> | undefined;

  private constructor() {
    this.security.writeUInt32LE(this.security.length, 0);
    this.security.writeUInt32LE(1, 16);
  }

  /**
   * Create the Job, pipes and child. A failure releases whatever was acquired first, and a
   * failed release takes precedence over the launch error.
   */
  static async launch(
    options: WindowsChildOptions,
    signal: AbortSignal,
  ): Promise<WindowsProcessChild> {
    signal.throwIfAborted();
    const instance = new WindowsProcessChild();
    try {
      instance.start(options, signal);
    } catch (error) {
      await instance.release();
      throw error;
    }
    return instance;
  }

  state(): ChildState {
    this.pollExit();
    const stdoutBytes = this.available(this.pipes.stdout);
    const stderrBytes = this.available(this.pipes.stderr);
    return {
      exit: this.exit ?? null,
      stdoutBytes,
      stderrBytes,
      outputEnded: this.pipes.stdout.ended && this.pipes.stderr.ended,
    };
  }

  take(stream: "stdout" | "stderr", count: number): Buffer {
    if (count <= 0) {
      return Buffer.alloc(0);
    }
    const bytes = Buffer.alloc(count);
    // We are the sole reader and the caller asked for at most the peeked bytes, so this cannot block.
    this.requireSuccess(
      this.api.symbols.ReadFile(
        this.pipes[stream].read,
        ptr(bytes),
        count,
        ptr(this.transferred),
        null,
      ),
    );
    return bytes.subarray(0, this.transferred.readUInt32LE());
  }

  write(bytes: Uint8Array, signal: AbortSignal): Promise<WriteOutcome> {
    const task = this.submitWrite(Buffer.from(bytes), signal);
    this.activeWrite = task;
    return task.finally(() => {
      if (this.activeWrite === task) {
        this.activeWrite = undefined;
      }
    });
  }

  async closeStdin(signal?: AbortSignal): Promise<void> {
    if (this.activeWrite !== undefined) {
      await this.waitForWrite(this.activeWrite, signal);
    }
    // With a write the kernel still owns, release closes the pipe after the tree ended.
    if (this.writer && this.stuckWrite === undefined) {
      this.closeHandle(this.writer);
      this.writer = 0n;
    }
  }

  /** Wait for a write to settle, or throw the abort reason if `signal` fires first. */
  private async waitForWrite(
    write: Promise<WriteOutcome>,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<"aborted">((resolve) => {
      onAbort = () => resolve("aborted");
      signal?.addEventListener("abort", onAbort, {
        once: true,
      });
    });
    try {
      const outcome = await Promise.race([
        Promise.allSettled([
          write,
        ]).then(() => "settled" as const),
        aborted,
      ]);
      if (outcome === "aborted") {
        throw signal?.reason;
      }
    } finally {
      if (onAbort) {
        signal?.removeEventListener("abort", onAbort);
      }
    }
  }

  async kill(): Promise<void> {
    if (this.child && this.released === undefined) {
      this.terminateJob();
    }
  }

  release(): Promise<void> {
    this.released ??= this.performRelease();
    return this.released;
  }

  /** Build the Job, pipes and child; every handle is registered in `handles` as soon as it exists. */
  private start(options: WindowsChildOptions, signal: AbortSignal) {
    this.job = this.own(this.api.symbols.CreateJobObjectW(null, null));
    const limits = Buffer.alloc(144); // JOBOBJECT_EXTENDED_LIMIT_INFORMATION, Win64
    limits.writeUInt32LE(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, 16);
    this.requireSuccess(
      this.api.symbols.SetInformationJobObject(
        this.job,
        JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
        ptr(limits),
        limits.length,
      ),
    );
    this.createOutput(this.pipes.stdout);
    this.createOutput(this.pipes.stderr);
    const stdin = this.openStdin(options.stdin);
    const list = this.buildAttributeList(stdin);
    this.startChild(options, list, stdin, signal);
  }

  private fail(
    operation = "Win32 process operation",
    nativeCode = this.api.symbols.GetLastError(),
  ) {
    const error = new BunawayError({
      code: "INTERNAL",
      message: "Process execution failed.",
    });
    // Trusted diagnostics retain the native operation/code. The public wire
    // error contains only the sanitized message and code, never this cause.
    Object.defineProperty(error, "cause", {
      value: new Error(`${operation} failed (Win32 ${nativeCode}).`),
    });
    return error;
  }

  private requireSuccess(result: number, operation?: string) {
    if (!result) {
      throw this.fail(operation);
    }
  }

  private own(handle: bigint) {
    if (!handle || handle === INVALID_HANDLE_VALUE) {
      throw this.fail();
    }
    this.handles.add(handle);
    return handle;
  }

  private closeHandle(handle: bigint) {
    if (this.handles.has(handle)) {
      this.requireSuccess(this.api.symbols.CloseHandle(handle));
      this.handles.delete(handle);
    }
  }

  private inherit(handle: bigint) {
    this.requireSuccess(
      this.api.symbols.SetHandleInformation(
        handle,
        HANDLE_FLAG_INHERIT,
        HANDLE_FLAG_INHERIT,
      ),
    );
  }

  /** The write end is inheritable for the child; our read end is not. */
  private createOutput(pipe: OutputPipe) {
    const pair = Buffer.alloc(16);
    this.requireSuccess(
      this.api.symbols.CreatePipe(
        ptr(pair),
        ptr(pair, 8),
        ptr(this.security),
        PIPE_BUFFER_BYTES,
      ),
    );
    pipe.read = this.own(pair.readBigUInt64LE(0));
    pipe.write = this.own(pair.readBigUInt64LE(8));
    this.requireSuccess(
      this.api.symbols.SetHandleInformation(pipe.read, HANDLE_FLAG_INHERIT, 0),
    );
  }

  /** Opens stdin: NUL for no input, otherwise a private overlapped pipe whose write end becomes `writer`. */
  private openStdin(mode: WindowsChildOptions["stdin"]): bigint {
    if (mode === "nul") {
      const name = Buffer.from("NUL\0", "utf16le");
      return this.own(
        this.api.symbols.CreateFileW(
          ptr(name),
          GENERIC_READ,
          0,
          ptr(this.security),
          OPEN_EXISTING,
          0,
          0n,
        ),
      );
    }
    // A private named pipe permits overlapped writes. An anonymous WriteFile
    // could block the Worker forever if the child never consumes its stdin.
    const name = Buffer.from(
      `\\\\.\\pipe\\bunaway-process-${crypto.randomUUID()}\0`,
      "utf16le",
    );
    this.writer = this.own(
      this.api.symbols.CreateNamedPipeW(
        ptr(name),
        PIPE_ACCESS_OUTBOUND |
          FILE_FLAG_OVERLAPPED |
          FILE_FLAG_FIRST_PIPE_INSTANCE,
        PIPE_REJECT_REMOTE_CLIENTS,
        1,
        PIPE_BUFFER_BYTES,
        PIPE_BUFFER_BYTES,
        0,
        null,
      ),
    );
    const stdin = this.own(
      this.api.symbols.CreateFileW(
        ptr(name),
        GENERIC_READ,
        0,
        null,
        OPEN_EXISTING,
        0,
        0n,
      ),
    );
    this.inherit(stdin);
    if (
      !this.api.symbols.ConnectNamedPipe(this.writer, ptr(this.overlapped)) &&
      this.api.symbols.GetLastError() !== ERROR_PIPE_CONNECTED
    ) {
      throw this.fail();
    }
    return stdin;
  }

  /** Restricts inheritance to the standard handles and places the child in the Job. */
  private buildAttributeList(stdin: bigint): Buffer {
    const size = Buffer.alloc(8);
    this.api.symbols.InitializeProcThreadAttributeList(null, 2, 0, ptr(size));
    if (this.api.symbols.GetLastError() !== ERROR_INSUFFICIENT_BUFFER) {
      throw this.fail();
    }
    const attributeBytes = Number(size.readBigUInt64LE());
    if (attributeBytes <= 0 || attributeBytes > 65536) {
      throw this.fail();
    }
    const list = Buffer.alloc(attributeBytes);
    this.requireSuccess(
      this.api.symbols.InitializeProcThreadAttributeList(
        ptr(list),
        2,
        0,
        ptr(size),
      ),
    );
    this.attributes = {
      list,
      values: [],
    };
    const standardHandles = Buffer.alloc(24);
    standardHandles.writeBigUInt64LE(stdin, 0);
    standardHandles.writeBigUInt64LE(this.pipes.stdout.write, 8);
    standardHandles.writeBigUInt64LE(this.pipes.stderr.write, 16);
    const jobs = Buffer.alloc(8);
    jobs.writeBigUInt64LE(this.job);
    // Win32 retains the value pointers until DeleteProcThreadAttributeList.
    // Keep their buffers reachable through the attribute owner across later allocations.
    this.attributes.values.push(standardHandles, jobs);
    this.requireSuccess(
      this.api.symbols.UpdateProcThreadAttribute(
        ptr(list),
        0,
        PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
        ptr(standardHandles),
        BigInt(standardHandles.length),
        null,
        null,
      ),
    );
    this.requireSuccess(
      this.api.symbols.UpdateProcThreadAttribute(
        ptr(list),
        0,
        PROC_THREAD_ATTRIBUTE_JOB_LIST,
        ptr(jobs),
        BigInt(jobs.length),
        null,
        null,
      ),
    );
    return list;
  }

  /** Creates the child inside the Job, owning the process handle, and closes the ends only the child keeps. */
  private startChild(
    options: WindowsChildOptions,
    list: Buffer,
    stdin: bigint,
    signal: AbortSignal,
  ) {
    const startup = Buffer.alloc(112); // STARTUPINFOEXW, Win64
    startup.writeUInt32LE(startup.length, 0);
    startup.writeUInt32LE(STARTF_USESTDHANDLES, 60);
    startup.writeBigUInt64LE(stdin, 80);
    startup.writeBigUInt64LE(this.pipes.stdout.write, 88);
    startup.writeBigUInt64LE(this.pipes.stderr.write, 96);
    startup.writeBigUInt64LE(BigInt(ptr(list)), 104);
    const information = Buffer.alloc(24); // PROCESS_INFORMATION, Win64
    const executable = Buffer.from(`${options.executablePath}\0`, "utf16le");
    const commandLine = Buffer.from(
      `${[
        options.executablePath,
        ...options.args,
      ]
        .map(quoteArgument)
        .join(" ")}\0`,
      "utf16le",
    );
    const environment = runnerEnvironment();
    signal.throwIfAborted();
    // JOB_LIST makes assignment part of creation. Failure never launches an
    // uncontained child; host crashes cannot leave a suspended, unassigned process.
    this.requireSuccess(
      this.api.symbols.CreateProcessW(
        ptr(executable),
        ptr(commandLine),
        null,
        null,
        1,
        EXTENDED_STARTUPINFO_PRESENT |
          CREATE_NO_WINDOW |
          CREATE_UNICODE_ENVIRONMENT,
        ptr(environment),
        null,
        ptr(startup),
        ptr(information),
      ),
      "CreateProcessW",
    );
    this.child = this.own(information.readBigUInt64LE(0));
    const thread = this.own(information.readBigUInt64LE(8));
    this.pid = information.readUInt32LE(16);
    this.api.symbols.DeleteProcThreadAttributeList(ptr(list));
    this.attributes = undefined;
    this.closeHandle(thread);
    this.closeHandle(stdin);
    this.closeHandle(this.pipes.stdout.write);
    this.closeHandle(this.pipes.stderr.write);
  }

  /** Record the exit once and end the remaining descendants so inherited pipes reach end of file. */
  private pollExit() {
    if (this.exit || !this.child || this.released !== undefined) {
      return;
    }
    const state = this.api.symbols.WaitForSingleObject(this.child, 0);
    if (state === WAIT_TIMEOUT) {
      return;
    }
    if (state !== WAIT_OBJECT_0) {
      throw this.fail();
    }
    const code = Buffer.alloc(4);
    this.requireSuccess(
      this.api.symbols.GetExitCodeProcess(this.child, ptr(code)),
    );
    this.exit = {
      exitCode: code.readUInt32LE(),
      signal: null,
    };
    this.terminateJob();
  }

  private terminateJob() {
    if (!this.api.symbols.TerminateJobObject(this.job, 1)) {
      throw new ProcessCleanupError();
    }
  }

  /** Bytes waiting in a pipe; a broken pipe with nothing left means the writers are gone. */
  private available(pipe: OutputPipe): number {
    if (pipe.ended) {
      return 0;
    }
    const available = Buffer.alloc(4);
    const peekError = win32CallError(
      () =>
        this.api.symbols.PeekNamedPipe(
          pipe.read,
          null,
          0,
          null,
          ptr(available),
          null,
        ),
      () => this.api.symbols.GetLastError(),
    );
    if (peekError === ERROR_BROKEN_PIPE) {
      pipe.ended = true;
      return 0;
    }
    if (peekError) {
      throw this.fail("Win32 process operation", peekError);
    }
    return available.readUInt32LE();
  }

  /** Start an overlapped write and wait for it, keeping `data` alive until the kernel is done with it. */
  private async submitWrite(
    data: Buffer,
    signal: AbortSignal,
  ): Promise<WriteOutcome> {
    if (!this.writer || this.stuckWrite !== undefined) {
      return "closed";
    }
    if (data.length === 0) {
      return "written";
    }
    this.overlapped.fill(0);
    if (
      this.api.symbols.WriteFile(
        this.writer,
        ptr(data),
        data.length,
        ptr(this.transferred),
        ptr(this.overlapped),
      )
    ) {
      return this.completedWrite(data.length);
    }
    const error = this.api.symbols.GetLastError();
    if (error === ERROR_BROKEN_PIPE || error === ERROR_NO_DATA) {
      return "closed";
    }
    if (error !== ERROR_IO_PENDING) {
      throw this.fail("WriteFile", error);
    }
    return this.awaitWrite(data, signal);
  }

  private completedWrite(expected: number): WriteOutcome {
    if (this.transferred.readUInt32LE() !== expected) {
      throw this.fail();
    }
    return "written";
  }

  /** Poll the pending write; a cancelled or released child cancels it and waits for the kernel to finish. */
  private async awaitWrite(
    data: Buffer,
    signal: AbortSignal,
  ): Promise<WriteOutcome> {
    while (true) {
      if (
        this.api.symbols.GetOverlappedResult(
          this.writer,
          ptr(this.overlapped),
          ptr(this.transferred),
          0,
        )
      ) {
        return this.completedWrite(data.length);
      }
      const error = this.api.symbols.GetLastError();
      if (error !== ERROR_IO_INCOMPLETE) {
        // A child may close stdin without consuming the input, matching Bun's pipe behavior.
        if (
          error === ERROR_BROKEN_PIPE ||
          error === ERROR_NO_DATA ||
          error === ERROR_OPERATION_ABORTED
        ) {
          return "closed";
        }
        throw this.fail("WriteFile", error);
      }
      if (signal.aborted || this.closing) {
        await this.cancelWrite(data);
        throw signal.aborted
          ? signal.reason
          : new BunawayError({
              code: "CANCELLED",
              message: "Process was released.",
            });
      }
      await Bun.sleep(POLL_INTERVAL_MS);
    }
  }

  /** CancelIoEx only requests cancellation; the buffer stays valid until the write completes. */
  private async cancelWrite(data: Buffer) {
    const cancellationFailed =
      !this.api.symbols.CancelIoEx(this.writer, ptr(this.overlapped)) &&
      this.api.symbols.GetLastError() !== ERROR_NOT_FOUND;
    const deadline = Date.now() + CLEANUP_TIMEOUT_MS;
    while (!this.writeFinished()) {
      if (Date.now() >= deadline) {
        // The kernel may still read `data` and write the OVERLAPPED: keep both untouched and
        // refuse further writes until release closes the pipe.
        this.stuckWrite = data;
        throw new ProcessCleanupError();
      }
      await Bun.sleep(POLL_INTERVAL_MS);
    }
    if (cancellationFailed) {
      throw new ProcessCleanupError();
    }
  }

  private writeFinished() {
    return (
      this.api.symbols.GetOverlappedResult(
        this.writer,
        ptr(this.overlapped),
        ptr(this.transferred),
        0,
      ) !== 0 || this.api.symbols.GetLastError() !== ERROR_IO_INCOMPLETE
    );
  }

  /** Wait until the Job has no processes and the child is signaled, or fail after the cleanup deadline. */
  private async terminate() {
    if (!this.child) {
      return;
    }
    this.terminateJob();
    const accounting = Buffer.alloc(48); // JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, Win64
    const deadline = Date.now() + CLEANUP_TIMEOUT_MS;
    while (true) {
      if (
        !this.api.symbols.QueryInformationJobObject(
          this.job,
          JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION,
          ptr(accounting),
          accounting.length,
          null,
        )
      ) {
        throw new ProcessCleanupError();
      }
      const state = this.api.symbols.WaitForSingleObject(this.child, 0);
      if (state !== WAIT_OBJECT_0 && state !== WAIT_TIMEOUT) {
        throw new ProcessCleanupError();
      }
      if (accounting.readUInt32LE(40) === 0 && state === WAIT_OBJECT_0) {
        return;
      }
      if (Date.now() >= deadline) {
        throw new ProcessCleanupError();
      }
      await Bun.sleep(POLL_INTERVAL_MS);
    }
  }

  /**
   * Finish any write, end the tree, then close every handle even when a step fails. The
   * non-inherited kill-on-close Job remains the final failure fallback.
   */
  private async performRelease() {
    let failed = false;
    this.closing = true;
    // End the tree before waiting on a write: the broken pipe releases a write that a child
    // not reading stdin would otherwise hold up, even if cancelling it fails.
    try {
      if (this.child) {
        this.terminateJob();
      }
    } catch {
      failed = true;
    }
    if (this.activeWrite !== undefined) {
      const writes = await Promise.allSettled([
        this.activeWrite,
      ]);
      failed ||= writes.some(
        (write) =>
          write.status === "rejected" &&
          write.reason instanceof ProcessCleanupError,
      );
    }
    try {
      await this.terminate();
    } catch {
      failed = true;
    }
    if (this.attributes) {
      this.api.symbols.DeleteProcThreadAttributeList(ptr(this.attributes.list));
    }
    for (const handle of this.handles) {
      if (!this.api.symbols.CloseHandle(handle)) {
        failed = true;
      }
    }
    this.handles.clear();
    this.api.close();
    if (failed) {
      throw new ProcessCleanupError();
    }
  }
}

function emptyPipe(): OutputPipe {
  return {
    read: 0n,
    write: 0n,
    ended: false,
  };
}
