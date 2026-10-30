import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deadline, killAfter, waitFor } from "../fixtures/deadlines.ts";
import { processExitProbe } from "../fixtures/process-exit-probe.ts";

setDefaultTimeout(deadline("nativeFixture"));

type HostReport = {
  hostPid: number;
  backendPids: number[];
  latePid: number;
  descendants: number;
  afterOutside: number;
  afterLate: number;
  outsidePid?: number;
  refusal?: string;
  restoreError?: string;
};

/** How the test ends the app while it sits inside an outer Job that forbids breakaway. */
const ENDINGS: string[] = [
  "forced host termination",
  "normal host exit",
  "outer Job closed",
];

test.skipIf(process.platform !== "win32").each(ENDINGS)(
  "an app started inside a no-breakaway outer Job runs and leaves no process after %s",
  async (ending) => {
    const root = await mkdtemp(join(tmpdir(), "bunaway-outer-job-"));
    const launcher = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        resolve(import.meta.dir, "../fixtures/windows-outer-job.ts"),
        "launcher",
        root,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const timer = killAfter(launcher, "nativeFixture");
    const errors = new Response(launcher.stderr).text();
    const output = new Response(launcher.stdout).text();
    const probes: ReturnType<typeof processExitProbe>[] = [];
    const exitedEarly = () =>
      launcher.exitCode !== null &&
      new Error(`Launcher exited early (${launcher.exitCode}).`);
    try {
      const report = await waitFor(
        async () => {
          const file = Bun.file(join(root, "host.json"));
          return (await file.exists())
            ? ((await file.json()) as HostReport)
            : undefined;
        },
        {
          deadline: "childStep",
          what: "the host report from inside the outer Job",
          failed: exitedEarly,
        },
      );
      // The app started and contained itself although it was already inside another Job.
      expect(report.descendants).toBeGreaterThanOrEqual(
        report.backendPids.length,
      );
      // Breakaway is checked only against the Job the host is directly in (the app Job), so the
      // outer Job does not refuse startOutsideAppJob and the app Job's flags are restored.
      expect({
        refusal: report.refusal,
        restoreError: report.restoreError,
      }).toEqual({
        refusal: undefined,
        restoreError: undefined,
      });
      expect(report.afterOutside).toBeGreaterThanOrEqual(
        report.backendPids.length,
      );
      expect(report.afterLate).toBeGreaterThanOrEqual(
        report.backendPids.length + 1,
      );
      // The outside process is not an app descendant: the late child is the only addition.
      expect(report.outsidePid).toBeNumber();
      expect(report.afterLate).toBeGreaterThan(report.afterOutside);

      const pids = [
        launcher.pid,
        report.hostPid,
        report.outsidePid as number,
        ...report.backendPids,
        report.latePid,
      ];
      for (const pid of pids) {
        probes.push(processExitProbe(pid));
      }
      expect(probes.every((probe) => !probe.exited())).toBe(true);

      const [launcherProbe, hostProbe, outsideProbe, ...backendProbes] = probes;
      if (ending === "forced host termination") {
        process.kill(report.hostPid);
        await waitFor(() => hostProbe?.exited(), {
          deadline: "childExit",
          what: "the terminated host to exit",
        });
        // Only the app Job closes with the host; the outer Job owner stays alive.
        await waitFor(() => backendProbes.every((probe) => probe.exited()), {
          deadline: "childExit",
          what: "the backend children and late child to be reaped after the host was killed",
        });
        // Leaving the app Job also means surviving the host; only the outer Job still owns it.
        expect(launcherProbe?.exited()).toBe(false);
        expect(outsideProbe?.exited()).toBe(false);
      } else if (ending === "normal host exit") {
        await Bun.write(join(root, "release"), "release");
        await waitFor(() => backendProbes.every((probe) => probe.exited()), {
          deadline: "childExit",
          what: "the backend children to be reaped after the host exited",
        });
        expect(launcherProbe?.exited()).toBe(false);
        expect(outsideProbe?.exited()).toBe(false);
      } else {
        await Bun.write(join(root, "close-outer"), "close");
        await waitFor(() => probes.every((probe) => probe.exited()), {
          deadline: "childExit",
          what: "every process to be reaped when the outer Job closed",
        });
      }
      // Releasing the outer Job owner ends the launcher, which closes the outer Job last.
      await Bun.write(join(root, "close-outer"), "close");
      await waitFor(() => probes.every((probe) => probe.exited()), {
        deadline: "childExit",
        what: "every process, including the launcher, to be gone",
      });
      await launcher.exited;
      expect(await errors).toBe("");
      expect(await output).toBe("");
    } finally {
      clearTimeout(timer);
      launcher.kill();
      await Promise.allSettled([
        launcher.exited,
        errors,
        output,
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
);
