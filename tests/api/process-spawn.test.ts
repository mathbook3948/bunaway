import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import processes from "@bunaway/plugin-process";
import { NativeRegistry } from "@bunaway/protocol";
import {
  EXITED_HANDLE_RETENTION_MS,
  MAX_SPAWNED_PROCESSES,
} from "#plugins/process/src/contract";
import { processOperations } from "#plugins/process/src/operations";
import { launchBunChild } from "#plugins/process/src/platforms/bun-child";
import type { SpawnedChild } from "#plugins/process/src/platforms/spawn-child";
import { SpawnedProcessTable } from "#plugins/process/src/platforms/spawn-table";
import { dispose, initialize } from "#plugins/process/src/platforms/windows";
import { deadline, waitFor } from "../fixtures/deadlines.ts";
import {
  closeStdin,
  kill,
  read,
  spawn,
  write,
} from "../fixtures/process-spawn.ts";

// These tests drive the handle contract through Bun.spawn children. Job Object containment
// and the Win32 pipes are exercised by tests/lifecycle/windows-process.test.ts on Windows.
setDefaultTimeout(deadline("childStep"));

const SOURCE = "view:main";
const OTHER_SOURCE = "view:other";
const BUN = process.execPath;
/** Copies stdin to stdout until it closes, then reports on stderr and exits with code 3. */
const ECHO = `
  for await (const chunk of Bun.stdin.stream()) process.stdout.write(chunk);
  process.stderr.write("closed");
  process.exit(3);
`;
const SLEEP = "setInterval(() => {}, 1000);";

const instances: ReturnType<typeof initialize>[] = [];

function fresh() {
  const instance = initialize();
  instances.push(instance);
  return instance;
}

afterEach(async () => {
  await Promise.all(instances.splice(0).map((instance) => dispose(instance)));
});

function start(
  instance: ReturnType<typeof initialize>,
  script: string,
  source = SOURCE,
) {
  return spawn(
    instance,
    {
      executablePath: BUN,
      args: [
        "--no-env-file",
        "-e",
        script,
      ],
    },
    source,
  );
}

/** Read until the exit is reported, collecting all output. */
async function readToExit(
  instance: ReturnType<typeof initialize>,
  handle: string,
  source = SOURCE,
) {
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  const exited = await waitFor(
    async () => {
      const chunk = await read(
        instance,
        {
          handle,
          maxBytes: 65536,
          waitMs: 100,
        },
        source,
      );
      stdout = Buffer.concat([
        stdout,
        Buffer.from(chunk.stdoutBase64, "base64"),
      ]);
      stderr = Buffer.concat([
        stderr,
        Buffer.from(chunk.stderrBase64, "base64"),
      ]);
      return chunk.exited ?? undefined;
    },
    {
      deadline: "childStep",
      what: "the spawned process to report its exit",
    },
  );
  return {
    stdout,
    stderr,
    exited,
  };
}

const unknownHandle = {
  code: "INVALID_ARGUMENT",
  message: "Unknown process handle.",
};

