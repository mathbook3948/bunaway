import { dlopen, ptr } from "bun:ffi";
import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defineApp, defineModule } from "@bunaway/backend";
import { createClient } from "@bunaway/client";
import { type CoreServices, createCore } from "@bunaway/core";
import processes from "@bunaway/plugin-process";
import nativeProcesses from "@bunaway/plugin-process/native/windows";
import {
  BunawayError,
  type ClientMessage,
  type HostContext,
  type JsonValue,
  parseMessage,
  type TransportEvent,
} from "@bunaway/protocol";
import { processOperations } from "#plugins/process/src/operations";
import {
  dispose,
  initialize,
  run,
} from "#plugins/process/src/platforms/windows";
import { testAppInfo } from "../fixtures/app-info.ts";
import { processExitProbe } from "../fixtures/process-exit-probe.ts";

test.skipIf(process.platform !== "win32")(
  "invocation Jobs preserve intended PID membership, cancellation isolation and complete host shutdown",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "bunaway-process-host-job-"));
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        resolve(import.meta.dir, "../fixtures/process-host-job.ts"),
        root,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10000,
      },
    );
    const output = new Response(child.stdout).text();
    const errors = new Response(child.stderr).text();
    const probes: ReturnType<typeof processExitProbe>[] = [];
    const readiness = new AbortController();
    let ready: Promise<void> | undefined;
    try {
      const inventoryFile = join(root, "members.json");
      ready = (async () => {
        const deadline = Date.now() + 3000;
        while (!(await Bun.file(inventoryFile).exists())) {
          readiness.signal.throwIfAborted();
          expect(Date.now()).toBeLessThan(deadline);
          await Bun.sleep(2);
        }
      })();
      await Promise.race([
        ready,
        child.exited.then(async (exitCode) => {
          throw new Error(
            `Host fixture exited before readiness (${exitCode}): ${await errors}`,
          );
        }),
      ]);
      const inventory = JSON.parse(await readFile(inventoryFile, "utf8")) as {
        pids: number[];
        consolePids: number[];
      };
      for (const pid of inventory.pids) {
        const probe = processExitProbe(pid);
        probes.push(probe);
        expect(probe.exited()).toBe(false);
      }
      await Bun.write(join(root, "release"), "release");
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        output,
        errors,
      ]);
      expect({
        exitCode,
        error: stderr,
      }).toEqual({
        exitCode: 0,
        error: "",
      });
      expect(stdout).toBe("contained");
      expect(probes.every((probe) => probe.exited())).toBe(true);
    } finally {
      readiness.abort();
      child.kill();
      await Promise.allSettled([
        ready,
        child.exited,
        output,
        errors,
      ]);
      for (const probe of probes) {
        probe.dispose();
      }
      await rm(root, {
        recursive: true,
        force: true,
      });
    }
  },
  15000,
);

