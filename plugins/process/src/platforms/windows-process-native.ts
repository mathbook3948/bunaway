import { ptr } from "bun:ffi";
import { win32CallError } from "@bunaway/plugin/win32";
import { BunawayError } from "@bunaway/protocol";
import type { z } from "zod";
import type { ProcessResult, processInputSchema } from "#process/contract";
import { openProcessBindings } from "#process/platforms/windows-process-bindings";

const INVALID_HANDLE_VALUE = 0xffffffffffffffffn;
const GENERIC_READ = 0x80000000;
const OPEN_EXISTING = 3;
const HANDLE_FLAG_INHERIT = 1;
const PIPE_ACCESS_OUTBOUND = 2;
const PIPE_REJECT_REMOTE_CLIENTS = 8;
const FILE_FLAG_FIRST_PIPE_INSTANCE = 0x00080000;
const FILE_FLAG_OVERLAPPED = 0x40000000;
const STARTF_USESTDHANDLES = 0x100;
const EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
const CREATE_NO_WINDOW = 0x08000000;
const CREATE_UNICODE_ENVIRONMENT = 0x00000400;
const PROC_THREAD_ATTRIBUTE_HANDLE_LIST = 0x20002n;
const PROC_THREAD_ATTRIBUTE_JOB_LIST = 0x2000dn;
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;
const JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION = 1;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
const ERROR_BROKEN_PIPE = 109;
const ERROR_NO_DATA = 232;
const ERROR_PIPE_CONNECTED = 535;
const ERROR_IO_PENDING = 997;
const ERROR_IO_INCOMPLETE = 996;
const ERROR_OPERATION_ABORTED = 995;
const ERROR_NOT_FOUND = 1168;
const ERROR_INSUFFICIENT_BUFFER = 122;
const WAIT_OBJECT_0 = 0;
const WAIT_TIMEOUT = 258;
const POLL_INTERVAL_MS = 2;
const CLEANUP_TIMEOUT_MS = 5000;
const PIPE_BUFFER_BYTES = 8192;

