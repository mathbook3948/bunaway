import { mkdir } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { captureNativeChild } from "./native-child-diagnostics.ts";

const WEBKIT_ROLES = [
  "com.apple.WebKit.WebContent",
  "com.apple.WebKit.Networking",
  "com.apple.WebKit.GPU",
] as const;
const SAMPLE_FRAMES = [
  "mach_msg",
  "semaphore_wait",
  "__psynch_cvwait",
  "CFRunLoop",
  "IPC::Connection",
  "WebKit::",
  "WebCore::",
  "JSC::",
  "WTF::",
  "uv_run",
] as const;

/** Keep process state only; comm paths and unrelated process names never enter artifacts. */
export function startupProcesses(output: string, hostPid: number) {
  return output
    .split("\n")
    .flatMap((line) => {
      const match =
        /^\s*(\d+)\s+(\d+)\s+([A-Z+<>NsEsX-]+)\s+([\d:.]+)\s+(.+)$/.exec(line);
      if (!match) {
        return [];
      }
      const pid = Number(match[1]);
      const parentPid = Number(match[2]);
      const role =
        pid === hostPid
          ? "host"
          : WEBKIT_ROLES.find((name) => name === basename(match[5] ?? ""));
      return role &&
        Number.isSafeInteger(pid) &&
        Number.isSafeInteger(parentPid)
        ? [
            {
              pid,
              parentPid,
              role,
              state: match[3],
              cpuTime: match[4],
            },
          ]
        : [];
    })
    .sort(
      (left, right) =>
        Number(right.role === "host") - Number(left.role === "host"),
    )
    .slice(0, 32);
}

/** Emit fixed frame categories only, never sample headers, paths, arguments or arbitrary symbols. */
export function startupSample(output: string) {
  const frames = output
    .split("\n")
    .filter((line) => /^\s*[+| :!]*\d+\s/.test(line));
  return Object.fromEntries(
    SAMPLE_FRAMES.map((name) => [
      name,
      frames.filter((line) => line.includes(name)).length,
    ]),
  );
}

/** Ignore checkpoints from earlier storage launches sharing an append-only host log. */
export function startupDelayedSince(output: string, started: number): boolean {
  return output.split("\n").some((line) => {
    try {
      const entry = JSON.parse(line);
      return (
        typeof entry.t === "number" &&
        entry.t >= started &&
        entry.event === "webview-stage" &&
        entry.stage === "startup-checkpoint"
      );
    } catch {
      return false;
    }
  });
}

/**
 * Observe from the fixture parent so a blocked host cannot block its own evidence collection.
 * WebKit XPC services are inventoried for the current user, not attributed to a particular view.
 * Read-only probes are bounded, and stop kills only the diagnostic commands we spawned.
 */
