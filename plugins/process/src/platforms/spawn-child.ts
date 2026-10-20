/** How a child ended; `signal` is null where the platform reports only a status code. */
export interface ChildExit {
  exitCode: number;
  signal: string | null;
}

/** A point-in-time view of a child: whether it ended and how much output waits to be taken. */
export interface ChildState {
  /** Null while the child runs. */
  exit: ChildExit | null;
  stdoutBytes: number;
  stderrBytes: number;
  /** Both output pipes reached end of file, so no more bytes will ever arrive. */
  outputEnded: boolean;
}

/** `closed` means the child no longer reads stdin, so the bytes were not delivered. */
export type WriteOutcome = "written" | "closed";

/**
 * One launched child and everything it owns: process tree containment, pipes and handles.
 * The owner must call `release` exactly when it is done; the call is safe to repeat.
 */
export interface SpawnedChild {
  readonly pid: number;
  /** Cheap and non-blocking. Detecting an exit also ends any remaining descendants. */
  state(): ChildState;
  /** Remove up to `count` buffered bytes, never more than `state()` reported for that stream. */
  take(stream: "stdout" | "stderr", count: number): Buffer;
  /**
   * Deliver all bytes to stdin, waiting while the pipe is full. Aborting `signal` cancels the
   * write; bytes accepted before the abort are not withdrawn.
   */
  write(bytes: Uint8Array, signal: AbortSignal): Promise<WriteOutcome>;
  /** Close stdin so the child sees end of file; repeating it does nothing. */
  closeStdin(): Promise<void>;
  /** Terminate the child and its descendants; repeating it, or calling it after exit, succeeds. */
  kill(): Promise<void>;
  /** Terminate whatever is left, wait for it, then free pipes and handles. */
  release(): Promise<void>;
}
