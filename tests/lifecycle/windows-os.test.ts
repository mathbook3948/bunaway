import { expect, setDefaultTimeout, test } from "bun:test";
import assert from "node:assert/strict";
import { arch, hostname, release, version } from "node:os";
import os from "@bunaway/plugin-os/native/windows";
import { osOperations } from "#plugins/os/src/operations";
import { deadline, killAfter } from "../fixtures/deadlines.ts";
import { assertWindowsRegionCode } from "../fixtures/windows-region-code.ts";

/** The consent store `Value` of one hive and device class as reg.exe prints it, or null when the key or value is absent. */
function consentValue(
  hive: "HKLM" | "HKCU",
  mediaType: "camera" | "microphone",
): string | null {
  const key = mediaType === "camera" ? "webcam" : "microphone";
  const result = Bun.spawnSync(
    [
      "reg",
      "query",
      `${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\${key}`,
      "/v",
      "Value",
      "/reg:64",
    ],
    {
      windowsHide: true,
    },
  );
  if (result.exitCode !== 0) {
    return null;
  }
  return (
    /^\s*Value\s+REG_SZ\s+(\S+)\s*$/m.exec(result.stdout.toString())?.[1] ?? ""
  );
}

/** The status the documented decision table gives for what reg.exe reads. */
function expectedMediaAccess(mediaType: "camera" | "microphone"): string {
  const machine = consentValue("HKLM", mediaType);
  if (machine === "Deny") {
    return "restricted";
  }
  if (machine !== null && machine !== "Allow") {
    return "unknown";
  }
  const user = consentValue("HKCU", mediaType);
  if (user === null) {
    return "not-determined";
  }
  return (
    {
      Allow: "granted",
      Deny: "denied",
    }[user] ?? "unknown"
  );
}

// One test reads the print spooler and DXGI and starts a child process.
setDefaultTimeout(deadline("toolchain"));

test.skipIf(process.platform !== "win32")(
  "Windows locale FFI and runtime metadata execute through generated Zod adapters",
  async () => {
    const platform = os._definition.nativePlatforms.windows;
    assert(platform);
    const adapter = platform.create({
      dataRoot: ".",
      capabilities: [],
    });
    try {
      const info = osOperations.info.output.parse(
        await adapter.execute("os.info", null, "backend"),
      );
      expect(info).toMatchObject({
        platform: "windows",
        architecture: arch(),
        hostname: hostname(),
        release: release(),
        version: version(),
        runtime: {
          name: "bun",
          version: Bun.version,
          pid: process.pid,
        },
      });
      const usage = osOperations.usage.output.parse(
        await adapter.execute("os.usage", null, "backend"),
      );
      expect(usage.pid).toBe(process.pid);
      expect(usage.logicalCpuCount).toBeGreaterThan(0);
      expect(usage.memory.systemTotalBytes).toBeGreaterThan(0);
      expect(usage.memory.systemFreeBytes).toBeLessThanOrEqual(
        usage.memory.systemTotalBytes,
      );
      expect(usage.memory.processResidentBytes).toBeGreaterThan(0);
      expect(usage.translation.nativeMachine).toBeGreaterThan(0);
      expect(usage.translation.active).toBe(
        usage.translation.processMachine !== 0,
      );
      const locale = osOperations.locale.output.parse(
        await adapter.execute("os.locale", null, "backend"),
      );
      expect(locale.locale.length).toBeGreaterThan(0);
      expect(locale.systemLanguage.length).toBeGreaterThan(0);
      expect(locale.preferredLanguages.length).toBeGreaterThan(0);
      expect(new Set(locale.preferredLanguages).size).toBe(
        locale.preferredLanguages.length,
      );
      assertWindowsRegionCode(locale.countryCode);
      // CI runners may have no printer: an empty list and a null default are valid results.
      const printers = osOperations.listPrinters.output.parse(
        await adapter.execute("os.listPrinters", null, "backend"),
      );
      const defaultPrinter = osOperations.getDefaultPrinter.output.parse(
        await adapter.execute("os.getDefaultPrinter", null, "backend"),
      );
      const marked = printers.filter((printer) => printer.isDefault);
      expect(marked.length).toBeLessThanOrEqual(1);
      // A default printer that is also listed must be the one entry marked as default.
      if (
        defaultPrinter !== null &&
        printers.some(
          (printer) =>
            printer.name.toLowerCase() === defaultPrinter.toLowerCase(),
        )
      ) {
        expect(marked.length).toBe(1);
        expect(marked[0]?.name.toLowerCase()).toBe(
          defaultPrinter.toLowerCase(),
        );
      }
      // A CI runner has no hardware GPU, but DXGI still lists its software renderer.
      const gpus = osOperations.listGpus.output.parse(
        await adapter.execute("os.listGpus", null, "backend"),
      );
      if (process.env.CI) {
        expect(gpus.length).toBeGreaterThan(0);
      }
      // A runner may have either setting; the call must read the real consent store without an error.
      for (const mediaType of [
        "camera",
        "microphone",
      ] as const) {
        const status = osOperations.getMediaAccessStatus.output.parse(
          await adapter.execute(
            "os.getMediaAccessStatus",
            {
              mediaType,
            },
            "backend",
          ),
        );
        // reg.exe reads the same keys independently, so a wrong key path or hive shows up as a different status.
        expect(status).toBe(expectedMediaAccess(mediaType));
      }
      // The app's own process leads the tree; a child this test starts joins it as another process.
      const child = Bun.spawn(
        [
          process.execPath,
          "-e",
          "process.stdin.resume()",
        ],
        {
          // A visible console window would take focus from the input tests that run after this one.
          windowsHide: true,
          stdio: [
            "pipe",
            "ignore",
            "ignore",
          ],
        },
      );
      const stop = killAfter(child, "childStep");
      try {
        const processes = osOperations.listAppProcesses.output.parse(
          await adapter.execute("os.listAppProcesses", null, "backend"),
        );
        expect(processes[0]).toMatchObject({
          pid: process.pid,
          kind: "app",
        });
        expect(processes[0]?.metrics?.workingSetBytes).toBeGreaterThan(0);
        expect(new Set(processes.map((entry) => entry.pid)).size).toBe(
          processes.length,
        );
        const started = processes.find((entry) => entry.pid === child.pid);
        expect(started).toMatchObject({
          parentPid: process.pid,
          kind: "other",
        });
        expect(started?.metrics?.workingSetBytes).toBeGreaterThan(0);
      } finally {
        clearTimeout(stop);
        child.kill();
        await child.exited;
      }
      for (const kind of [
        undefined,
        "default",
        "info",
        "warning",
        "error",
      ]) {
        expect(
          await adapter.execute(
            "os.beep",
            kind === undefined
              ? {}
              : {
                  kind,
                },
            "backend",
          ),
        ).toBeNull();
      }
      await expect(
        adapter.execute(
          "os.beep",
          {
            kind: "question",
          },
          "backend",
        ),
      ).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
      await expect(
        adapter.execute("os.locale", {}, "backend"),
      ).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
      await expect(
        adapter.execute("os.unknown", null, "backend"),
      ).rejects.toMatchObject({
        code: "UNSUPPORTED",
      });
    } finally {
      await adapter.dispose();
      await adapter.dispose();
    }
    await expect(
      adapter.execute("os.info", null, "backend"),
    ).rejects.toMatchObject({
      code: "CANCELLED",
    });
  },
);
