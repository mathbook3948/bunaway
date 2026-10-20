import { dlopen, ptr } from "bun:ffi";
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import assert from "node:assert/strict";
import { dispose, initialize } from "#plugins/process/src/platforms/windows";
import { deadline, waitFor } from "../fixtures/deadlines.ts";
import { processExitProbe } from "../fixtures/process-exit-probe.ts";
import {
  closeStdin,
  kill,
  read,
  spawn,
  write,
} from "../fixtures/process-spawn.ts";

// Real Win32 children: Job Object containment, overlapped stdin and anonymous output pipes.
// Runs on Windows only; tests/api/process-spawn.test.ts covers the handle contract everywhere.
setDefaultTimeout(deadline("childStep"));

const SOURCE = "view:main";
const windowsOnly = process.platform !== "win32";
const SLEEP = "setInterval(() => {}, 1000);";
/** Starts a sleeping grandchild, prints its pid, then keeps running. */
const PARENT_WITH_GRANDCHILD = `
  const grandchild = Bun.spawn([process.execPath, "--no-env-file", "-e", ${JSON.stringify(SLEEP)}], { stdio: ["ignore", "ignore", "ignore"] });
  process.stdout.write(String(grandchild.pid) + "\\n");
  setInterval(() => {}, 1000);
`;

const instances: ReturnType<typeof initialize>[] = [];

function fresh() {
  const instance = initialize();
  instances.push(instance);
  return instance;
}

afterEach(async () => {
  await Promise.all(instances.splice(0).map((instance) => dispose(instance)));
});

function start(instance: ReturnType<typeof initialize>, script: string) {
  return spawn(
    instance,
    {
      executablePath: process.execPath,
      args: [
        "--no-env-file",
        "-e",
        script,
      ],
    },
    SOURCE,
  );
}

async function readText(
  instance: ReturnType<typeof initialize>,
  handle: string,
  until: (text: string) => boolean,
) {
  let text = "";
  await waitFor(
    async () => {
      const chunk = await read(
        instance,
        {
          handle,
          maxBytes: 65536,
          waitMs: 100,
        },
        SOURCE,
      );
      text += Buffer.from(chunk.stdoutBase64, "base64").toString();
      return until(text) ? true : undefined;
    },
    {
      deadline: "childStep",
      what: "the spawned process output",
    },
  );
  return text;
}

async function readExit(
  instance: ReturnType<typeof initialize>,
  handle: string,
) {
  return waitFor(
    async () =>
      (
        await read(
          instance,
          {
            handle,
            maxBytes: 65536,
            waitMs: 100,
          },
          SOURCE,
        )
      ).exited ?? undefined,
    {
      deadline: "childStep",
      what: "the spawned process to report its exit",
    },
  );
}

test.skipIf(windowsOnly)(
  "kill ends the child and its descendants through the handle Job",
  async () => {
    const instance = fresh();
    const { handle } = await start(instance, PARENT_WITH_GRANDCHILD);
    const grandchildPid = Number.parseInt(
      (await readText(instance, handle, (text) => text.includes("\n"))).trim(),
      10,
    );
    const probe = processExitProbe(grandchildPid);
    try {
      expect(probe.exited()).toBe(false);
      await kill(
        instance,
        {
          handle,
        },
        SOURCE,
      );
      await waitFor(() => probe.exited() || undefined, {
        deadline: "childExit",
        what: "the grandchild to end",
      });
      const exited = await readExit(instance, handle);
      expect(exited.signal).toBeNull();
    } finally {
      probe.dispose();
    }
  },
);

test.skipIf(windowsOnly)(
  "a root that exits on its own takes its remaining descendants with it",
  async () => {
    const instance = fresh();
    const { handle } = await start(
      instance,
      `
        const grandchild = Bun.spawn([process.execPath, "--no-env-file", "-e", ${JSON.stringify(SLEEP)}], { stdio: ["ignore", "inherit", "ignore"] });
        process.stdout.write(String(grandchild.pid) + "\\n", () => process.exit(7));
      `,
    );
    const text = await readText(instance, handle, (output) =>
      output.includes("\n"),
    );
    const probe = processExitProbe(Number.parseInt(text.trim(), 10));
    try {
      const exited = await readExit(instance, handle);
      expect(exited.exitCode).toBe(7);
      await waitFor(() => probe.exited() || undefined, {
        deadline: "childExit",
        what: "the grandchild to end",
      });
    } finally {
      probe.dispose();
    }
  },
);

test.skipIf(windowsOnly)(
  "stdin round trips and a write blocked on a full pipe is cancelled without losing the handle",
  async () => {
    const instance = fresh();
    const echo = await start(
      instance,
      `for await (const chunk of Bun.stdin.stream()) process.stdout.write(chunk);`,
    );
    const payload = Buffer.alloc(60 * 1024, 120);
    const received = readText(
      instance,
      echo.handle,
      (text) => text.length >= payload.length,
    );
    await write(
      instance,
      {
        handle: echo.handle,
        dataBase64: payload.toString("base64"),
      },
      SOURCE,
    );
    expect((await received).length).toBe(payload.length);
    await closeStdin(
      instance,
      {
        handle: echo.handle,
      },
      SOURCE,
    );
    expect((await readExit(instance, echo.handle)).exitCode).toBe(0);

    // A child that never reads stdin leaves the write pending once the pipe is full.
    const idle = await start(instance, SLEEP);
    const controller = new AbortController();
    const pending = write(
      instance,
      {
        handle: idle.handle,
        dataBase64: Buffer.alloc(64 * 1024, 1).toString("base64"),
      },
      SOURCE,
      controller.signal,
    ).catch((error: unknown) => error);
    await Bun.sleep(100);
    controller.abort(new Error("cancel write"));
    expect(await pending).toMatchObject({
      message: "cancel write",
    });
    await kill(
      instance,
      {
        handle: idle.handle,
      },
      SOURCE,
    );
    await readExit(instance, idle.handle);
  },
);

