import { attemptAllAsync } from "@bunaway/plugin";
import type { z } from "zod";
import type { spawnInputSchema } from "#process/contract";
import type {
  ChildState,
  SpawnedChild,
  WriteOutcome,
} from "#process/platforms/spawn-child";

type SpawnInput = z.output<typeof spawnInputSchema>;
type BunPipedChild = ReturnType<typeof spawnPiped>;
type PipeStream = BunPipedChild["stdout"];
type PipeReader = ReturnType<PipeStream[typeof Symbol.asyncIterator]>;

/** One output pipe read a chunk at a time, so an unread pipe blocks the child instead of queueing. */
class PulledPipe {
  private readonly reader: PipeReader;
  private chunk: Buffer = Buffer.alloc(0);
  private filling = false;
  ended = false;
  failure: unknown;

  constructor(stream: PipeStream) {
    this.reader = stream[Symbol.asyncIterator]();
    void this.fill();
  }

  get available() {
    return this.chunk.length;
  }

  take(count: number): Buffer {
    const bytes = Buffer.from(this.chunk.subarray(0, count));
    this.chunk = this.chunk.subarray(count);
    void this.fill();
    return bytes;
  }

  /** Read the next chunk only while nothing is buffered. A failure is kept and raised by the next `state`. */
  private async fill() {
    if (this.filling || this.ended || this.chunk.length > 0) {
      return;
    }
    this.filling = true;
    try {
      const result = await this.reader.next();
      if (result.done) {
        this.ended = true;
      } else {
        this.chunk = Buffer.from(result.value);
      }
    } catch (error) {
      this.failure = error;
      this.ended = true;
    } finally {
      this.filling = false;
    }
  }

  async close() {
    // Ending the iterator cancels the stream; a read in flight settles first, and the killed child closes its pipes.
    await this.reader.return?.();
  }
}

/**
 * Bun.spawn-backed child with the same pull interface as the Win32 child. It ends only the
 * direct child, so tests on other platforms cover the handle contract, not tree containment.
 */
class BunSpawnedChild implements SpawnedChild {
  private readonly pipes: Record<"stdout" | "stderr", PulledPipe>;
  private stdinOpen = true;
  private released: Promise<void> | undefined;

  constructor(private readonly child: BunPipedChild) {
    this.pipes = {
      stdout: new PulledPipe(child.stdout),
      stderr: new PulledPipe(child.stderr),
    };
  }

  get pid() {
    return this.child.pid;
  }

  state(): ChildState {
    for (const pipe of Object.values(this.pipes)) {
      if (pipe.failure !== undefined) {
        throw pipe.failure;
      }
    }
    const exited =
      this.child.exitCode !== null || this.child.signalCode !== null;
    const { stdout, stderr } = this.pipes;
    return {
      exit: exited
        ? {
            exitCode: this.child.exitCode ?? 1,
            signal: this.child.signalCode,
          }
        : null,
      stdoutBytes: stdout.available,
      stderrBytes: stderr.available,
      outputEnded:
        stdout.ended &&
        stderr.ended &&
        stdout.available === 0 &&
        stderr.available === 0,
    };
  }

  take(stream: "stdout" | "stderr", count: number): Buffer {
    return this.pipes[stream].take(count);
  }

  async write(bytes: Uint8Array, signal: AbortSignal): Promise<WriteOutcome> {
    if (!this.stdinOpen) {
      return "closed";
    }
    signal.throwIfAborted();
    const abandoned = new Promise<never>((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => {
          reject(signal.reason);
        },
        {
          once: true,
        },
      );
    });
    try {
      this.child.stdin.write(bytes);
      await Promise.race([
        this.child.stdin.flush(),
        abandoned,
      ]);
      return "written";
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      // The child closed its end, which Bun reports as a failed flush.
      return "closed";
    }
  }

  async closeStdin() {
    if (this.stdinOpen) {
      this.stdinOpen = false;
      await this.child.stdin.end();
    }
  }

  kill() {
    this.child.kill("SIGKILL");
    return Promise.resolve();
  }

  release() {
    this.released ??= this.performRelease();
    return this.released;
  }

  private async performRelease() {
    this.child.kill("SIGKILL");
    await attemptAllAsync(
      [
        () => this.closeStdin(),
        () => this.pipes.stdout.close(),
        () => this.pipes.stderr.close(),
        async () => {
          await this.child.exited;
        },
      ],
      "Spawned process cleanup failed.",
    );
  }
}

function spawnPiped(
  input: SpawnInput,
  env: Record<string, string> | undefined,
) {
  return Bun.spawn(
    [
      input.executablePath,
      ...input.args,
    ],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      // Without an override the child inherits the current environment.
      ...(env === undefined
        ? {}
        : {
            env,
          }),
      killSignal: "SIGKILL",
    },
  );
}

/** Launch a long-running child with Bun.spawn and wrap it in the pull interface. */
export function launchBunChild(
  input: SpawnInput,
  env?: Record<string, string>,
): SpawnedChild {
  return new BunSpawnedChild(spawnPiped(input, env));
}
