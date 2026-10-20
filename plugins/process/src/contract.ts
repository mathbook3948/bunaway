import { base64Schema } from "@bunaway/plugin";
import { z } from "zod";
/** Combined captured stdout/stderr and input limits, before base64 expansion. */
export const MAX_PROCESS_BYTES = 64 * 1024;
/** Children `spawn` keeps alive at once for one adapter; independent of the foreground `run` limit. */
export const MAX_SPAWNED_PROCESSES = 4;
/** Longest one `read` call may wait for output or exit. */
export const MAX_READ_WAIT_MS = 10_000;
/** An exited child nobody reads is released after this long. */
export const EXITED_HANDLE_RETENTION_MS = 60_000;
const MAX_COMMAND_LINE_UNITS = 32766;
const MAX_MACOS_ARGV_BYTES = 256 * 1024;
const base64 = base64Schema(MAX_PROCESS_BYTES);
const argument = z
  .string()
  .max(4096)
  .refine(
    (value) => !value.includes("\0"),
    "NUL is not an argument character.",
  );
/** A lone surrogate becomes U+FFFD when encoded for exec, so the child would see a different string. */
const hasLoneSurrogate = (value: string) => /\p{Surrogate}/u.test(value);
const windowsExecutablePath = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => {
    // Use an absolute drive path, never PATH lookup, UNC shares, device names or batch scripts.
    return (
      /^[A-Za-z]:[\\/]/.test(value) &&
      /\.exe$/i.test(value) &&
      !value.slice(2).includes(":") &&
      !Array.from(value).some(
        (char) => char.charCodeAt(0) < 0x20 || char === '"',
      ) &&
      !value
        .split(/[\\/]/)
        .some(
          (part) =>
            part === "." ||
            part === ".." ||
            part.endsWith(" ") ||
            part.endsWith("."),
        )
    );
  }, "Expected an absolute local Windows .exe path.");
const macosExecutablePath = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => {
    // Use an absolute POSIX path, never PATH lookup or a relative path; directories are rejected at spawn.
    // A lone surrogate would be replaced with U+FFFD when encoded, so the executed path would differ.
    return (
      !hasLoneSurrogate(value) &&
      value.startsWith("/") &&
      !Array.from(value).some((char) => {
        const code = char.charCodeAt(0);
        // C0 controls, DEL and C1 controls.
        return code < 0x20 || (code >= 0x7f && code <= 0x9f);
      }) &&
      !value
        .slice(1)
        .split("/")
        .some((part) => part === "" || part === "." || part === "..")
    );
  }, "Expected an absolute POSIX executable path.");
const inputFields = {
  args: z.array(argument).max(128).default([]),
  stdinBase64: base64.exactOptional(),
  maxOutputBytes: z
    .number()
    .int()
    .min(0)
    .max(MAX_PROCESS_BYTES)
    .default(MAX_PROCESS_BYTES),
  timeoutMs: z.number().int().min(1).max(30_000).default(30_000),
};
/** A conservative quoted argv bound also allows doubled backslashes before quotes and at the end. */
const fitsWindowsCommandLine = (input: {
  executablePath: string;
  args: string[];
}) => {
  const units =
    input.executablePath.length +
    2 +
    input.args.reduce((length, arg) => length + 3 + arg.length * 2, 0);
  return units <= MAX_COMMAND_LINE_UNITS;
};
/** One bounded foreground invocation. Applications authorize the executable and complete argv. */
export const processInputSchema = z
  .strictObject({
    executablePath: windowsExecutablePath,
    ...inputFields,
  })
  .refine(
    fitsWindowsCommandLine,
    "Arguments exceed the Windows command-line limit.",
  );
/** The macOS invocation validates paths and arguments against exec encoding and its argument-size bound. */
export const macosProcessInputSchema = z
  .strictObject({
    executablePath: macosExecutablePath,
    ...inputFields,
    args: z
      .array(
        argument.refine(
          (value) => !hasLoneSurrogate(value),
          "Unpaired surrogates cannot be encoded for exec.",
        ),
      )
      .max(128)
      .default([]),
  })
  .refine((input) => {
    // execve rejects argv plus environment above ARG_MAX (1 MiB); keep the argv share well below it.
    const bytes = [
      input.executablePath,
      ...input.args,
    ].reduce(
      (total, arg) => total + new TextEncoder().encode(arg).byteLength + 1,
      0,
    );
    return bytes <= MAX_MACOS_ARGV_BYTES;
  }, "Arguments exceed the macOS exec argument limit.");