test.skipIf(windowsOnly)(
  "closeStdin behind a blocked write stops waiting when its signal aborts, and disposal still ends the child",
  async () => {
    const instance = fresh();
    const { handle } = await start(instance, SLEEP);
    const blocked = write(
      instance,
      {
        handle,
        dataBase64: Buffer.alloc(64 * 1024, 1).toString("base64"),
      },
      SOURCE,
    ).catch((error: unknown) => error);
    await Bun.sleep(100);
    const controller = new AbortController();
    const closing = closeStdin(
      instance,
      {
        handle,
      },
      SOURCE,
      controller.signal,
    ).catch((error: unknown) => error);
    controller.abort(new Error("stop closing"));
    expect(await closing).toMatchObject({
      message: "stop closing",
    });
    await dispose(instance);
    // Disposal ends the tree first, so the blocked write sees the broken pipe (a closed
    // input) or, if cancellation wins that race, CANCELLED. Either way it settles.
    expect(await blocked).toMatchObject({
      code: expect.stringMatching(/^(CANCELLED|INVALID_ARGUMENT)$/),
    });
  },
);

test.skipIf(windowsOnly)(
  "killing a child with a pending write settles the write and keeps the exit readable",
  async () => {
    const instance = fresh();
    const { handle } = await start(instance, SLEEP);
    const pending = write(
      instance,
      {
        handle,
        dataBase64: Buffer.alloc(64 * 1024, 1).toString("base64"),
      },
      SOURCE,
    ).catch((error: unknown) => error);
    await Bun.sleep(100);
    await kill(
      instance,
      {
        handle,
      },
      SOURCE,
    );
    expect(await pending).toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    expect((await readExit(instance, handle)).exitCode).toBe(1);
  },
);

test.skipIf(windowsOnly)(
  "an unread output pipe blocks the child, and reading releases every byte",
  async () => {
    const instance = fresh();
    const total = 2 * 1024 * 1024;
    const { handle } = await start(
      instance,
      `process.stdout.write(Buffer.alloc(${total}, 97), () => process.exit(0));`,
    );
    await Bun.sleep(300);
    const first = await read(
      instance,
      {
        handle,
        maxBytes: 4096,
        waitMs: 0,
      },
      SOURCE,
    );
    // The child is still blocked on its full pipe, so no exit can be reported yet.
    expect(first.exited).toBeNull();
    let bytes = Buffer.from(first.stdoutBase64, "base64").length;
    await waitFor(
      async () => {
        const chunk = await read(
          instance,
          {
            handle,
            maxBytes: 65536,
            waitMs: 100,
          },
          SOURCE,
        );
        bytes += Buffer.from(chunk.stdoutBase64, "base64").length;
        return chunk.exited ?? undefined;
      },
      {
        deadline: "childStep",
        what: "all output and the exit",
      },
    );
    expect(bytes).toBe(total);
  },
);

test.skipIf(windowsOnly)(
  "disposal ends every child and descendant, and repeated spawn and kill leave no handles behind",
  async () => {
    const api = dlopen("kernel32.dll", {
      GetCurrentProcess: {
        args: [],
        returns: "u64",
      },
      GetProcessHandleCount: {
        args: [
          "u64",
          "ptr",
        ],
        returns: "i32",
      },
    });
    const count = () => {
      const value = Buffer.alloc(4);
      assert(
        api.symbols.GetProcessHandleCount(
          api.symbols.GetCurrentProcess(),
          ptr(value),
        ),
      );
      return value.readUInt32LE();
    };
    const instance = fresh();
    try {
      // Warm the runtime's process and FFI paths before comparing native handle ownership.
      const warm = await start(instance, "process.exit(0)");
      await readExit(instance, warm.handle);
      const before = count();
      for (let attempt = 0; attempt < 8; attempt++) {
        const { handle } = await start(instance, SLEEP);
        await kill(
          instance,
          {
            handle,
          },
          SOURCE,
        );
        await readExit(instance, handle);
      }
      expect(count()).toBe(before);
      const { handle } = await start(instance, PARENT_WITH_GRANDCHILD);
      const text = await readText(instance, handle, (output) =>
        output.includes("\n"),
      );
      const probe = processExitProbe(Number.parseInt(text.trim(), 10));
      try {
        await dispose(instance);
        await waitFor(() => probe.exited() || undefined, {
          deadline: "childExit",
          what: "the grandchild to end at disposal",
        });
      } finally {
        probe.dispose();
      }
    } finally {
      api.close();
    }
  },
);
