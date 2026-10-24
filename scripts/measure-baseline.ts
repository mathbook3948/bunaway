/**
 * Records baseline measurements of a built Windows app: start time, idle memory, package size and
 * command round-trip latency. The numbers are a record for later comparison, never a pass/fail
 * gate, because shared runners vary too much for a threshold to be stable.
 *
 * Usage (Windows x64 only, against the output of `bunaway build`):
 *   bun scripts/measure-baseline.ts --package <dist/windows-x64> --app-id <appId> [--runs 5] [--out <file>]
 *
 * The built app must run `baselineProbeSource()` in its UI. Definitions, all in the units named by
 * the field suffix:
 * - `startupMs`: from the moment the launcher process is created to the moment the probe's first
 *   `message.save` has been written to storage. It covers the launcher, the Bun runtime, the
 *   WebView2 load, the SDK channel and one completed command, so it is the time until the app can
 *   do useful work, not the time until a window appears.
 * - `idleWorkingSetBytes`: the sum of `WorkingSetSize` over the launcher and every descendant
 *   (backend, WebView2 processes), sampled `idleMs` after `startupMs`. The only traffic then is the probe's
 *   `message.read` poll every 100 ms, waiting for its release. Pages shared
 *   between WebView2 processes are counted once per process, so this is an upper bound on the
 *   tree's physical memory.
 * - `commandMedianMs` and `commandMaxMs`: round trips of the template's `message.read` command
 *   from the WebView through the SDK channel to the backend, which reads one file through the
 *   host. The template has no empty command, so this includes that one storage read. Warm-up
 *   round trips are discarded.
 * - `packageBytes` and `executableBytes`: the file sizes of the build output directory and of the
 *   app's executable.
 */
import { readdir, rm, stat, writeFile } from "node:fs/promises";
import { arch, cpus, release, totalmem } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { failWithCleanup, ResourceOwner } from "@bunaway/plugin";
import { isRecord } from "@bunaway/protocol";

/** Text the probe stores once the app answered its first command. */
export const READY_MARKER = "baseline-ready";
/** Text the measurement driver stores to release the probe after the memory sample. */
export const GO_MARKER = "baseline-go";
const DEFAULT_RUNS = 5;
const DEFAULT_IDLE_MS = 5_000;
const COMMAND_WARMUP_ROUND_TRIPS = 20;
const COMMAND_ROUND_TRIPS = 200;
const READY_TIMEOUT_MS = 60_000;
const RESULT_TIMEOUT_MS = 60_000;
const PROCESS_TABLE_TIMEOUT_MS = 30_000;
/** `taskkill` exit code when the process is already gone. */
const TASKKILL_PROCESS_NOT_FOUND = 128;
const POLL_INTERVAL_MS = 5;
const PROBE_POLL_INTERVAL_MS = 100;

/** One process of the machine's process table. */
export interface ProcessRow {
  pid: number;
  parentPid: number;
  workingSetBytes: number;
}

/** A launched app that the driver can stop. */
export interface AppHandle {
  pid: number;
  /** Stops the app and every descendant; safe to call after the app exited. */
  kill(): void;
}

/** Everything one run needs from its environment, so tests can run it without Windows. */
export interface RunDriver {
  now(): number;
  sleep(milliseconds: number): Promise<void>;
  launch(): AppHandle;
  readMarker(): Promise<string | undefined>;
  writeMarker(text: string): Promise<void>;
  processTable(): Promise<ProcessRow[]>;
}

export interface RunSample {
  startupMs: number;
  idleWorkingSetBytes: number;
  idleProcessCount: number;
  commandMedianMs: number;
  commandMaxMs: number;
}

export interface Summary {
  median: number;
  min: number;
  max: number;
}

export interface RunOptions {
  idleMs: number;
  readyTimeoutMs: number;
  resultTimeoutMs: number;
}

/**
 * Source appended to the template's `src/main.ts`. After its first command succeeds it waits for
 * the driver to release it by polling `message.read` every 100 ms, so the timed round trips never
 * overlap the memory sample. It then times round trips and stores them as JSON for the driver.
 */