/**
 * A long-running child: the same executable and argv rules as `process.run`, without the
 * stdin, output and time bounds that belong to one foreground call.
 */
export const spawnInputSchema = z
  .strictObject({
    executablePath: windowsExecutablePath,
    args: inputFields.args,
  })
  .refine(
    fitsWindowsCommandLine,
    "Arguments exceed the Windows command-line limit.",
  );
const handle = z.uuid();
export const spawnResultSchema = z.strictObject({
  handle,
  pid: z.number().int().positive(),
});
export const readInputSchema = z.strictObject({
  handle,
  maxBytes: z
    .number()
    .int()
    .min(1)
    .max(MAX_PROCESS_BYTES)
    .default(MAX_PROCESS_BYTES),
  waitMs: z.number().int().min(0).max(MAX_READ_WAIT_MS).default(0),
});
export const exitSchema = z.strictObject({
  exitCode: z.number().int().min(-0x80000000).max(0xffffffff),
  signal: z.string().max(32).nullable(),
});
export const readResultSchema = z.strictObject({
  stdoutBase64: base64,
  stderrBase64: base64,
  /** Present once the child ended and every output byte has been returned; the handle is then gone. */
  exited: exitSchema.nullable(),
});
export const writeInputSchema = z.strictObject({
  handle,
  dataBase64: base64,
});
export const handleInputSchema = z.strictObject({
  handle,
});
export const emptyResultSchema = z.strictObject({});
export const processResultSchema = z.strictObject({
  pid: z.number().int().positive(),
  exitCode: z.number().int().min(-0x80000000).max(0xffffffff),
  signal: z.string().max(32).nullable(),
  stdoutBase64: base64,
  stderrBase64: base64,
});
/** Caller input for one foreground process execution. */
export type ProcessInput = z.input<typeof processInputSchema>;
/** Captured process completion with exact binary stdout and stderr. */
export type ProcessResult = z.output<typeof processResultSchema>;
export type SpawnInput = z.output<typeof spawnInputSchema>;
export type SpawnResult = z.output<typeof spawnResultSchema>;
export type ReadInput = z.output<typeof readInputSchema>;
export type ReadResult = z.output<typeof readResultSchema>;
export type WriteInput = z.output<typeof writeInputSchema>;
export type HandleInput = z.output<typeof handleInputSchema>;
/**
 * Children that outlive one call, addressed by handle. A handle belongs to the `source` that
 * spawned it; any other source gets the same error as for a handle that does not exist.
 */
export interface SpawnedProcesses {
  /** Start a child. Fails with BUSY at `MAX_SPAWNED_PROCESSES`, which also counts exited children not yet read. */
  spawn(
    source: string,
    input: SpawnInput,
    signal?: AbortSignal,
  ): Promise<SpawnResult>;
  /**
   * Take output produced so far, waiting up to `waitMs` when there is none. `exited` appears
   * once the child ended and its last output byte was returned, and releases the handle.
   * A second read at the same time fails with BUSY.
   */
  read(
    source: string,
    input: ReadInput,
    signal?: AbortSignal,
  ): Promise<ReadResult>;
  /** Write all bytes, waiting while the pipe is full. Aborting `signal` cancels only this write. */
  write(source: string, input: WriteInput, signal?: AbortSignal): Promise<void>;
  /** Close stdin after a write in progress; closing twice succeeds. Aborting `signal` stops the wait. */
  closeStdin(
    source: string,
    input: HandleInput,
    signal?: AbortSignal,
  ): Promise<void>;
  /** End the child and its descendants; repeating it succeeds and the exit stays readable. */
  kill(source: string, input: HandleInput): Promise<void>;
  /** End every child, cancel pending calls and refuse new work. */
  dispose(): Promise<void>;
}
/** Adapter state shared by every platform: owned invocations, spawned children and the disposal flag. */
export interface ProcessInstance {
  readonly active: Map<AbortController, Promise<ProcessResult>>;
  readonly spawned: SpawnedProcesses;
  disposed: boolean;
}
