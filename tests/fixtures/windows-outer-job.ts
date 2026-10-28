import { dlopen, ptr } from "bun:ffi";
import assert from "node:assert/strict";
import { rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  activeDescendants,
  containAppProcess,
  startOutsideAppJob,
} from "../../native/windows/bun/job.ts";
import { waitFor } from "./deadlines.ts";

/**
 * Runs as `launcher` or `host`. The launcher plays the part of a CI runner, service manager or
 * launcher program: it puts itself into an outer Job Object that forbids breakaway, starts the host
 * inside it and later closes the Job on request. The host is the real app Job owner from
 * `native/windows/bun/job.ts`; it publishes what it observed for the test to check from outside.
 */
const role = process.argv[2];
const root = process.argv[3] ?? "";
assert(root);

const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS = 9;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
const JOBOBJECT_EXTENDED_LIMIT_INFORMATION_BYTES = 144; // Win64
const JOB_LIMIT_FLAGS_OFFSET = 16;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

const api = dlopen("kernel32.dll", {
  CreateJobObjectW: {
    args: [
      "ptr",
      "ptr",
    ],
    returns: "u64",
  },
  SetInformationJobObject: {
    args: [
      "u64",
      "i32",
      "ptr",
      "u32",
    ],
    returns: "i32",
  },
  GetCurrentProcess: {
    args: [],
    returns: "u64",
  },
  AssignProcessToJobObject: {
    args: [
      "u64",
      "u64",
    ],
    returns: "i32",
  },
  IsProcessInJob: {
    args: [
      "u64",
      "u64",
      "ptr",
    ],
    returns: "i32",
  },
  OpenProcess: {
    args: [
      "u32",
      "i32",
      "u32",
    ],
    returns: "u64",
  },
  CloseHandle: {
    args: [
      "u64",
    ],
    returns: "i32",
  },
  GetLastError: {
    args: [],
    returns: "u32",
  },
});
function check(result: number | bigint, operation: string) {
  assert(result, `${operation} failed (Win32 ${api.symbols.GetLastError()}).`);
}

/** Publishes a file only once complete, so a reader never sees a partial write. */
async function publish(name: string, value: unknown) {
  const path = join(root, name);
  await Bun.write(`${path}.pending`, JSON.stringify(value));
  await rename(`${path}.pending`, path);
}

function fileExists(name: string) {
  return Bun.file(join(root, name))
    .exists()
    .then((found) => found || undefined);
}

async function runLauncher() {
  // No JOB_OBJECT_LIMIT_BREAKAWAY_OK: processes inside cannot break away, as in a locked-down
  // launcher or service. KILL_ON_JOB_CLOSE makes closing the handle the outer shutdown path.
  const outer = api.symbols.CreateJobObjectW(null, null);
  check(outer, "CreateJobObjectW");
  const limits = Buffer.alloc(JOBOBJECT_EXTENDED_LIMIT_INFORMATION_BYTES);
  limits.writeUInt32LE(
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOB_LIMIT_FLAGS_OFFSET,
  );
  check(
    api.symbols.SetInformationJobObject(
      outer,
      JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
      ptr(limits),
      limits.length,
    ),
    "SetInformationJobObject",
  );
  // The runner may already be inside its own Job; a failure here is a nested-Job defect to report.
  check(
    api.symbols.AssignProcessToJobObject(
      outer,
      api.symbols.GetCurrentProcess(),
    ),
    "AssignProcessToJobObject",
  );
  const host = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      resolve(import.meta.path),
      "host",
      root,
    ],
    {
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  const member = Buffer.alloc(4);
  const hostHandle = api.symbols.OpenProcess(
    PROCESS_QUERY_LIMITED_INFORMATION,
    0,
    host.pid,
  );
  check(hostHandle, "OpenProcess");
  try {
    check(
      api.symbols.IsProcessInJob(hostHandle, outer, ptr(member)),
      "IsProcessInJob",
    );
  } finally {
    api.symbols.CloseHandle(hostHandle);
  }
  assert.equal(
    member.readUInt32LE(),
    1,
    "The host started outside the outer Job.",
  );
  await publish("launcher.json", {
    hostPid: host.pid,
  });
  await waitFor(() => fileExists("close-outer"), {
    deadline: "childStep",
    what: "the request to close the outer Job",
  });
  // Closing the last handle kills every process in the Job, this launcher included.
  api.symbols.CloseHandle(outer);
}

async function runHost() {
  containAppProcess(resolve(root, "data"));
  const ready = resolve(import.meta.dir, "process-ready.ts");
  const backends = [
    1,
    2,
  ].map((index) => {
    const pidName = `backend-${index}.pid`;
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        ready,
        join(root, pidName),
      ],
      {
        stdout: "ignore",
        stderr: "inherit",
      },
    );
    return {
      pidName,
      child,
    };
  });
  for (const { pidName } of backends) {
    await waitFor(() => fileExists(pidName), {
      deadline: "childStep",
      what: "a backend child to publish its PID",
    });
  }
  const descendants = activeDescendants();
  // The outer Job forbids breakaway, so the relaunch path must report the refusal and start nothing.
  let refusal: string | undefined;
  try {
    startOutsideAppJob({
      executable: process.execPath,
      args: [
        "--no-env-file",
        ready,
        join(root, "outside.pid"),
      ],
      cwd: root,
      env: process.env,
    });
  } catch (error) {
    refusal = error instanceof Error ? error.message : String(error);
  }
  // The host keeps working after the refusal: its Job still contains the same descendants and
  // a child started afterwards is still contained.
  const afterRefusal = activeDescendants();
  const late = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      ready,
      join(root, "late.pid"),
    ],
    {
      stdout: "ignore",
      stderr: "inherit",
    },
  );
  await waitFor(() => fileExists("late.pid"), {
    deadline: "childStep",
    what: "the child started after the refusal",
  });
  await publish("host.json", {
    hostPid: process.pid,
    backendPids: backends.map(({ child }) => child.pid),
    latePid: late.pid,
    descendants,
    afterRefusal,
    afterLate: activeDescendants(),
    refusal,
  });
  await waitFor(() => fileExists("release"), {
    deadline: "childStep",
    what: "the test to end the host",
  });
}

try {
  if (role === "launcher") {
    await runLauncher();
  } else {
    assert.equal(role, "host");
    await runHost();
  }
} finally {
  api.close();
}
