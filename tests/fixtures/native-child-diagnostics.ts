import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const TERMINATION_GRACE_MS = 5_000;

/** Keep a partial byte-for-byte capture when a timed-out process leaves a pipe open. */
function capturePipe(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let finished = false;
  const done = (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          return Buffer.concat(chunks);
        }
        chunks.push(value);
      }
    } finally {
      finished = true;
      reader.releaseLock();
    }
  })();
  return {
    done,
    get finished() {
      return finished;
    },
    async cancel() {
      if (!finished) {
        await reader.cancel();
      }
    },
  };
}

/**
 * Drain both child pipes and retain their exact bytes before callers inspect exit or reports.
 * Each launch owns a separate directory so restart failures cannot replace earlier evidence.
 * Record deadline termination before sending its signal, even if shutdown returns zero.
 * After a five-second cleanup grace, force termination and cancel inherited open pipes.
 * A cancelled pipe is explicitly marked as truncated; bytes already received remain intact.
 * The caller retains ownership of native resources and cleanup after other failures.
 */
export async function captureNativeChild(
  child: Bun.Subprocess,
  directory: string,
  phase: string,
  timeoutMs?: number,
) {
  assert(
    child.stdout !== null &&
      typeof child.stdout !== "number" &&
      child.stderr !== null &&
      typeof child.stderr !== "number",
    "Native fixture diagnostics require piped stdout and stderr.",
  );
  const started = Date.now();
  const output = capturePipe(child.stdout);
  const errors = capturePipe(child.stderr);
  let timedOut = false;
  let forcedTermination = false;
  let outputTruncated = false;
  let forceStop: ReturnType<typeof setTimeout> | undefined;
  let cancellations: Promise<PromiseSettledResult<void>[]> = Promise.resolve(
    [],
  );
  const deadline =
    timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          if (child.exitCode === null) {
            child.kill("SIGTERM");
          }
          forceStop = setTimeout(() => {
            if (child.exitCode === null) {
              forcedTermination = true;
              child.kill("SIGKILL");
            }
            outputTruncated = !output.finished || !errors.finished;
            cancellations = Promise.allSettled([
              output.cancel(),
              errors.cancel(),
            ]);
          }, TERMINATION_GRACE_MS);
        }, timeoutMs);
  const completed = Promise.all([
    output.done,
    errors.done,
    child.exited,
  ]);
  const [stdout, stderr, exitCode] = await completed.finally(() => {
    clearTimeout(deadline);
    clearTimeout(forceStop);
  });
  const cancellationErrors = (await cancellations).flatMap((result) =>
    result.status === "rejected"
      ? [
          String(result.reason),
        ]
      : [],
  );
  await mkdir(directory, {
    recursive: true,
  });
  await writeFile(resolve(directory, "stdout.log"), new Uint8Array(stdout));
  await writeFile(resolve(directory, "stderr.log"), new Uint8Array(stderr));
  await writeFile(
    resolve(directory, "child.json"),
    `${JSON.stringify(
      {
        phase,
        pid: child.pid,
        exitCode,
        signal: child.signalCode,
        killed: child.killed,
        timedOut,
        forcedTermination,
        outputTruncated,
        cancellationErrors,
        timeoutMs,
        elapsedMs: Date.now() - started,
      },
      null,
      2,
    )}\n`,
  );
  assert(
    !timedOut,
    `Native fixture deadline expired before completion: ${phase} (exit ${exitCode}).`,
  );
  return {
    exitCode,
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
  };
}

/** Print retained child output and host phases on failure without replacing the primary error. */
export async function printNativeChildDiagnostics(
  directory: string,
  dataRoot: string,
): Promise<void> {
  for (const path of [
    resolve(directory, "child.json"),
    resolve(directory, "stdout.log"),
    resolve(directory, "stderr.log"),
    resolve(dataRoot, "logs/host.log"),
  ]) {
    try {
      const file = Bun.file(path);
      if (await file.exists()) {
        console.error(
          `Native fixture diagnostics: ${path}\n${await file.text()}`,
        );
      }
    } catch (error) {
      console.error(
        `Could not read native fixture diagnostics: ${path}`,
        error,
      );
    }
  }
}
