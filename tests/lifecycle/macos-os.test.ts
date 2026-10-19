import { expect, test } from "bun:test";
import { arch, hostname, release, version } from "node:os";
import { osOperations } from "#plugins/os/src/operations";
import { initialize } from "#plugins/os/src/platforms/macos";

test.skipIf(process.platform !== "darwin")(
  "macOS CoreFoundation locale, sysctl translation and runtime metadata match the contract",
  () => {
    const adapter = initialize();
    try {
      expect(osOperations.info.output.parse(adapter.info())).toMatchObject({
        platform: "macos",
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
      const usage = osOperations.usage.output.parse(adapter.usage());
      expect(usage.pid).toBe(process.pid);
      expect(usage.logicalCpuCount).toBeGreaterThan(0);
      expect(usage.memory.systemTotalBytes).toBeGreaterThan(0);
      expect(usage.memory.processResidentBytes).toBeGreaterThan(0);
      expect(usage.translation.nativeMachine).toBeGreaterThan(0);
      expect(usage.translation.active).toBe(
        usage.translation.processMachine !== 0,
      );
      if (arch() === "arm64") {
        expect(usage.translation.active).toBe(false);
      }
      const locale = osOperations.locale.output.parse(adapter.locale());
      expect(locale.locale.length).toBeGreaterThan(0);
      expect(locale.locale).not.toContain("_");
      expect(locale.preferredLanguages.length).toBeGreaterThan(0);
      expect(locale.systemLanguage).toBe(locale.preferredLanguages.at(0) ?? "");
      if (locale.countryCode !== null) {
        expect(locale.countryCode).toMatch(/^(?:[A-Z]{2}|[0-9]{3})$/);
      }
      for (const kind of [
        "default",
        "info",
        "warning",
        "error",
      ] as const) {
        expect(adapter.beep(kind)).toBeNull();
      }
    } finally {
      adapter.dispose();
    }
    expect(() => adapter.info()).toThrow("OS adapter is disposed.");
    expect(() => adapter.usage()).toThrow("OS adapter is disposed.");
    expect(() => adapter.locale()).toThrow("OS adapter is disposed.");
    expect(() => adapter.beep("default")).toThrow("OS adapter is disposed.");
    expect(() => adapter.dispose()).not.toThrow();
  },
);