/** Cleanup failure must take precedence over the original cancellation reason. */
export class ProcessCleanupError extends BunawayError {
  constructor() {
    super({
      code: "INTERNAL",
      message: "Process cleanup failed.",
    });
  }
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
 * Create one invocation Job atomically with the child and own its complete lifetime.
 * The inherited host Job remains an ancestor; neither Job allows breakaway. Only
 * the three standard handles are inherited, never the invocation Job handle.
 */
export async function runWindowsProcess(
  input: z.output<typeof processInputSchema>,
  signal: AbortSignal,
): Promise<ProcessResult> {
  signal.throwIfAborted();
  const api = openProcessBindings();
  const handles = new Set<bigint>();
  let job = 0n;
  let child = 0n;
  let attributes:
    | {
        list: Buffer;
        values: Buffer[];
      }
    | undefined;
  let writer = 0n;
  let writePending = false;
  // These buffers remain alive until overlapped input has completed or been cancelled.
  const inputBytes = Buffer.from(input.stdinBase64 ?? "", "base64");
  const overlapped = Buffer.alloc(32); // OVERLAPPED, Win64
  const transferred = Buffer.alloc(4);
  const fail = (
    operation = "Win32 process operation",
    nativeCode = api.symbols.GetLastError(),
  ) => {
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
  };
  const requireSuccess = (result: number, operation?: string) => {
    if (!result) {
      throw fail(operation);
    }
  };
  const own = (handle: bigint) => {
    if (!handle || handle === INVALID_HANDLE_VALUE) {
      throw fail();
    }
    handles.add(handle);
    return handle;
  };
  const close = (handle: bigint) => {
    if (handles.has(handle)) {
      requireSuccess(api.symbols.CloseHandle(handle));
      handles.delete(handle);
    }
  };
  const inherit = (handle: bigint) =>
    requireSuccess(
      api.symbols.SetHandleInformation(
        handle,
        HANDLE_FLAG_INHERIT,
        HANDLE_FLAG_INHERIT,
      ),
    );
  const security = Buffer.alloc(24); // SECURITY_ATTRIBUTES, Win64
  security.writeUInt32LE(security.length, 0);
  security.writeUInt32LE(1, 16);
  const createOutput = () => {
    const pair = Buffer.alloc(16);
    requireSuccess(
      api.symbols.CreatePipe(
        ptr(pair),
        ptr(pair, 8),
        ptr(security),
        PIPE_BUFFER_BYTES,
      ),
    );
    const read = own(pair.readBigUInt64LE(0));
    const write = own(pair.readBigUInt64LE(8));
    requireSuccess(
      api.symbols.SetHandleInformation(read, HANDLE_FLAG_INHERIT, 0),
    );
    return {
      read,
      write,
      chunks: [] as Buffer[],
      bytes: 0,
      ended: false,
    };
  };
  const drain = (
    pipe: ReturnType<typeof createOutput>,
    budget: {
      bytes: number;
    },
  ) => {
    if (pipe.ended) {
      return;
    }
    const available = Buffer.alloc(4);
    const peekError = win32CallError(
      () =>
        api.symbols.PeekNamedPipe(
          pipe.read,
          null,
          0,
          null,
          ptr(available),
          null,
        ),
      () => api.symbols.GetLastError(),
    );
    if (peekError) {
      if (peekError !== ERROR_BROKEN_PIPE) {
        throw fail("Win32 process operation", peekError);
      }
      pipe.ended = true;
      return;
    }
    const count = Math.min(available.readUInt32LE(), PIPE_BUFFER_BYTES);
    if (!count) {
      return;
    }
    const bytes = Buffer.alloc(count);
    // We are the sole reader. Reading at most the peeked bytes cannot block.
    requireSuccess(
      api.symbols.ReadFile(
        pipe.read,
        ptr(bytes),
        count,
        ptr(transferred),
        null,
      ),
    );
    const readBytes = transferred.readUInt32LE();
    budget.bytes += readBytes;
    if (budget.bytes > input.maxOutputBytes) {
      throw new BunawayError({
        code: "INTERNAL",
        message: "Process output exceeds the limit.",
      });
    }
    pipe.bytes += readBytes;
    pipe.chunks.push(bytes.subarray(0, readBytes));
  };
  const writeFinished = () => {
    if (!writePending) {
      return true;
    }
    if (
      api.symbols.GetOverlappedResult(
        writer,
        ptr(overlapped),
        ptr(transferred),
        0,
      )
    ) {
      writePending = false;
      if (transferred.readUInt32LE() !== inputBytes.length) {
        throw fail();
      }
      return true;
    }
    const error = api.symbols.GetLastError();
    if (error === ERROR_IO_INCOMPLETE) {
      return false;
    }
    writePending = false;
    // A child may close stdin without consuming the input, matching Bun's pipe behavior.
    if (
      error !== ERROR_BROKEN_PIPE &&
      error !== ERROR_NO_DATA &&
      error !== ERROR_OPERATION_ABORTED
    ) {
      throw fail();
    }
    return true;
  };
  const stopInput = async () => {
    if (!writer) {
      return;
    }
    const cancellationFailed =
      writePending &&
      !api.symbols.CancelIoEx(writer, ptr(overlapped)) &&
      api.symbols.GetLastError() !== ERROR_NOT_FOUND;
    // CancelIoEx requests cancellation. The native buffer cannot be released until completion.
    while (!writeFinished()) {
      await Bun.sleep(POLL_INTERVAL_MS);
    }
    close(writer);
    writer = 0n;
    if (cancellationFailed) {
      throw new ProcessCleanupError();
    }
  };
  const terminate = async () => {
    if (!child) {
      return;
    }
    if (!api.symbols.TerminateJobObject(job, 1)) {
      throw new ProcessCleanupError();
    }
    const accounting = Buffer.alloc(48); // JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, Win64
    const deadline = Date.now() + CLEANUP_TIMEOUT_MS;
    while (true) {
      if (
        !api.symbols.QueryInformationJobObject(
          job,
          JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION,
          ptr(accounting),
          accounting.length,
          null,
        )
      ) {
        throw new ProcessCleanupError();
      }
      const state = api.symbols.WaitForSingleObject(child, 0);
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
  };
  const release = async () => {
    let failed = false;
    try {
      await terminate();
    } catch {
      failed = true;
    }
    try {
      await stopInput();
    } catch {
      failed = true;
    }
    if (attributes) {
      api.symbols.DeleteProcThreadAttributeList(ptr(attributes.list));
    }
    // Close every handle even if termination or a preceding close failed. The
    // non-inherited kill-on-close Job remains the final failure fallback.
    for (const handle of handles) {
      if (!api.symbols.CloseHandle(handle)) {
        failed = true;
      }
    }
    api.close();
    if (failed) {
      throw new ProcessCleanupError();
    }
  };
  /** Opens stdin: NUL without input, otherwise a private overlapped pipe whose write end becomes `writer`. */
  const openStdin = (): bigint => {
    if (input.stdinBase64 === undefined) {
      const name = Buffer.from("NUL\0", "utf16le");
      return own(
        api.symbols.CreateFileW(
          ptr(name),
          GENERIC_READ,
          0,
          ptr(security),
          OPEN_EXISTING,
          0,
          0n,
        ),
      );
    } else {
      // A private named pipe permits overlapped writes. An anonymous WriteFile
      // could block the Worker forever if the child never consumes its stdin.
      const name = Buffer.from(
        `\\\\.\\pipe\\bunaway-process-${crypto.randomUUID()}\0`,
        "utf16le",
      );
      writer = own(
        api.symbols.CreateNamedPipeW(
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
      const stdin = own(
        api.symbols.CreateFileW(
          ptr(name),
          GENERIC_READ,
          0,
          null,
          OPEN_EXISTING,
          0,
          0n,
        ),
      );
      inherit(stdin);
      if (
        !api.symbols.ConnectNamedPipe(writer, ptr(overlapped)) &&
        api.symbols.GetLastError() !== ERROR_PIPE_CONNECTED
      ) {
        throw fail();
      }
      return stdin;
    }
  };
  /** Restricts inheritance to the standard handles and places the child in the invocation Job. */
  const buildAttributeList = (
    stdin: bigint,
    stdout: ReturnType<typeof createOutput>,
    stderr: ReturnType<typeof createOutput>,
  ): Buffer => {
    const size = Buffer.alloc(8);
    api.symbols.InitializeProcThreadAttributeList(null, 2, 0, ptr(size));
    if (api.symbols.GetLastError() !== ERROR_INSUFFICIENT_BUFFER) {
      throw fail();
    }
    const attributeBytes = Number(size.readBigUInt64LE());
    if (attributeBytes <= 0 || attributeBytes > 65536) {
      throw fail();
    }
    const list = Buffer.alloc(attributeBytes);
    requireSuccess(
      api.symbols.InitializeProcThreadAttributeList(ptr(list), 2, 0, ptr(size)),
    );
    attributes = {
      list,
      values: [],
    };
    const standardHandles = Buffer.alloc(24);
    standardHandles.writeBigUInt64LE(stdin, 0);
    standardHandles.writeBigUInt64LE(stdout.write, 8);
    standardHandles.writeBigUInt64LE(stderr.write, 16);
    const jobs = Buffer.alloc(8);
    jobs.writeBigUInt64LE(job);
    // Win32 retains the value pointers until DeleteProcThreadAttributeList.
    // Keep their buffers reachable through the attribute owner across later allocations.
    attributes.values.push(standardHandles, jobs);
    requireSuccess(
      api.symbols.UpdateProcThreadAttribute(
        ptr(list),
        0,
        PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
        ptr(standardHandles),
        BigInt(standardHandles.length),
        null,
        null,
      ),
    );
    requireSuccess(
      api.symbols.UpdateProcThreadAttribute(
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
  };
  /** Creates the child inside the invocation Job and returns its pid, owning the process and thread handles. */
  const startChild = (
    list: Buffer,
    stdin: bigint,
    stdout: ReturnType<typeof createOutput>,
    stderr: ReturnType<typeof createOutput>,
  ): number => {
    const startup = Buffer.alloc(112); // STARTUPINFOEXW, Win64
    startup.writeUInt32LE(startup.length, 0);
    startup.writeUInt32LE(STARTF_USESTDHANDLES, 60);
    startup.writeBigUInt64LE(stdin, 80);
    startup.writeBigUInt64LE(stdout.write, 88);
    startup.writeBigUInt64LE(stderr.write, 96);
    startup.writeBigUInt64LE(BigInt(ptr(list)), 104);
    const information = Buffer.alloc(24); // PROCESS_INFORMATION, Win64
    const executable = Buffer.from(`${input.executablePath}\0`, "utf16le");
    const commandLine = Buffer.from(
      `${[
        input.executablePath,
        ...input.args,
      ]
        .map(quoteArgument)
        .join(" ")}\0`,
      "utf16le",
    );
    const environment = runnerEnvironment();
    signal.throwIfAborted();
    // JOB_LIST makes assignment part of creation. Failure never launches an
    // uncontained child; host crashes cannot leave a suspended, unassigned process.
    requireSuccess(
      api.symbols.CreateProcessW(
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
    child = own(information.readBigUInt64LE(0));
    const thread = own(information.readBigUInt64LE(8));
    const pid = information.readUInt32LE(16);
    api.symbols.DeleteProcThreadAttributeList(ptr(list));
    attributes = undefined;
    close(thread);
    close(stdin);
    close(stdout.write);
    close(stderr.write);
    return pid;
  };
  /** Submits the stdin bytes with an overlapped write; the pipe closes at once if nothing is pending. */
  const startInput = async () => {
    if (writer) {
      if (inputBytes.length) {
        overlapped.fill(0);
        if (
          !api.symbols.WriteFile(
            writer,
            ptr(inputBytes),
            inputBytes.length,
            ptr(transferred),
            ptr(overlapped),
          )
        ) {
          const error = api.symbols.GetLastError();
          if (error === ERROR_IO_PENDING) {
            writePending = true;
          } else if (error !== ERROR_BROKEN_PIPE && error !== ERROR_NO_DATA) {
            throw fail();
          }
        }
      }
      if (!writePending) {
        await stopInput();
      }
    }
  };
  /** Polls output pipes and the child until it exits and both pipes end, then returns the result. */
  const collect = async (
    pid: number,
    stdout: ReturnType<typeof createOutput>,
    stderr: ReturnType<typeof createOutput>,
  ): Promise<ProcessResult> => {
    const budget = {
      bytes: 0,
    };
    let exitCode: number | undefined;
    while (true) {
      signal.throwIfAborted();
      drain(stdout, budget);
      drain(stderr, budget);
      if (writer && writeFinished()) {
        await stopInput();
      }
      if (exitCode === undefined) {
        const state = api.symbols.WaitForSingleObject(child, 0);
        if (state === WAIT_OBJECT_0) {
          const code = Buffer.alloc(4);
          requireSuccess(api.symbols.GetExitCodeProcess(child, ptr(code)));
          exitCode = code.readUInt32LE();
          // A foreground invocation ends with its root. Reap grandchildren
          // before waiting for EOF from standard pipes they may have inherited.
          await terminate();
          await stopInput();
        } else if (state !== WAIT_TIMEOUT) {
          throw fail();
        }
      }
      if (exitCode !== undefined && stdout.ended && stderr.ended) {
        signal.throwIfAborted();
        return {
          pid,
          exitCode,
          signal: null,
          stdoutBase64: Buffer.concat(stdout.chunks, stdout.bytes).toString(
            "base64",
          ),
          stderrBase64: Buffer.concat(stderr.chunks, stderr.bytes).toString(
            "base64",
          ),
        };
      }
      await Bun.sleep(POLL_INTERVAL_MS);
    }
  };
  try {
    job = own(api.symbols.CreateJobObjectW(null, null));
    const limits = Buffer.alloc(144); // JOBOBJECT_EXTENDED_LIMIT_INFORMATION, Win64
    limits.writeUInt32LE(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, 16);
    requireSuccess(
      api.symbols.SetInformationJobObject(
        job,
        JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
        ptr(limits),
        limits.length,
      ),
    );
    const stdout = createOutput();
    const stderr = createOutput();
    const stdin = openStdin();
    const list = buildAttributeList(stdin, stdout, stderr);
    const pid = startChild(list, stdin, stdout, stderr);
    await startInput();
    return await collect(pid, stdout, stderr);
  } finally {
    // A failed cleanup intentionally takes precedence over completion/cancellation.
    await release();
  }
}
