import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  type AppHandle,
  baselineProbeSource,
  directorySize,
  GO_MARKER,
  measureBaseline,
  measureRun,
  type ProcessRow,
  parseProcessTable,
  processTree,
  READY_MARKER,
  type RunDriver,
  type RunOptions,
  summarize,
  summarizeRuns,
} from "../../scripts/measure-baseline.ts";
import { deadline } from "../fixtures/deadlines.ts";

setDefaultTimeout(deadline("inProcess"));

const OPTIONS: RunOptions = {
  idleMs: 1_000,
  readyTimeoutMs: 10_000,
  resultTimeoutMs: 10_000,
};
const ROUND_TRIPS = 200;

function row(
  pid: number,
  parentPid: number,
  workingSetBytes = 100,
): ProcessRow {
  return {
    pid,
    parentPid,
    workingSetBytes,
  };
}

/**
 * A driver on a virtual clock: `sleep` advances time, the app writes its ready marker `readyAfterMs`
 * after launch (never when undefined) and its result once released.
 */
function fakeDriver(options: {
  readyAfterMs?: number;
  table?: ProcessRow[];
  result?: string;
  /** Reads of the result that see only its first half, as when a read lands mid-write. */
  partialResultReads?: number;
}) {
  let clock = 0;
  let launchedAt: number | undefined;
  let marker: string | undefined;
  let partialReadsLeft = options.partialResultReads ?? 0;
  const calls: string[] = [];
  const handle: AppHandle = {
    pid: 10,
    kill() {
      calls.push("kill");
    },
  };
  const driver: RunDriver = {
    now: () => clock,
    async sleep(milliseconds) {
      clock += milliseconds;
    },
    launch() {
      calls.push("launch");
      launchedAt = clock;
      return handle;
    },
    async readMarker() {
      if (
        options.readyAfterMs !== undefined &&
        launchedAt !== undefined &&
        marker === undefined &&
        clock >= launchedAt + options.readyAfterMs
      ) {
        marker = READY_MARKER;
      }
      if (marker?.startsWith("{") && partialReadsLeft > 0) {
        partialReadsLeft -= 1;
        return marker.slice(0, Math.floor(marker.length / 2));
      }
      return marker;
    },
    async writeMarker(text) {
      calls.push(`write:${text}`);
      marker = text === GO_MARKER ? (options.result ?? "") : text;
    },
    async processTable() {
      calls.push("table");
      return (
        options.table ?? [
          row(10, 1, 50),
          row(11, 10, 30),
          row(12, 11, 20),
          row(99, 1, 1_000),
        ]
      );
    },
  };
  return {
    driver,
    calls,
  };
}

const goodResult = JSON.stringify({
  commandRoundTripMs: Array.from(
    {
      length: ROUND_TRIPS,
    },
    (_, index) => (index === 7 ? 9 : 1 + (index % 3)),
  ),
});

test("summarize reports the median of odd and even counts with the minimum and maximum", () => {
  expect(
    summarize([
      5,
      1,
      3,
    ]),
  ).toEqual({
    median: 3,
    min: 1,
    max: 5,
  });
  expect(
    summarize([
      4,
      1,
      2,
      9,
    ]),
  ).toEqual({
    median: 3,
    min: 1,
    max: 9,
  });
  expect(() => summarize([])).toThrow("empty");
});

test("processTree sums only the launcher's descendants and survives a reused process id", () => {
  const tree = processTree(
    [
      row(99, 1),
      row(12, 11),
      row(10, 1),
      row(11, 10),
      // A stale row that reuses the root's pid under a descendant must not loop.
      row(10, 12),
    ],
    10,
  );
  expect(tree.map((entry) => entry.pid).sort((a, b) => a - b)).toEqual([
    10,
    11,
    12,
  ]);
  expect(
    processTree(
      [
        row(1, 0),
      ],
      10,
    ),
  ).toEqual([]);
});

test("parseProcessTable accepts a list or a single object and rejects incomplete rows", () => {
  const entry = {
    ProcessId: 4,
    ParentProcessId: 1,
    WorkingSetSize: 2048,
  };
  const expected = row(4, 1, 2048);
  expect(
    parseProcessTable(
      JSON.stringify([
        entry,
      ]),
    ),
  ).toEqual([
    expected,
  ]);
  expect(parseProcessTable(JSON.stringify(entry))).toEqual([
    expected,
  ]);
  expect(() =>
    parseProcessTable(
      JSON.stringify([
        {
          ProcessId: 4,
        },
      ]),
    ),
  ).toThrow("Unexpected process table row");
});

