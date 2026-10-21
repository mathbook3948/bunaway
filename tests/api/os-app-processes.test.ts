import { expect, test } from "bun:test";
import os from "@bunaway/plugin-os";
import { BunawayError, NativeRegistry } from "@bunaway/protocol";
import {
  appProcessListSchema,
  MAX_APP_PROCESSES,
} from "#plugins/os/src/contract";
import { osOperations } from "#plugins/os/src/operations";
import {
  type AppProcessBindings,
  COUNTERS_WORKING_SET_OFFSET,
  ENTRY_IMAGE_OFFSET,
  ENTRY_PARENT_PID_OFFSET,
  ENTRY_PID_OFFSET,
  listAppProcesses,
  MAX_SNAPSHOT_ENTRIES,
  PROCESS_MEMORY_COUNTERS_BYTES,
  PROCESSENTRY32W_BYTES,
  type ProcessEntry,
  type ProcessMetrics,
  parseProcessEntry,
} from "#plugins/os/src/platforms/windows-app-processes";

const APP = 100;

function entry(pid: number, parentPid: number, image = "child.exe") {
  return {
    pid,
    parentPid,
    image,
  } satisfies ProcessEntry;
}

function metrics(creationTime: bigint, workingSetBytes = 1024) {
  return {
    creationTime,
    workingSetBytes,
    userMicros: 7,
    systemMicros: 3,
  } satisfies ProcessMetrics;
}

function fakeBindings(
  entries: ProcessEntry[],
  known: Record<number, ProcessMetrics> = {},
) {
  const queried: number[] = [];
  const bindings: AppProcessBindings = {
    snapshot: () => entries,
    metrics(pid) {
      queried.push(pid);
      return known[pid] ?? null;
    },
  };
  return {
    bindings,
    queried,
  };
}

function internal(run: () => unknown) {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(BunawayError);
    expect((error as BunawayError).code).toBe("INTERNAL");
    return;
  }
  throw new Error("expected an INTERNAL failure");
}

test("the PROCESSENTRY32W and PROCESS_MEMORY_COUNTERS offsets match the 64-bit layout", () => {
  // dwSize, cntUsage, th32ProcessID, then the ULONG_PTR heap ID aligned to 8.
  expect(ENTRY_PID_OFFSET).toBe(4 + 4);
  expect(ENTRY_PARENT_PID_OFFSET).toBe(ENTRY_PID_OFFSET + 4 + 4 + 8 + 4 + 4);
  // th32ParentProcessID, pcPriClassBase, dwFlags, then szExeFile.
  expect(ENTRY_IMAGE_OFFSET).toBe(ENTRY_PARENT_PID_OFFSET + 4 + 4 + 4);
  // szExeFile is WCHAR[260] and the structure is padded to 8 bytes.
  expect(PROCESSENTRY32W_BYTES).toBe(ENTRY_IMAGE_OFFSET + 260 * 2 + 4);
  // cb, PageFaultCount, PeakWorkingSetSize, then WorkingSetSize; nine fields in all.
  expect(COUNTERS_WORKING_SET_OFFSET).toBe(4 + 4 + 8);
  expect(PROCESS_MEMORY_COUNTERS_BYTES).toBe(4 + 4 + 8 * 8);
});

test("parseProcessEntry reads the IDs and image name and rejects an unterminated name", () => {
  const buffer = Buffer.alloc(PROCESSENTRY32W_BYTES);
  buffer.writeUInt32LE(41, ENTRY_PID_OFFSET);
  buffer.writeUInt32LE(7, ENTRY_PARENT_PID_OFFSET);
  buffer.write("msedgewebview2.exe\0", ENTRY_IMAGE_OFFSET, "utf16le");
  expect(parseProcessEntry(buffer)).toEqual({
    pid: 41,
    parentPid: 7,
    image: "msedgewebview2.exe",
  });
  buffer.write("x".repeat(260), ENTRY_IMAGE_OFFSET, "utf16le");
  internal(() => parseProcessEntry(buffer));
});