export function baselineProbeSource(): string {
  return `
import { client as baselineClient } from "./client.ts";
await baselineClient.invoke("message.save", ${JSON.stringify(READY_MARKER)});
while ((await baselineClient.invoke("message.read", null)) !== ${JSON.stringify(GO_MARKER)}) {
  await new Promise((done) => setTimeout(done, ${PROBE_POLL_INTERVAL_MS}));
}
const commandRoundTripMs: number[] = [];
for (let index = 0; index < ${COMMAND_WARMUP_ROUND_TRIPS + COMMAND_ROUND_TRIPS}; index++) {
  const startedAt = performance.now();
  await baselineClient.invoke("message.read", null);
  if (index >= ${COMMAND_WARMUP_ROUND_TRIPS}) {
    commandRoundTripMs.push(performance.now() - startedAt);
  }
}
await baselineClient.invoke("message.save", JSON.stringify({ commandRoundTripMs }));
`;
}

/** The median, minimum and maximum of a non-empty list; the median of an even count is the mean of the middle pair. */
export function summarize(values: readonly number[]): Summary {
  const sorted = [
    ...values,
  ].sort((left, right) => left - right);
  const [min] = sorted;
  const max = sorted.at(-1);
  if (min === undefined || max === undefined) {
    throw new Error("Cannot summarize an empty list of measurements.");
  }
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1
      ? (sorted[middle] ?? min)
      : ((sorted[middle - 1] ?? min) + (sorted[middle] ?? max)) / 2;
  return {
    median,
    min,
    max,
  };
}

/** The root process and all its descendants, however the table is ordered. */
export function processTree(
  rows: readonly ProcessRow[],
  rootPid: number,
): ProcessRow[] {
  const byParent = new Map<number, ProcessRow[]>();
  for (const row of rows) {
    byParent.set(row.parentPid, [
      ...(byParent.get(row.parentPid) ?? []),
      row,
    ]);
  }
  const root = rows.find((row) => row.pid === rootPid);
  if (!root) {
    return [];
  }
  // Process ids are reused, so a stale row can point back at an ancestor; visit each pid once.
  const seen = new Set<number>([
    root.pid,
  ]);
  const tree = [
    root,
  ];
  for (const row of tree) {
    for (const child of byParent.get(row.pid) ?? []) {
      if (!seen.has(child.pid)) {
        seen.add(child.pid);
        tree.push(child);
      }
    }
  }
  return tree;
}