test("measureRun records start time, tree memory and command timings, then stops the app once", async () => {
  const { driver, calls } = fakeDriver({
    readyAfterMs: 120,
    result: goodResult,
  });
  const sample = await measureRun(driver, OPTIONS);
  // The poll interval is 5 ms, so readiness is seen on the first poll at or after 120 ms.
  expect(sample.startupMs).toBeGreaterThanOrEqual(120);
  expect(sample.startupMs).toBeLessThan(130);
  expect(sample.idleWorkingSetBytes).toBe(100);
  expect(sample.idleProcessCount).toBe(3);
  expect(sample.commandMedianMs).toBe(2);
  expect(sample.commandMaxMs).toBe(9);
  // The probe is released only after the memory sample, and the app is stopped last.
  expect(calls).toEqual([
    "launch",
    "table",
    `write:${GO_MARKER}`,
    "kill",
  ]);
});

test("measureRun waits for a result that is still being written instead of failing to parse it", async () => {
  const { driver } = fakeDriver({
    readyAfterMs: 0,
    result: goodResult,
    partialResultReads: 3,
  });
  const sample = await measureRun(driver, OPTIONS);
  expect(sample.commandMaxMs).toBe(9);
});

test("measureRun reports the unfinished result when it never becomes complete JSON", async () => {
  const { driver, calls } = fakeDriver({
    readyAfterMs: 0,
    result: goodResult,
    partialResultReads: Number.POSITIVE_INFINITY,
  });
  await expect(measureRun(driver, OPTIONS)).rejects.toThrow(
    /waiting for the probe's command timings\..*not complete JSON/,
  );
  expect(calls.at(-1)).toBe("kill");
});

test("measureRun stops the app and names the wait when the app never answers", async () => {
  const { driver, calls } = fakeDriver({});
  await expect(measureRun(driver, OPTIONS)).rejects.toThrow(
    "waiting for the app's first command",
  );
  expect(calls).toEqual([
    "launch",
    "kill",
  ]);
});

test("measureRun rejects a result without the expected number of round trips", async () => {
  const { driver, calls } = fakeDriver({
    readyAfterMs: 0,
    result: JSON.stringify({
      commandRoundTripMs: [
        1,
      ],
    }),
  });
  await expect(measureRun(driver, OPTIONS)).rejects.toThrow(
    "200 finite round-trip times",
  );
  expect(calls.at(-1)).toBe("kill");
});

test("measureRun reports a launcher missing from the process table and still stops it", async () => {
  const { driver, calls } = fakeDriver({
    readyAfterMs: 0,
    table: [
      row(99, 1),
    ],
  });
  await expect(measureRun(driver, OPTIONS)).rejects.toThrow(
    "Process 10 was not in the process table",
  );
  expect(calls).toEqual([
    "launch",
    "table",
    "kill",
  ]);
});

test("summarizeRuns summarizes each metric across runs", () => {
  const sample = (startupMs: number) => ({
    startupMs,
    idleWorkingSetBytes: startupMs * 10,
    idleProcessCount: 3,
    commandMedianMs: 1,
    commandMaxMs: startupMs,
  });
  const summary = summarizeRuns([
    sample(300),
    sample(100),
    sample(200),
  ]);
  expect(summary.startupMs).toEqual({
    median: 200,
    min: 100,
    max: 300,
  });
  expect(summary.idleProcessCount).toEqual({
    median: 3,
    min: 3,
    max: 3,
  });
});

test("directorySize counts the bytes and files of nested directories", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "bunaway-baseline-size-"));
  try {
    await mkdir(resolve(directory, "assets/web"), {
      recursive: true,
    });
    await writeFile(resolve(directory, "app.exe"), "12345");
    await writeFile(resolve(directory, "assets/web/index.html"), "123");
    expect(await directorySize(directory)).toEqual({
      bytes: 8,
      files: 2,
    });
  } finally {
    await rm(directory, {
      recursive: true,
      force: true,
    });
  }
});

test("the probe is valid TypeScript that uses the markers the driver expects", () => {
  const source = baselineProbeSource();
  new Bun.Transpiler({
    loader: "ts",
  }).transformSync(source);
  expect(source).toContain(JSON.stringify(READY_MARKER));
  expect(source).toContain(JSON.stringify(GO_MARKER));
  expect(source).toContain("commandRoundTripMs");
});

test.skipIf(process.platform === "win32")(
  "measureBaseline refuses to run outside Windows",
  async () => {
    await expect(
      measureBaseline({
        packageRoot: "unused",
        appId: "app.unused",
        runs: 1,
        idleMs: 0,
      }),
    ).rejects.toThrow("Windows only");
  },
);