test.skipIf(process.platform !== "win32")(
  "private JOB_LIST preserves explicit parent membership and reports startup failures",
  async () => {
    const root = await mkdtemp(
      join(tmpdir(), "bunaway-process-job-membership-"),
    );
    const runnerModule = resolve(
      import.meta.dir,
      "../../plugins/process/src/platforms/windows-process.ts",
    );
    const pidFile = join(root, "pid");
    const script = `
      import { dlopen, ptr } from "bun:ffi";
      const { runProcess } = await import(${JSON.stringify(runnerModule)});
      const api = dlopen("kernel32.dll", {
        CreateJobObjectW: { args: ["ptr", "ptr"], returns: "u64" },
        GetCurrentProcess: { args: [], returns: "u64" },
        SetInformationJobObject: { args: ["u64", "i32", "ptr", "u32"], returns: "i32" },
        AssignProcessToJobObject: { args: ["u64", "u64"], returns: "i32" },
        IsProcessInJob: { args: ["u64", "u64", "ptr"], returns: "i32" },
        OpenProcess: { args: ["u32", "i32", "u32"], returns: "u64" },
        CloseHandle: { args: ["u64"], returns: "i32" },
        GetLastError: { args: [], returns: "u32" },
      });
      const check = (result, operation) => {
        if (!result) throw new Error(operation + " failed: " + api.symbols.GetLastError());
      };
      const host = api.symbols.CreateJobObjectW(null, null);
      check(host, "CreateJobObjectW");
      const limits = Buffer.alloc(144);
      limits.writeUInt32LE(0x2000, 16);
      check(api.symbols.SetInformationJobObject(host, 9, ptr(limits), limits.length), "SetInformationJobObject");
      check(api.symbols.AssignProcessToJobObject(host, api.symbols.GetCurrentProcess()), "AssignProcessToJobObject");
      const member = Buffer.alloc(4);
      check(api.symbols.IsProcessInJob(api.symbols.GetCurrentProcess(), host, ptr(member)), "parent IsProcessInJob");
      if (member.readUInt32LE() !== 1) throw new Error("Parent is not in the host Job");
      const controller = new AbortController();
      const task = runProcess({
        executablePath: process.execPath,
        args: [${JSON.stringify(resolve(import.meta.dir, "../fixtures/process-ready.ts"))}, ${JSON.stringify(pidFile)}],
        maxOutputBytes: 65536, timeoutMs: 30000,
      }, controller.signal);
      const outcome = task.catch(error => ({ code: error.code, cause: error.cause?.message }));
      let child = 0n;
      try {
        const ready = (async () => {
          const deadline = Date.now() + 2000;
          while (!(await Bun.file(${JSON.stringify(pidFile)}).exists())) {
            if (Date.now() >= deadline) throw new Error("Child did not publish its PID");
            await Bun.sleep(2);
          }
        })();
        await Promise.race([ready, outcome.then(result => { throw new Error("Process startup failed: " + JSON.stringify(result)); })]);
        const pid = Number(await Bun.file(${JSON.stringify(pidFile)}).text());
        child = api.symbols.OpenProcess(0x00101000, 0, pid);
        check(child, "OpenProcess");
        check(api.symbols.IsProcessInJob(child, host, ptr(member)), "child IsProcessInJob");
        if (member.readUInt32LE() !== 1) throw new Error("Private JOB_LIST lost parent Job membership");
        process.stdout.write("parent-and-child-contained");
      } finally {
        controller.abort();
        await outcome;
        if (child) check(api.symbols.CloseHandle(child), "CloseHandle");
        api.close();
        // The host is itself in the kill-on-close Job. Its handle belongs to
        // process exit, exactly like containAppProcess, rather than this block.
      }
    `;
    try {
      const child = Bun.spawn(
        [
          process.execPath,
          "-e",
          script,
        ],
        {
          stdout: "pipe",
          stderr: "pipe",
          timeout: 5000,
        },
      );
      const [exitCode, output, error] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect({
        exitCode,
        error,
      }).toEqual({
        exitCode: 0,
        error: "",
      });
      expect(output).toBe("parent-and-child-contained");
    } finally {
      await rm(root, {
        recursive: true,
        force: true,
      });
    }
  },
);