test("spawn operations are registered, separately granted and take only an executable and argv", () => {
  expect(Object.keys(processOperations).sort()).toEqual([
    "closeStdin",
    "kill",
    "read",
    "run",
    "spawn",
    "write",
  ]);
  const schema = processOperations.spawn.input;
  expect(
    schema.parse({
      executablePath: "C:/tools/server.exe",
    }),
  ).toEqual({
    executablePath: "C:/tools/server.exe",
    args: [],
  });
  for (const executablePath of [
    "bun",
    "C:relative.exe",
    "C:/x.cmd",
    "\\\\server\\share\\x.exe",
    "C:/dir/../x.exe",
  ]) {
    expect(
      schema.safeParse({
        executablePath,
      }).success,
    ).toBe(false);
  }
  // Foreground bounds, input, environment and working directory do not exist for a handle.
  for (const extra of [
    {
      stdinBase64: "",
    },
    {
      timeoutMs: 1000,
    },
    {
      maxOutputBytes: 1,
    },
    {
      env: {},
    },
    {
      cwd: "C:/",
    },
  ]) {
    expect(
      schema.safeParse({
        executablePath: "C:/tools/server.exe",
        ...extra,
      }).success,
    ).toBe(false);
  }
  expect(
    schema.safeParse({
      executablePath: "C:/tools/server.exe",
      args: Array(128).fill("a".repeat(4096)),
    }).success,
  ).toBe(false);
  const handle = crypto.randomUUID();
  expect(
    processOperations.read.input.parse({
      handle,
    }),
  ).toEqual({
    handle,
    maxBytes: 65536,
    waitMs: 0,
  });
  for (const invalid of [
    {
      handle: "1",
    },
    {
      handle,
      maxBytes: 0,
    },
    {
      handle,
      maxBytes: 65537,
    },
    {
      handle,
      waitMs: 10001,
    },
    {
      handle,
      waitMs: -1,
    },
  ]) {
    expect(processOperations.read.input.safeParse(invalid).success).toBe(false);
  }
  expect(
    processOperations.write.input.safeParse({
      handle,
      dataBase64: Buffer.alloc(65537).toString("base64"),
    }).success,
  ).toBe(false);
  const registry = new NativeRegistry([
    processes._definition,
  ]);
  for (const operation of [
    "spawn",
    "read",
    "write",
    "closeStdin",
    "kill",
  ]) {
    const call = {
      operation: `process.${operation}`,
      payload: null,
    };
    expect(
      registry.allowed(
        {
          permissions: [
            "process.run",
          ],
        },
        call,
      ),
    ).toBe(false);
    expect(
      registry.allowed(
        {
          permissions: [
            `process.${operation}`,
          ],
        },
        call,
      ),
    ).toBe(true);
  }
});

test("a child's stdin, stdout, stderr and exit status round trip through its handle", async () => {
  const instance = fresh();
  const { handle, pid } = await start(instance, ECHO);
  expect(pid).toBeGreaterThan(0);
  await write(
    instance,
    {
      handle,
      dataBase64: Buffer.from("hello ").toString("base64"),
    },
    SOURCE,
  );
  await write(
    instance,
    {
      handle,
      dataBase64: Buffer.from("world").toString("base64"),
    },
    SOURCE,
  );
  await closeStdin(
    instance,
    {
      handle,
    },
    SOURCE,
  );
  // Closing stdin twice succeeds.
  await closeStdin(
    instance,
    {
      handle,
    },
    SOURCE,
  );
  const { stdout, stderr, exited } = await readToExit(instance, handle);
  expect(stdout.toString()).toBe("hello world");
  expect(stderr.toString()).toBe("closed");
  expect(exited).toEqual({
    exitCode: 3,
    signal: null,
  });
});

test("the exit is reported once and releases the handle", async () => {
  const instance = fresh();
  const { handle } = await start(instance, "process.exit(0)");
  await readToExit(instance, handle);
  await expect(
    read(
      instance,
      {
        handle,
        maxBytes: 1,
        waitMs: 0,
      },
      SOURCE,
    ),
  ).rejects.toMatchObject(unknownHandle);
  // The slot is free again.
  const next = await start(instance, "process.exit(0)");
  await readToExit(instance, next.handle);
});

test("a handle works only for the source that created it, and a stranger learns nothing", async () => {
  const instance = fresh();
  const { handle } = await start(instance, SLEEP);
  const missing = crypto.randomUUID();
  for (const attempt of [
    () =>
      read(
        instance,
        {
          handle,
          maxBytes: 1,
          waitMs: 0,
        },
        OTHER_SOURCE,
      ),
    () =>
      write(
        instance,
        {
          handle,
          dataBase64: "",
        },
        OTHER_SOURCE,
      ),
    () =>
      closeStdin(
        instance,
        {
          handle,
        },
        OTHER_SOURCE,
      ),
    () =>
      kill(
        instance,
        {
          handle,
        },
        OTHER_SOURCE,
      ),
    () =>
      kill(
        instance,
        {
          handle: missing,
        },
        SOURCE,
      ),
  ]) {
    await expect(attempt()).rejects.toMatchObject(unknownHandle);
  }
  // The owner is unaffected.
  await kill(
    instance,
    {
      handle,
    },
    SOURCE,
  );
  expect((await readToExit(instance, handle)).exited?.exitCode).not.toBe(0);
});