function observeStartup(
  child: Bun.Subprocess,
  directory: string,
  dataRoot: string,
) {
  const probes = new Set<Bun.Subprocess>();
  let stopped = false;
  let wake: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const started = Date.now();
  const records: object[] = [];
  let previous: number[] = [];
  let sampled = false;
  async function probe(command: string[]) {
    if (stopped) {
      return {
        exitCode: null,
        output: "",
        unavailable: true,
      };
    }
    try {
      const process = Bun.spawn(command, {
        stdout: "pipe",
        stderr: "pipe",
        timeout: 2_000,
        killSignal: "SIGKILL",
      });
      probes.add(process);
      try {
        const [output, errors, exitCode] = await Promise.all([
          new Response(process.stdout).text(),
          new Response(process.stderr).text(),
          process.exited,
        ]);
        return {
          exitCode,
          output,
          unavailable:
            exitCode !== 0 ||
            /not permitted|permission|cannot sample/i.test(errors),
        };
      } finally {
        probes.delete(process);
      }
    } catch {
      return {
        exitCode: null,
        output: "",
        unavailable: true,
      };
    }
  }
  /** Samples the host and up to three WebKit services, preferring the networking service. */
  async function sampleProcesses(
    processes: ReturnType<typeof startupProcesses>,
  ) {
    const candidates = [
      processes.find((entry) => entry.role === "host"),
      ...processes
        .filter((entry) => entry.role !== "host")
        .sort(
          (left, right) =>
            Number(right.role === "com.apple.WebKit.Networking") -
            Number(left.role === "com.apple.WebKit.Networking"),
        )
        .slice(0, 3),
    ].filter((entry) => entry !== undefined);
    return await Promise.all(
      candidates.map(async ({ pid, role }) => {
        const result = await probe([
          "/usr/bin/sample",
          String(pid),
          "1",
          "10",
          "-file",
          "/dev/stdout",
        ]);
        return {
          pid,
          role,
          exitCode: result.exitCode,
          unavailable: result.unavailable,
          frames: startupSample(result.output),
        };
      }),
    );
  }
  /** Sleeps until the 5-second slot for this index, or until stop wakes it early. */
  async function sleepUntilTick(index: number) {
    await new Promise<void>((resolve) => {
      wake = resolve;
      timer = setTimeout(
        resolve,
        Math.max(0, started + index * 5_000 - Date.now()),
      );
    });
    wake = undefined;
  }
  /** Records the current-user process inventory and which earlier processes have disappeared. */
  async function recordInventory() {
    const inventory = await probe([
      "/bin/ps",
      "-U",
      String(process.getuid?.()),
      "-o",
      "pid=,ppid=,state=,time=,comm=",
    ]);
    const processes = startupProcesses(inventory.output, child.pid);
    const pids = processes.map(({ pid }) => pid);
    records.push({
      elapsedMs: Date.now() - started,
      scope: "host and current-user WebKit services",
      probeExit: inventory.exitCode,
      unavailable: inventory.unavailable,
      processes,
      disappearedSincePrevious:
        inventory.exitCode === 0
          ? previous.filter((pid) => !pids.includes(pid))
          : null,
    });
    if (inventory.exitCode === 0) {
      previous = pids;
    }
    return processes;
  }
  // Existing checkpoints prove the UI pump ran; their timestamps and delegate/asset stages
  // remain in host.log. The 10-second fallback also captures a host whose pump never ran.
  async function hostLogShowsDelay() {
    const hostLog = Bun.file(resolve(dataRoot, "logs/host.log"));
    return (
      (await hostLog.exists()) &&
      startupDelayedSince(await hostLog.text(), started)
    );
  }
  const done = (async () => {
    try {
      await mkdir(directory, {
        recursive: true,
      });
      for (let index = 0; index < 4 && !stopped; index++) {
        if (index > 0) {
          await sleepUntilTick(index);
          if (stopped) {
            break;
          }
        }
        const processes = await recordInventory();
        const stalled = await hostLogShowsDelay();
        if (!sampled && (stalled || index === 2) && !stopped) {
          sampled = true;
          const samples = await sampleProcesses(processes);
          records.push({
            elapsedMs: Date.now() - started,
            reason: stalled ? "startup-checkpoint" : "child-active-after-10s",
            samples,
          });
        }
        await Bun.write(
          resolve(directory, "startup-processes.json"),
          `${JSON.stringify(records, null, 2)}\n`,
        );
      }
    } catch {
      // Evidence collection must not replace the fixture's original assertion or deadline.
      console.error("macOS startup process diagnostics unavailable");
    }
  })();
  return async () => {
    stopped = true;
    clearTimeout(timer);
    wake?.();
    for (const probe of probes) {
      try {
        if (probe.exitCode === null) {
          probe.kill("SIGKILL");
        }
      } catch {
        console.error("macOS startup diagnostic command cleanup unavailable");
      }
    }
    await done;
  };
}

/** Preserve the existing child deadline while separately owning bounded startup probes. */
export async function captureMacosNativeChild(
  child: Bun.Subprocess,
  directory: string,
  phase: string,
  timeoutMs: number,
  dataRoot: string,
) {
  const captured = captureNativeChild(child, directory, phase, timeoutMs);
  const stop = observeStartup(child, directory, dataRoot);
  // A descendant may retain the output pipes after the host exits. Stop probing at
  // host exit rather than interpreting that pipe-drain interval as a live host stall.
  void child.exited.then(stop, stop).catch(() => {
    console.error("macOS startup diagnostic exit cleanup unavailable");
  });
  try {
    return await captured;
  } finally {
    await stop();
    try {
      const evidence = Bun.file(resolve(directory, "startup-processes.json"));
      if (await evidence.exists()) {
        console.error(
          `macOS startup process diagnostics: ${await evidence.text()}`,
        );
      }
    } catch {
      console.error("macOS startup process diagnostics could not be read");
    }
  }
}
