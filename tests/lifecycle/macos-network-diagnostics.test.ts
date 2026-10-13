import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { retainNetworkDiagnostics } from "./fixtures/macos-network-diagnostics.ts";

test("missing network reports retain live-child pipes and host evidence before package cleanup", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "bunaway-network-diagnostics-"));
  const dataRoot = resolve(root, "package/data");
  const destination = resolve(root, "artifact/network-diagnostics");
  const ready = resolve(root, "ready");
  await mkdir(resolve(dataRoot, "logs"), {
    recursive: true,
  });
  await mkdir(resolve(dataRoot, "temp"), {
    recursive: true,
  });
  const hostLog = '{"event":"navigation","view":"main"}\n';
  await Bun.write(resolve(dataRoot, "logs/host.log"), hostLog);
  await Bun.write(resolve(dataRoot, "temp/report.json"), '{"ok":');
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "-e",
      `console.log("network stdout"); console.error("network stderr"); await Bun.write(${JSON.stringify(ready)}, "ready"); setInterval(() => {}, 1000);`,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const capture = Promise.allSettled([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  try {
    const deadline = Date.now() + 2000;
    while (!(await Bun.file(ready).exists())) {
      expect(Date.now()).toBeLessThan(deadline);
      await Bun.sleep(10);
    }
    expect(child.exitCode).toBeNull();
    const counters = {
      requests: {
        "/text": 3,
      },
      pendingWebSockets: 0,
    };
    const diagnostics = await retainNetworkDiagnostics(
      child,
      capture,
      dataRoot,
      destination,
      {
        phase: "WKWebView report",
        ...counters,
      },
    );
    expect(await child.exited).not.toBe(0);
    expect(diagnostics.stdout).toBe("network stdout\n");
    expect(diagnostics.stderr).toBe("network stderr\n");
    // The artifact must survive the runner's subsequent temporary-package removal.
    await rm(resolve(root, "package"), {
      recursive: true,
      force: true,
    });
    expect(await Bun.file(resolve(destination, "host.log")).text()).toBe(
      hostLog,
    );
    expect(await Bun.file(resolve(destination, "stdout.log")).text()).toBe(
      "network stdout\n",
    );
    expect(await Bun.file(resolve(destination, "stderr.log")).text()).toBe(
      "network stderr\n",
    );
    expect(await Bun.file(resolve(destination, "report.json")).text()).toBe(
      '{"ok":',
    );
    expect(
      await Bun.file(resolve(destination, "network-state.json")).json(),
    ).toMatchObject({
      phase: "WKWebView report",
      ...counters,
      terminatedForDiagnostics: true,
      hasHostLog: true,
      hasReport: true,
      stdoutCapture: "fulfilled",
      stderrCapture: "fulfilled",
    });
  } finally {
    if (child.exitCode === null && !child.killed) {
      child.kill("SIGKILL");
    }
    await child.exited;
    await capture;
    await rm(root, {
      recursive: true,
      force: true,
    });
  }
}, 5000);

test("network diagnostics preserve pre-launch failures and discard stale reports", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "bunaway-network-diagnostics-"));
  const destination = resolve(root, "artifact");
  try {
    await Bun.write(resolve(destination, "report.json"), '{"ok":true}');
    await retainNetworkDiagnostics(
      undefined,
      undefined,
      resolve(root, "missing-package"),
      destination,
      {
        phase: "bundle",
        failure: {
          message: "fixture preparation failed",
        },
      },
    );
    expect(await Bun.file(resolve(destination, "report.json")).exists()).toBe(
      false,
    );
    expect(
      await Bun.file(resolve(destination, "network-state.json")).json(),
    ).toMatchObject({
      phase: "bundle",
      failure: {
        message: "fixture preparation failed",
      },
      childExitCode: null,
      terminatedForDiagnostics: false,
      hasHostLog: false,
      hasReport: false,
      stdoutCapture: "not-started",
      stderrCapture: "not-started",
    });
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
    });
  }
});
