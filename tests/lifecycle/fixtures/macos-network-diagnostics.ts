import { copyFile, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

type NetworkChild = Pick<
  ReturnType<typeof Bun.spawn>,
  "exitCode" | "exited" | "kill" | "killed"
>;
export type NetworkPipeCapture = Promise<
  [
    PromiseSettledResult<string>,
    PromiseSettledResult<string>,
  ]
>;

function capturedText(
  result: PromiseSettledResult<string> | undefined,
): string {
  if (!result) {
    return "";
  }
  return result.status === "fulfilled"
    ? result.value
    : `Pipe capture failed: ${String(result.reason)}\n`;
}

/**
 * Reap the fixture before awaiting its pipes, then retain evidence outside its
 * disposable package. Optional child/capture handles cover failures before launch.
 * The caller owns server shutdown and package removal after this completes.
 */
export async function retainNetworkDiagnostics(
  child: NetworkChild | undefined,
  capture: NetworkPipeCapture | undefined,
  dataRoot: string,
  destination: string,
  state: object,
) {
  const terminatedForDiagnostics = child?.exitCode === null && !child.killed;
  if (terminatedForDiagnostics) {
    child?.kill("SIGKILL");
  }
  const childExitStatus = child ? await child.exited : null;
  // Readers already drain concurrently; awaiting them while the child is alive
  // would hang when a missing report leaves the host and its pipes open.
  const captured = await capture;
  const stdout = capturedText(captured?.[0]);
  const stderr = capturedText(captured?.[1]);
  const log = Bun.file(resolve(dataRoot, "logs/host.log"));
  const hasHostLog = await log.exists();
  const hostLog = hasHostLog ? await log.text() : "No host log.\n";
  const report = resolve(dataRoot, "temp/report.json");
  const hasReport = await Bun.file(report).exists();
  // This fixture owns the directory. Do not leave a previous report beside a
  // new missing-report failure when the runner is reused locally.
  await rm(destination, {
    recursive: true,
    force: true,
  });
  await mkdir(destination, {
    recursive: true,
  });
  await Promise.all([
    Bun.write(resolve(destination, "host.log"), hostLog),
    Bun.write(resolve(destination, "stdout.log"), stdout),
    Bun.write(resolve(destination, "stderr.log"), stderr),
    Bun.write(
      resolve(destination, "network-state.json"),
      JSON.stringify(
        {
          ...state,
          childExitCode: child?.exitCode ?? null,
          childExitStatus,
          terminatedForDiagnostics,
          hasHostLog,
          hasReport,
          stdoutCapture: captured?.[0].status ?? "not-started",
          stderrCapture: captured?.[1].status ?? "not-started",
        },
        null,
        2,
      ),
    ),
    // Copy raw bytes, including an incomplete report, without hiding its state.
    ...(hasReport
      ? [
          copyFile(report, resolve(destination, "report.json")),
        ]
      : []),
  ]);
  return {
    hostLog,
    stdout,
    stderr,
  };
}