test.skipIf(process.platform !== "win32")(
  "repeated success, cancellation and startup failure close native invocation handles",
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
    const state = initialize();
    const input = {
      executablePath: process.execPath,
      args: [
        "-e",
        "void 0;",
      ],
      stdinBase64: "",
      maxOutputBytes: 65536,
      timeoutMs: 30000,
    };
    try {
      // Warm the runtime's process/FFI paths before comparing native handle ownership.
      await run(state, input);
      const cancelledInput = {
        ...input,
        args: [
          "-e",
          "setInterval(() => {}, 1000)",
        ],
        stdinBase64: Buffer.alloc(65536, 255).toString("base64"),
      };
      const cancel = async () => {
        const controller = new AbortController();
        const observed = run(state, cancelledInput, controller.signal).catch(
          (error: unknown) => error,
        );
        // Creation and overlapped input start before run yields to the caller.
        controller.abort();
        expect(await observed).toMatchObject({
          code: "CANCELLED",
        });
      };
      await cancel();
      const before = count();
      for (let attempt = 0; attempt < 12; attempt++) {
        expect((await run(state, input)).exitCode).toBe(0);
        await cancel();
        await expect(
          run(state, {
            ...input,
            executablePath:
              "C:/bunaway-nonexistent-process-fixture/missing.exe",
          }),
        ).rejects.toMatchObject({
          code: "INTERNAL",
        });
      }
      expect(count()).toBe(before);
      expect(state.active.size).toBe(0);
    } finally {
      await dispose(state);
      api.close();
    }
  },
  15000,
);

test.skipIf(process.platform !== "win32")(
  "public process cancellation rejects before delayed bridge delivery and retains eventual child cleanup",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "bunaway-public-process-"));
    const pidFile = join(root, "pid");
    const platform = nativeProcesses._definition.nativePlatforms.windows;
    assert(platform);
    const adapter = platform.create({
      dataRoot: root,
      capabilities: [],
    });
    const execute = adapter.executeUI;
    assert(execute);
    const delivery = new AbortController();
    let releaseDelivery!: () => void;
    const deliveryGate = new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
    let finishAdapter!: () => void;
    const adapterFinished = new Promise<void>((resolve) => {
      finishAdapter = resolve;
    });
    let adapterSettled = false;
    let deliveryTask: Promise<void> | undefined;
    let listener: ((event: TransportEvent) => void) | undefined;
    const grants = {
      permissions: [
        "process.run",
      ],
    };
    const services: CoreServices = {
      app: testAppInfo,
      platform: "windows",
      backendContext: "backend" as HostContext,
      hello: {
        kind: "hello",
        protocol: {
          major: 1,
          minor: 0,
        },
        features: [],
        buildId: "public-process-test",
      },
      policy: {
        version: 1,
        backend: grants,
        views: [
          {
            id: "test",
            origins: [
              "https://app.bunaway.local",
            ],
            commands: [
              "probe.run",
            ],
            events: [],
            host: grants,
          },
        ],
      },
      runtime: {
        createCancellation: () => new AbortController(),
        now: () => Date.now(),
        schedule(callback, delay) {
          const timer = setTimeout(callback, delay);
          return () => clearTimeout(timer);
        },
      },
      async send(_context, message) {
        listener?.({
          kind: "message",
          text: JSON.stringify(message),
        });
      },
      async callHost(_context, call, signal) {
        // Model asynchronous bridge cancellation delivery without changing production transport.
        const deliverAbort = () => {
          deliveryTask = deliveryGate.then(() =>
            delivery.abort(
              new BunawayError({
                code: "CANCELLED",
                message: "Test request ended.",
              }),
            ),
          );
        };
        signal.addEventListener("abort", deliverAbort);
        try {
          return {
            kind: "result",
            payload: await execute(call.operation, call.payload, "view:test", {
              requestId: crypto.randomUUID(),
              permissions: grants,
              signal: delivery.signal,
            }),
          };
        } finally {
          signal.removeEventListener("abort", deliverAbort);
          adapterSettled = true;
          finishAdapter();
        }
      },
    };
    const module = defineModule("probe").command(
      "run",
      {
        input: {
          const: null,
        },
        output: {
          const: null,
        },
      },
      async () => {
        await processes.run({
          executablePath: process.execPath,
          args: [
            resolve(import.meta.dir, "../fixtures/process-ready.ts"),
            pidFile,
          ],
        });
        return null;
      },
    );
    const core = await createCore(
      defineApp({
        plugins: [
          processes,
        ],
        modules: [
          module,
        ],
      }),
      services,
    );
    const session = core.openSession("test" as HostContext, "test");
    const client = createClient({
      hello: services.hello,
      transport: {
        send: (text) => session.receive(parseMessage(text) as ClientMessage),
        subscribe(current) {
          listener = current;
          return () => {
            listener = undefined;
          };
        },
        close: () => session.close(),
      },
    });
    const controller = new AbortController();
    let observed: Promise<unknown> | undefined;
    let probe: ReturnType<typeof processExitProbe> | undefined;
    try {
      await client.ready;
      observed = client
        .invoke("probe.run", null, {
          signal: controller.signal,
        })
        .catch((error: unknown) => error);
      const deadline = Date.now() + 2000;
      while (!(await Bun.file(pidFile).exists())) {
        expect(Date.now()).toBeLessThan(deadline);
        await Bun.sleep(2);
      }
      probe = processExitProbe(Number(await readFile(pidFile, "utf8")));
      expect(probe.exited()).toBe(false);
      controller.abort();
      expect(await observed).toMatchObject({
        code: "CANCELLED",
      });
      expect(adapterSettled).toBe(false);
      expect(probe.exited()).toBe(false);
      releaseDelivery();
      await adapterFinished;
      expect(adapterSettled).toBe(true);
      expect(probe.exited()).toBe(true);
      await adapter.dispose();
    } finally {
      controller.abort();
      releaseDelivery();
      delivery.abort();
      await observed;
      await deliveryTask;
      await adapter.dispose();
      probe?.dispose();
      await client.close();
      await core.stop();
      await rm(root, {
        recursive: true,
        force: true,
      });
    }
  },
);

