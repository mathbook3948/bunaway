import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * Drain both child pipes and retain their exact bytes before callers inspect exit or reports.
 * Each launch owns a separate directory so restart failures cannot replace earlier evidence.
 * Reject an externally terminated child even if its graceful shutdown returned zero.
 * The caller retains ownership of deadlines, termination and native resources.
 */
export async function captureNativeChild(
  child: Bun.Subprocess,
  directory: string,
  phase: string,
) {
  assert(
    child.stdout !== null &&
      typeof child.stdout !== "number" &&
      child.stderr !== null &&
      typeof child.stderr !== "number",
    "Native fixture diagnostics require piped stdout and stderr.",
  );
  const started = Date.now();
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).arrayBuffer(),
    child.exited,
  ]);
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
        elapsedMs: Date.now() - started,
      },
      null,
      2,
    )}\n`,
  );
  assert(
    !child.killed,
    `Native fixture was terminated before completion: ${phase} (exit ${exitCode}).`,
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
