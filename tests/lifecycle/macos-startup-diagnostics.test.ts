import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  captureMacosNativeChild,
  startupDelayedSince,
  startupProcesses,
  startupSample,
} from "../fixtures/macos-startup-diagnostics.ts";

test("startup inventory retains state without leaking paths or unrelated process names", () => {
  const records = startupProcesses(
    [
      " 101 1 Ss 0:00.12 /private/secret/bunaway-host",
      " 102 1 S 0:00.34 /System/Library/com.apple.WebKit.WebContent",
      " 103 1 T 0:00.01 /System/Library/com.apple.WebKit.Networking",
      " 104 1 S 0:00.00 /private/secret/other-app",
      " malformed secret",
    ].join("\n"),
    101,
  );
  expect(records).toEqual([
    {
      pid: 101,
      parentPid: 1,
      role: "host",
      state: "Ss",
      cpuTime: "0:00.12",
    },
    {
      pid: 102,
      parentPid: 1,
      role: "com.apple.WebKit.WebContent",
      state: "S",
      cpuTime: "0:00.34",
    },
    {
      pid: 103,
      parentPid: 1,
      role: "com.apple.WebKit.Networking",
      state: "T",
      cpuTime: "0:00.01",
    },
  ]);
  expect(JSON.stringify(records)).not.toContain("secret");
});

test("sample evidence contains fixed frame categories and discards raw headers and symbols", () => {
  const frames = startupSample(
    "Path: /secret/CFRunLoop\n  100 CFRunLoopRunSpecific (in secret-framework)\n  + 100 mach_msg2_trap (in libsystem_kernel)\n  + 50 IPC::Connection::waitForSyncReply (secret)\n  + 10 customSecretToken\n",
  );
  expect(frames.CFRunLoop).toBe(1);
  expect(frames.mach_msg).toBe(1);
  expect(frames["IPC::Connection"]).toBe(1);
  expect(JSON.stringify(frames)).not.toContain("secret");
});

test.skipIf(process.platform !== "darwin")(
  "startup probes stop at host exit while a descendant keeps its pipes open",
  async () => {
    const directory = await mkdtemp(
      resolve(tmpdir(), "bunaway-startup-probes-"),
    );
    try {
      const child = Bun.spawn(
        [
          process.execPath,
          "-e",
          `Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 6000)"], { stdout: "inherit", stderr: "inherit", stdin: "ignore" }).unref(); console.log("fixture output"); setTimeout(() => process.exit(7), 500);`,
        ],
        {
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const result = await captureMacosNativeChild(
        child,
        directory,
        "probe lifecycle",
        10_000,
        directory,
      );
      expect(result.exitCode).toBe(7);
      expect(result.stdout).toBe("fixture output\n");
      const observed = await Bun.file(resolve(directory, "child.json")).json();
      expect(observed.exitCode).toBe(7);
      expect(observed.timedOut).toBe(false);
      const evidence = await Bun.file(
        resolve(directory, "startup-processes.json"),
      ).json();
      expect(evidence).toHaveLength(1);
      expect(evidence[0].elapsedMs).toBeLessThan(5_000);
    } finally {
      await rm(directory, {
        recursive: true,
        force: true,
      });
    }
  },
  15_000,
);

test("startup sampling ignores previous launches in the shared host log", () => {
  const previous = JSON.stringify({
    t: 100,
    event: "webview-stage",
    stage: "startup-checkpoint",
  });
  const current = JSON.stringify({
    t: 250,
    event: "webview-stage",
    stage: "startup-checkpoint",
  });
  expect(startupDelayedSince(`${previous}\nnull\nincomplete`, 200)).toBe(false);
  expect(startupDelayedSince(`${previous}\n${current}`, 200)).toBe(true);
});