test("only descendants of the app process are listed, parents first and siblings by ID", () => {
  const { bindings } = fakeBindings(
    [
      entry(1, 0, "system.exe"),
      entry(APP, 1, "app.exe"),
      entry(300, APP),
      entry(200, APP),
      entry(400, 300),
      entry(500, 1),
      entry(600, 500),
    ],
    {
      [APP]: metrics(100n, 4096),
      200: metrics(200n, 2048),
    },
  );
  const processes = listAppProcesses(bindings, APP);
  expect(processes.map((process) => process.pid)).toEqual([
    APP,
    200,
    300,
    400,
  ]);
  expect(processes.map((process) => process.kind)).toEqual([
    "app",
    "other",
    "other",
    "other",
  ]);
  expect(processes[0]).toEqual({
    pid: APP,
    parentPid: 1,
    kind: "app",
    metrics: {
      workingSetBytes: 4096,
      cpuTime: {
        userMicros: 7,
        systemMicros: 3,
      },
    },
  });
  // A process that cannot be opened stays in the list with null metrics.
  expect(processes[1]?.metrics?.workingSetBytes).toBe(2048);
  expect(processes[2]?.metrics).toBeNull();
  expect(appProcessListSchema.parse(processes)).toEqual(processes);
});

test("WebView2 processes and their descendants are classified by image and ancestry", () => {
  const { bindings } = fakeBindings([
    entry(APP, 1, "app.exe"),
    entry(110, APP, "msedgewebview2.exe"),
    entry(111, 110, "MSEDGEWEBVIEW2.EXE"),
    entry(112, 110, "crashpad_handler.exe"),
    entry(120, APP, "helper.exe"),
    entry(121, 120, "tool.exe"),
    entry(122, 120, "msedgewebview2.exe"),
  ]);
  const kinds = Object.fromEntries(
    listAppProcesses(bindings, APP).map((process) => [
      process.pid,
      process.kind,
    ]),
  );
  expect(kinds).toEqual({
    [APP]: "app",
    110: "webview2",
    111: "webview2",
    112: "webview2",
    120: "other",
    121: "other",
    122: "webview2",
  });
});

test("a child created before its listed parent is a reused process ID and is dropped", () => {
  const { bindings } = fakeBindings(
    [
      entry(APP, 1),
      entry(200, APP),
      entry(300, APP),
      entry(400, 200),
    ],
    {
      [APP]: metrics(1000n),
      200: metrics(1500n),
      // Started before the app: the link to the app is stale.
      300: metrics(900n),
      // Started before its parent 200.
      400: metrics(1200n),
    },
  );
  expect(listAppProcesses(bindings, APP).map((process) => process.pid)).toEqual(
    [
      APP,
      200,
    ],
  );
});

test("parent cycles and self parents do not repeat or loop", () => {
  const { bindings } = fakeBindings([
    entry(APP, 200),
    entry(200, APP),
    entry(300, 300),
  ]);
  expect(listAppProcesses(bindings, APP).map((process) => process.pid)).toEqual(
    [
      APP,
      200,
    ],
  );
});

test("a missing app process, an oversized tree and an oversized snapshot are errors", () => {
  internal(() =>
    listAppProcesses(
      fakeBindings([
        entry(1, 0),
      ]).bindings,
      APP,
    ),
  );
  const full = [
    entry(APP, 1),
  ];
  for (let index = 1; index < MAX_APP_PROCESSES; index += 1) {
    full.push(entry(APP + index, APP));
  }
  expect(listAppProcesses(fakeBindings(full).bindings, APP).length).toBe(
    MAX_APP_PROCESSES,
  );
  full.push(entry(APP + MAX_APP_PROCESSES, APP));
  internal(() => listAppProcesses(fakeBindings(full).bindings, APP));
  expect(MAX_SNAPSHOT_ENTRIES).toBeGreaterThan(MAX_APP_PROCESSES);
});

test("listAppProcesses takes null, returns a validated shape and has its own permission", () => {
  expect(osOperations.listAppProcesses.input.parse(null)).toBeNull();
  expect(osOperations.listAppProcesses.input.safeParse({}).success).toBe(false);
  expect(
    osOperations.listAppProcesses.output.safeParse([
      {
        pid: 1,
        parentPid: 0,
        kind: "app",
        metrics: null,
        image: "app.exe",
      },
    ]).success,
  ).toBe(false);
  expect(
    osOperations.listAppProcesses.output.safeParse([
      {
        pid: 1,
        parentPid: 0,
        kind: "gpu",
        metrics: null,
      },
    ]).success,
  ).toBe(false);
  const registry = new NativeRegistry([
    os._definition,
  ]);
  const call = {
    operation: "os.listAppProcesses",
    payload: null,
  };
  const grant = (permissions: string[]) =>
    registry.allowed(
      {
        permissions,
      },
      call,
    );
  expect(
    grant([
      "os.listAppProcesses",
    ]),
  ).toBe(true);
  expect(
    grant([
      "os.usage",
      "os.listGpus",
    ]),
  ).toBe(false);
  expect(grant([])).toBe(false);
});