/** Polls `probe` until it yields a value, naming `what` when `timeoutMs` passes first. */
async function pollUntil<T>(
  driver: RunDriver,
  what: string,
  timeoutMs: number,
  probe: () => Promise<T | undefined>,
): Promise<T> {
  const limit = driver.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) {
      return value;
    }
    if (driver.now() >= limit) {
      throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}.`);
    }
    await driver.sleep(POLL_INTERVAL_MS);
  }
}

/**
 * Whether `text` is a whole JSON document. The host writes the marker file in place, so a read that
 * lands mid-write sees a truncated prefix; the driver keeps polling until the write finished.
 */
function isCompleteJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** Reads the probe's JSON result and returns its round-trip times. */
function parseRoundTrips(text: string): number[] {
  const parsed: unknown = JSON.parse(text);
  const times = isRecord(parsed) ? parsed.commandRoundTripMs : undefined;
  if (
    !Array.isArray(times) ||
    times.length !== COMMAND_ROUND_TRIPS ||
    !times.every((time) => typeof time === "number" && Number.isFinite(time))
  ) {
    throw new Error(
      `The probe result must hold ${COMMAND_ROUND_TRIPS} finite round-trip times.`,
    );
  }
  return times;
}

/**
 * Launches the app once and measures it. The app is stopped on every path: after a failure the
 * original error is rethrown together with any failure to stop it.
 */
export async function measureRun(
  driver: RunDriver,
  options: RunOptions,
): Promise<RunSample> {
  const owner = new ResourceOwner("Stopping the measured app failed.");
  try {
    const startedAt = driver.now();
    const app = owner.acquire(
      () => driver.launch(),
      (launched) => launched.kill(),
    );
    await pollUntil(
      driver,
      "the app's first command",
      options.readyTimeoutMs,
      async () =>
        (await driver.readMarker()) === READY_MARKER ? true : undefined,
    );
    const startupMs = driver.now() - startedAt;
    await driver.sleep(options.idleMs);
    const tree = processTree(await driver.processTable(), app.pid);
    if (tree.length === 0) {
      throw new Error(`Process ${app.pid} was not in the process table.`);
    }
    await driver.writeMarker(GO_MARKER);
    const roundTrips = parseRoundTrips(
      await pollUntil(
        driver,
        "the probe's command timings",
        options.resultTimeoutMs,
        async () => {
          const text = await driver.readMarker();
          return text?.startsWith("{") && isCompleteJson(text)
            ? text
            : undefined;
        },
      ),
    );
    const timings = summarize(roundTrips);
    const sample = {
      startupMs,
      idleWorkingSetBytes: tree.reduce(
        (sum, row) => sum + row.workingSetBytes,
        0,
      ),
      idleProcessCount: tree.length,
      commandMedianMs: timings.median,
      commandMaxMs: timings.max,
    };
    owner.dispose();
    return sample;
  } catch (error) {
    failWithCleanup(
      error,
      () => owner.dispose(),
      "Stopping the measured app failed.",
    );
  }
}

/** The byte size of every file below `directory`, summed, plus the file count. */
export async function directorySize(directory: string): Promise<{
  bytes: number;
  files: number;
}> {
  let bytes = 0;
  let files = 0;
  for (const entry of await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (entry.isFile()) {
      bytes += (await stat(resolve(entry.parentPath, entry.name))).size;
      files += 1;
    }
  }
  return {
    bytes,
    files,
  };
}

export interface BaselineReport {
  format: 1;
  environment: {
    platform: string;
    osRelease: string;
    arch: string;
    bun: string;
    cpuCount: number;
    totalMemoryBytes: number;
    runner: string;
  };
  options: RunOptions & {
    runs: number;
    commandRoundTripsPerRun: number;
    commandWarmupRoundTrips: number;
  };
  package: {
    bytes: number;
    files: number;
    executableBytes: number;
  };
  runs: RunSample[];
  summary: Record<keyof RunSample, Summary>;
}

/** Per-metric summaries over the runs of one measurement session. */
export function summarizeRuns(
  runs: readonly RunSample[],
): BaselineReport["summary"] {
  return {
    startupMs: summarize(runs.map((run) => run.startupMs)),
    idleWorkingSetBytes: summarize(runs.map((run) => run.idleWorkingSetBytes)),
    idleProcessCount: summarize(runs.map((run) => run.idleProcessCount)),
    commandMedianMs: summarize(runs.map((run) => run.commandMedianMs)),
    commandMaxMs: summarize(runs.map((run) => run.commandMaxMs)),
  };
}

/** Parses the PowerShell JSON listing of `Win32_Process` rows into the process table. */
export function parseProcessTable(json: string): ProcessRow[] {
  const parsed: unknown = JSON.parse(json);
  const rows = Array.isArray(parsed)
    ? parsed
    : [
        parsed,
      ];
  return rows.map((row) => {
    if (
      !isRecord(row) ||
      typeof row.ProcessId !== "number" ||
      typeof row.ParentProcessId !== "number" ||
      typeof row.WorkingSetSize !== "number"
    ) {
      throw new Error("Unexpected process table row.");
    }
    return {
      pid: row.ProcessId,
      parentPid: row.ParentProcessId,
      workingSetBytes: row.WorkingSetSize,
    };
  });
}

/** Reads `Win32_Process` through Windows PowerShell, which every supported Windows ships. */
async function readWindowsProcessTable(): Promise<ProcessRow[]> {
  const child = Bun.spawn(
    [
      "powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize | ConvertTo-Json -Compress",
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      // A hung query must fail the run so the measured app is still stopped.
      timeout: PROCESS_TABLE_TIMEOUT_MS,
      killSignal: "SIGKILL",
    },
  );
  const [output, errors, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) {
    throw new Error(`Reading the process table failed (${code}): ${errors}`);
  }
  return parseProcessTable(output);
}

/** The driver for a built Windows app whose probe stores its markers in `markerPath`. */
function windowsDriver(executable: string, markerPath: string): RunDriver {
  return {
    now: () => performance.now(),
    sleep: (milliseconds) => Bun.sleep(milliseconds),
    launch() {
      const child = Bun.spawn(
        [
          executable,
        ],
        {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        },
      );
      return {
        pid: child.pid,
        kill() {
          // The launcher owns Bun and WebView2 children; stop the whole tree.
          const result = Bun.spawnSync([
            "taskkill",
            "/PID",
            String(child.pid),
            "/T",
            "/F",
          ]);
          if (
            result.exitCode !== 0 &&
            result.exitCode !== TASKKILL_PROCESS_NOT_FOUND
          ) {
            throw new Error(
              `taskkill failed (${result.exitCode}): ${result.stderr.toString()}`,
            );
          }
        },
      };
    },
    async readMarker() {
      const file = Bun.file(markerPath);
      return (await file.exists()) ? await file.text() : undefined;
    },
    async writeMarker(text) {
      await writeFile(markerPath, text);
    },
    processTable: readWindowsProcessTable,
  };
}

/** Measures the built package `runs` times and returns the report. */
export async function measureBaseline(options: {
  packageRoot: string;
  appId: string;
  runs: number;
  idleMs: number;
}): Promise<BaselineReport> {
  if (process.platform !== "win32") {
    throw new Error("Baseline measurements run on Windows only.");
  }
  const executable = resolve(options.packageRoot, `${options.appId}.exe`);
  const markerPath = resolve(
    process.env.LOCALAPPDATA ?? "",
    "bunaway",
    options.appId,
    "data/messages/current.txt",
  );
  const runOptions: RunOptions = {
    idleMs: options.idleMs,
    readyTimeoutMs: READY_TIMEOUT_MS,
    resultTimeoutMs: RESULT_TIMEOUT_MS,
  };
  const runs: RunSample[] = [];
  for (let run = 0; run < options.runs; run++) {
    // A marker left by an earlier run would look like this run's readiness.
    await rm(markerPath, {
      force: true,
    });
    runs.push(
      await measureRun(windowsDriver(executable, markerPath), runOptions),
    );
  }
  const size = await directorySize(options.packageRoot);
  return {
    format: 1,
    environment: {
      platform: process.platform,
      osRelease: release(),
      arch: arch(),
      bun: Bun.version,
      cpuCount: cpus().length,
      totalMemoryBytes: totalmem(),
      runner: process.env.ImageOS ?? process.env.RUNNER_NAME ?? "local",
    },
    options: {
      ...runOptions,
      runs: options.runs,
      commandRoundTripsPerRun: COMMAND_ROUND_TRIPS,
      commandWarmupRoundTrips: COMMAND_WARMUP_ROUND_TRIPS,
    },
    package: {
      ...size,
      executableBytes: (await stat(executable)).size,
    },
    runs,
    summary: summarizeRuns(runs),
  };
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      package: {
        type: "string",
      },
      "app-id": {
        type: "string",
      },
      runs: {
        type: "string",
        default: String(DEFAULT_RUNS),
      },
      "idle-ms": {
        type: "string",
        default: String(DEFAULT_IDLE_MS),
      },
      out: {
        type: "string",
      },
    },
  });
  if (!values.package || !values["app-id"]) {
    throw new Error("Pass --package <directory> and --app-id <appId>.");
  }
  const runs = Number(values.runs);
  const idleMs = Number(values["idle-ms"]);
  if (!Number.isInteger(runs) || runs < 1) {
    throw new Error("--runs must be a positive integer.");
  }
  if (!Number.isFinite(idleMs) || idleMs < 0) {
    throw new Error("--idle-ms must be a non-negative number.");
  }
  const report = await measureBaseline({
    packageRoot: resolve(values.package),
    appId: values["app-id"],
    runs,
    idleMs,
  });
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (values.out) {
    await writeFile(resolve(values.out), text);
  }
  console.log(text);
}
