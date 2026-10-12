import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { arch, hostname, release, version } from "node:os";
import { osPlugin } from "@bunaway/plugin-os/native/windows";
import { osOperations } from "#plugins/os/src/contract";

test.skipIf(process.platform !== "win32")(
  "Windows locale FFI and runtime metadata execute through generated Zod adapters",
  async () => {
    const platform = osPlugin.nativePlatforms.windows;
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
      if (locale.countryCode !== null) {
        expect(locale.countryCode).toMatch(/^[A-Z]{2,3}$/);
      }
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
