import { attemptAllAsync } from "@bunaway/plugin";
import { BunawayError } from "@bunaway/protocol";
import type {
  HandleInput,
  ReadInput,
  ReadResult,
  SpawnedProcesses,
  SpawnInput,
  SpawnResult,
  WriteInput,
} from "#process/contract";
import {
  EXITED_HANDLE_RETENTION_MS,
  MAX_SPAWNED_PROCESSES,
} from "#process/contract";
import type {
  SpawnedChild,
  WriteOutcome,
} from "#process/platforms/spawn-child";

const READ_POLL_INTERVAL_MS = 2;
const SWEEP_INTERVAL_MS = 1000;

interface Entry {
  /** The caller that created the handle; only that caller may use it. */
  readonly source: string;
  readonly child: SpawnedChild;
  reading: boolean;
  writing: boolean;
  /** Set when the exit was first observed, to age out handles nobody reads. */
  exitedAt: number | undefined;
  /** Release has started; the handle no longer resolves for callers. */
  ending: boolean;
  /** Which stream gets the leftover share of the next read that has data on both. */
  stderrLeads: boolean;
}

/**
 * Handles for children that outlive one call. The adapter owns every handle: it is usable
 * only by the caller that spawned it, is released once its exit has been read or has aged
 * out, and is released at disposal. Output is pulled, so a child that nobody reads blocks on
 * its full pipe instead of growing a queue here.
 */
export class SpawnedProcessTable implements SpawnedProcesses {
  private readonly entries = new Map<string, Entry>();
  private readonly launches = new Set<Promise<unknown>>();
  private readonly lifetime = new AbortController();
  private sweeper: ReturnType<typeof setInterval> | undefined;
  private sweepFailure: unknown;
  private disposed = false;

  /**
   * `launch` starts a child and must honor its signal while starting. `now` supplies the clock
   * for exited-handle retention only; waits use real time.
   */
  constructor(
    private readonly launch: (
      input: SpawnInput,
      signal: AbortSignal,
    ) => Promise<SpawnedChild>,
    private readonly now: () => number = Date.now,
  ) {}

  /** Launch a child and register its handle. */
  async spawn(
    source: string,
    input: SpawnInput,
    signal?: AbortSignal,
  ): Promise<SpawnResult> {
    this.requireOpen();
    if (this.entries.size + this.launches.size >= MAX_SPAWNED_PROCESSES) {
      throw new BunawayError({
        code: "BUSY",
        message: "Too many spawned processes.",
      });
    }
    const stop = this.stopSignal(signal);
    stop.throwIfAborted();
    const launching = this.launch(input, stop);
    this.launches.add(launching);
    let child: SpawnedChild;
    try {
      child = await launching;
    } finally {
      this.launches.delete(launching);
    }
    if (this.disposed) {
      await child.release();
      throw this.disposedError();
    }
    const handle = crypto.randomUUID();
    this.entries.set(handle, {
      source,
      child,
      reading: false,
      writing: false,
      exitedAt: undefined,
      ending: false,
      stderrLeads: false,
    });
    this.startSweeper();
    return {
      handle,
      pid: child.pid,
    };
  }

  /**
   * Take buffered output, waiting up to `waitMs` when there is none. Returns as soon as there
   * is any output or the child ended; the handle is released with the exit it reports.
   */
  async read(
    source: string,
    { handle, ...limits }: ReadInput,
    signal?: AbortSignal,
  ): Promise<ReadResult> {
    const entry = this.find(source, handle);
    if (entry.reading) {
      throw new BunawayError({
        code: "BUSY",
        message: "Process output is already being read.",
      });
    }
    entry.reading = true;
    try {
      const stop = this.stopSignal(signal);
      const deadline = Date.now() + limits.waitMs;
      while (true) {
        stop.throwIfAborted();
        const chunk = this.takeOutput(entry, limits.maxBytes);
        if (
          chunk.stdoutBase64 !== "" ||
          chunk.stderrBase64 !== "" ||
          chunk.exited
        ) {
          if (chunk.exited) {
            await this.end(handle, entry);
          }
          return chunk;
        }
        if (Date.now() >= deadline) {
          return chunk;
        }
        await Bun.sleep(READ_POLL_INTERVAL_MS);
      }
    } finally {
      entry.reading = false;
    }
  }

  /** Write all bytes, waiting while the pipe is full; aborting `signal` cancels only this write. */
  async write(
    source: string,
    { handle, dataBase64 }: WriteInput,
    signal?: AbortSignal,
  ): Promise<void> {
    const entry = this.find(source, handle);
    if (entry.writing) {
      throw new BunawayError({
        code: "BUSY",
        message: "Process input is already being written.",
      });
    }
    entry.writing = true;
    try {
      const stop = this.stopSignal(signal);
      const outcome: WriteOutcome = await entry.child.write(
        Buffer.from(dataBase64, "base64"),
        stop,
      );
      if (outcome === "closed") {
        // A cancelled or disposed call reports the cancellation, not the pipe it left behind:
        // disposal ends the tree first, so the broken pipe can be seen before the abort.
        stop.throwIfAborted();
        throw new BunawayError({
          code: "INVALID_ARGUMENT",
          message: "Process input is closed.",
        });
      }
    } finally {
      entry.writing = false;
    }
  }