test("kill ends the child, may be repeated, and the exit is still read", async () => {
  const instance = fresh();
  const { handle } = await start(instance, SLEEP);
  await kill(
    instance,
    {
      handle,
    },
    SOURCE,
  );
  await kill(
    instance,
    {
      handle,
    },
    SOURCE,
  );
  const { exited } = await readToExit(instance, handle);
  expect(exited).not.toBeNull();
  expect(exited?.signal === "SIGKILL" || exited?.exitCode !== 0).toBe(true);
});

test("a read with nothing to return waits up to waitMs, then returns empty without releasing the handle", async () => {
  const instance = fresh();
  const { handle } = await start(instance, SLEEP);
  const began = Date.now();
  const chunk = await read(
    instance,
    {
      handle,
      maxBytes: 65536,
      waitMs: 150,
    },
    SOURCE,
  );
  expect(Date.now() - began).toBeGreaterThanOrEqual(140);
  expect(chunk).toEqual({
    stdoutBase64: "",
    stderrBase64: "",
    exited: null,
  });
  // Still usable.
  await kill(
    instance,
    {
      handle,
    },
    SOURCE,
  );
});

test("a read returns as soon as output arrives instead of waiting out waitMs", async () => {
  const instance = fresh();
  const { handle } = await start(
    instance,
    'process.stdout.write("ready"); setInterval(() => {}, 1000);',
  );
  const began = Date.now();
  let received = "";
  while (received.length < 5) {
    const chunk = await read(
      instance,
      {
        handle,
        maxBytes: 65536,
        waitMs: 10_000,
      },
      SOURCE,
    );
    received += Buffer.from(chunk.stdoutBase64, "base64").toString();
  }
  expect(received).toBe("ready");
  expect(Date.now() - began).toBeLessThan(5000);
});

test("only one read and one write run at a time per handle", async () => {
  const instance = fresh();
  const { handle } = await start(instance, SLEEP);
  const first = read(
    instance,
    {
      handle,
      maxBytes: 1,
      waitMs: 300,
    },
    SOURCE,
  );
  await expect(
    read(
      instance,
      {
        handle,
        maxBytes: 1,
        waitMs: 0,
      },
      SOURCE,
    ),
  ).rejects.toMatchObject({
    code: "BUSY",
  });
  await first;
  await kill(
    instance,
    {
      handle,
    },
    SOURCE,
  );
});

test("a read is cancelled by its signal and the handle survives", async () => {
  const instance = fresh();
  const { handle } = await start(instance, SLEEP);
  const controller = new AbortController();
  const pending = read(
    instance,
    {
      handle,
      maxBytes: 1,
      waitMs: 10_000,
    },
    SOURCE,
    controller.signal,
  );
  controller.abort(new Error("stop"));
  await expect(pending).rejects.toThrow("stop");
  await kill(
    instance,
    {
      handle,
    },
    SOURCE,
  );
});

test("writing after stdin closed is refused", async () => {
  const instance = fresh();
  const { handle } = await start(instance, SLEEP);
  await closeStdin(
    instance,
    {
      handle,
    },
    SOURCE,
  );
  await expect(
    write(
      instance,
      {
        handle,
        dataBase64: Buffer.from("x").toString("base64"),
      },
      SOURCE,
    ),
  ).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
    message: "Process input is closed.",
  });
  await kill(
    instance,
    {
      handle,
    },
    SOURCE,
  );
});

test("an unread pipe blocks the child instead of queueing output, and every byte arrives once read", async () => {
  const instance = fresh();
  const total = 4 * 1024 * 1024;
  const { handle } = await start(
    instance,
    `process.stdout.write(Buffer.alloc(${total}, 97), () => process.exit(0))`,
  );
  // Without reads the child cannot finish: no exit is observable and the adapter buffers at most one chunk.
  await Bun.sleep(300);
  const first = await read(
    instance,
    {
      handle,
      maxBytes: 1024,
      waitMs: 0,
    },
    SOURCE,
  );
  expect(first.exited).toBeNull();
  let bytes = Buffer.from(first.stdoutBase64, "base64").length;
  expect(bytes).toBeLessThanOrEqual(1024);
  const rest = await readToExit(instance, handle);
  bytes += rest.stdout.length;
  expect(bytes).toBe(total);
});