test.skipIf(process.platform !== "win32")(
  "generated Windows argv adapter handles completion, timeout, capacity and repeated disposal",
  async () => {
    const platform = nativeProcesses._definition.nativePlatforms.windows;
    assert(platform);
    const adapter = platform.create({
      dataRoot: ".",
      capabilities: [],
    });
    const call = (input: JsonValue, signal?: AbortSignal) => {
      assert(adapter.executeUI);
      return adapter.executeUI("process.run", input, "view:test", {
        requestId: crypto.randomUUID(),
        permissions: {
          permissions: [
            "process.run",
          ],
        },
        ...(signal
          ? {
              signal,
            }
          : {}),
      });
    };
    try {
      const result = processOperations.run.output.parse(
        await call({
          executablePath: process.execPath,
          args: [
            "-e",
            'process.stdout.write("한글 😀"); process.exitCode = 23;',
          ],
        }),
      );
      expect(result.exitCode).toBe(23);
      expect(Buffer.from(result.stdoutBase64, "base64").toString()).toBe(
        "한글 😀",
      );
      await expect(
        call({
          executablePath: process.execPath,
          args: [
            "-e",
            "setInterval(() => {}, 1000)",
          ],
          timeoutMs: 100,
        }),
      ).rejects.toMatchObject({
        code: "TIMEOUT",
      });
      const pending = Array.from(
        {
          length: 8,
        },
        () =>
          call({
            executablePath: process.execPath,
            args: [
              "-e",
              "setInterval(() => {}, 1000)",
            ],
          }),
      );
      const observed = Promise.allSettled(pending);
      await Bun.sleep(50);
      await expect(
        call({
          executablePath: process.execPath,
          args: [
            "-e",
            "",
          ],
        }),
      ).rejects.toMatchObject({
        code: "BUSY",
      });
      await adapter.dispose();
      await adapter.dispose();
      expect(
        (await observed).every(
          (result) =>
            result.status === "rejected" && result.reason.code === "CANCELLED",
        ),
      ).toBe(true);
      await expect(
        call({
          executablePath: process.execPath,
        }),
      ).rejects.toMatchObject({
        code: "CANCELLED",
      });
    } finally {
      await adapter.dispose();
    }
  },
);