  /** Close stdin after any write in progress; closing twice succeeds. Aborting `signal` stops the wait. */
  async closeStdin(
    source: string,
    { handle }: HandleInput,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.find(source, handle).child.closeStdin(this.stopSignal(signal));
  }

  /** End the child and its descendants; the exit is still reported by the next read. */
  async kill(source: string, { handle }: HandleInput): Promise<void> {
    await this.find(source, handle).child.kill();
  }

  /** Release handles whose exit stayed unread past the retention period. */
  async sweep(): Promise<void> {
    const now = this.now();
    const expired: [
      string,
      Entry,
    ][] = [];
    for (const [handle, entry] of this.entries) {
      if (entry.ending || entry.reading) {
        continue;
      }
      try {
        entry.exitedAt ??= entry.child.state().exit ? now : undefined;
      } catch {
        // A child whose state cannot be read can never report its exit; release it instead of
        // letting it hold a slot and block the other handles' sweep.
        expired.push([
          handle,
          entry,
        ]);
        continue;
      }
      if (
        entry.exitedAt !== undefined &&
        now - entry.exitedAt >= EXITED_HANDLE_RETENTION_MS
      ) {
        expired.push([
          handle,
          entry,
        ]);
      }
    }
    // Releases run one after another; mark them all first so no call can pick up a handle that is about to go.
    for (const [, entry] of expired) {
      entry.ending = true;
    }
    await attemptAllAsync(
      expired.map(
        ([handle, entry]) =>
          () =>
            this.end(handle, entry),
      ),
      "Spawned process cleanup failed.",
    );
  }

  /** Cancel pending calls and release every child, including its descendants. */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.lifetime.abort(this.disposedError());
    this.stopSweeper();
    await Promise.allSettled(this.launches);
    const failure = this.sweepFailure;
    await attemptAllAsync(
      [
        ...this.entries.entries(),
      ].map(
        ([handle, entry]) =>
          () =>
            this.end(handle, entry),
      ),
      "Spawned process cleanup failed.",
    );
    if (failure !== undefined) {
      throw failure;
    }
  }

  /** Own the failure of a background sweep until disposal can report it. */
  private startSweeper() {
    this.sweeper ??= setInterval(() => {
      this.sweep().catch((error: unknown) => {
        this.sweepFailure ??= error;
      });
    }, SWEEP_INTERVAL_MS);
    // An idle handle table must not keep the host alive.
    this.sweeper.unref();
  }

  private stopSweeper() {
    if (this.sweeper !== undefined) {
      clearInterval(this.sweeper);
      this.sweeper = undefined;
    }
  }

  private requireOpen() {
    if (this.disposed) {
      throw this.disposedError();
    }
  }

  private disposedError() {
    return new BunawayError({
      code: "CANCELLED",
      message: "Process adapter is disposed.",
    });
  }

  private stopSignal(signal: AbortSignal | undefined) {
    return signal
      ? AbortSignal.any([
          signal,
          this.lifetime.signal,
        ])
      : this.lifetime.signal;
  }

  /** Unknown handles and handles of another caller look the same, so existence is not disclosed. */
  private find(source: string, handle: string): Entry {
    const entry = this.entries.get(handle);
    if (!entry || entry.ending || entry.source !== source) {
      throw new BunawayError({
        code: "INVALID_ARGUMENT",
        message: "Unknown process handle.",
      });
    }
    return entry;
  }

  /**
   * Move buffered output out of the child. While both streams have data each keeps half of the
   * limit (rounded down) for itself and the leftover goes to whichever leads this read; the lead
   * alternates, so a chatty stream cannot starve the other even when `maxBytes` is 1.
   */
  private takeOutput(entry: Entry, maxBytes: number): ReadResult {
    const state = entry.child.state();
    if (state.exit) {
      entry.exitedAt ??= this.now();
    }
    const bothHaveData = state.stdoutBytes > 0 && state.stderrBytes > 0;
    const leadCount = (own: number, other: number) =>
      Math.min(own, maxBytes - Math.min(other, Math.floor(maxBytes / 2)));
    const followCount = (own: number, lead: number) =>
      Math.min(own, maxBytes - lead);
    let stdoutCount: number;
    let stderrCount: number;
    if (entry.stderrLeads) {
      stderrCount = leadCount(state.stderrBytes, state.stdoutBytes);
      stdoutCount = followCount(state.stdoutBytes, stderrCount);
    } else {
      stdoutCount = leadCount(state.stdoutBytes, state.stderrBytes);
      stderrCount = followCount(state.stderrBytes, stdoutCount);
    }
    if (bothHaveData) {
      entry.stderrLeads = !entry.stderrLeads;
    }
    const stdout = entry.child.take("stdout", stdoutCount);
    const stderr = entry.child.take("stderr", stderrCount);
    const drained =
      stdoutCount === state.stdoutBytes && stderrCount === state.stderrBytes;
    return {
      stdoutBase64: stdout.toString("base64"),
      stderrBase64: stderr.toString("base64"),
      exited: state.exit && state.outputEnded && drained ? state.exit : null,
    };
  }

  /** Release one child; the handle stays registered until the release finished, so disposal sees it. */
  private async end(handle: string, entry: Entry): Promise<void> {
    entry.ending = true;
    try {
      await entry.child.release();
    } finally {
      this.entries.delete(handle);
      if (this.entries.size === 0) {
        this.stopSweeper();
      }
    }
  }
}