test("each stream gets at most half of a read while both have data", async () => {
  const instance = fresh();
  const { handle } = await start(
    instance,
    `process.stdout.write(Buffer.alloc(100, 97)); process.stderr.write(Buffer.alloc(100, 98)); setInterval(() => {}, 1000);`,
  );
  // Let both pipes fill before taking.
  await Bun.sleep(300);
  const chunk = await read(
    instance,
    {
      handle,
      maxBytes: 100,
      waitMs: 1000,
    },
    SOURCE,
  );
  const stdout = Buffer.from(chunk.stdoutBase64, "base64").length;
  const stderr = Buffer.from(chunk.stderrBase64, "base64").length;
  expect(stdout + stderr).toBeLessThanOrEqual(100);
  expect(stderr).toBeGreaterThan(0);
  await kill(
    instance,
    {
      handle,
    },
    SOURCE,
  );
});

test(`at most ${MAX_SPAWNED_PROCESSES} children are alive per adapter, counted until their exit is read`, async () => {
  const instance = fresh();
  const handles: string[] = [];
  for (let index = 0; index < MAX_SPAWNED_PROCESSES; index += 1) {
    handles.push((await start(instance, SLEEP)).handle);
  }
  await expect(start(instance, SLEEP)).rejects.toMatchObject({
    code: "BUSY",
  });
  const [first] = handles;
  await kill(
    instance,
    {
      handle: first ?? "",
    },
    SOURCE,
  );
  await readToExit(instance, first ?? "");
  handles.shift();
  const replacement = await start(instance, SLEEP);
  handles.push(replacement.handle);
});

test("an exited child nobody reads is released once the retention period passed", async () => {
  let clock = 0;
  const child = launchBunChild({
    executablePath: BUN,
    args: [
      "--no-env-file",
      "-e",
      "process.exit(0)",
    ],
  });
  let releases = 0;
  const watched: SpawnedChild = {
    get pid() {
      return child.pid;
    },
    state: () => child.state(),
    take: (stream, count) => child.take(stream, count),
    write: (bytes, signal) => child.write(bytes, signal),
    closeStdin: () => child.closeStdin(),
    kill: () => child.kill(),
    release: () => {
      releases += 1;
      return child.release();
    },
  };
  const table = new SpawnedProcessTable(
    async () => watched,
    () => clock,
  );
  const { handle } = await table.spawn(SOURCE, {
    executablePath: BUN,
    args: [],
  });
  await waitFor(() => child.state().exit ?? undefined, {
    deadline: "childStep",
    what: "the child to exit",
  });
  // The sweep that first sees the exit starts the retention clock.
  await table.sweep();
  clock = EXITED_HANDLE_RETENTION_MS - 1;
  await table.sweep();
  expect(releases).toBe(0);
  clock = EXITED_HANDLE_RETENTION_MS;
  await table.sweep();
  expect(releases).toBe(1);
  await expect(
    table.read(SOURCE, {
      handle,
      maxBytes: 1,
      waitMs: 0,
    }),
  ).rejects.toMatchObject(unknownHandle);
  await table.dispose();
});

test("disposal ends every child and refuses new work", async () => {
  const instance = fresh();
  const { handle } = await start(instance, SLEEP);
  const waiting = read(
    instance,
    {
      handle,
      maxBytes: 1,
      waitMs: 10_000,
    },
    SOURCE,
  );
  await dispose(instance);
  await expect(waiting).rejects.toMatchObject({
    code: "CANCELLED",
  });
  await expect(start(instance, SLEEP)).rejects.toMatchObject({
    code: "CANCELLED",
  });
  await expect(
    read(
      instance,
      {
        handle,
        maxBytes: 1,
        waitMs: 0,
      },
      SOURCE,
    ),
  ).rejects.toMatchObject(unknownHandle);
  expect(EXITED_HANDLE_RETENTION_MS).toBeGreaterThan(0);
});
