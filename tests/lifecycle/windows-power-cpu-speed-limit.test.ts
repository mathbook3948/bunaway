import { expect, test } from "bun:test";
import { powerOperations } from "#plugins/power/src/operations";
import { nativeFactory } from "../fixtures/native-platform.ts";

test.skipIf(process.platform !== "win32")(
  "real Windows CallNtPowerInformation reports an integer CPU speed limit and fails after dispose",
  async () => {
    const [{ default: nativeDefinition }, { createPower }] = await Promise.all([
      import("#plugins/power/src/index"),
      import("#plugins/power/src/platforms/windows-bindings"),
    ]);
    const adapter = nativeFactory(
      nativeDefinition,
      "windows",
    )({
      dataRoot: ".",
      capabilities: [],
    });
    const native = createPower();
    try {
      const result = powerOperations.getCpuSpeedLimit.output.parse(
        await adapter.execute("power.getCpuSpeedLimit", null, "backend"),
      );
      // Virtualized runners may report any throttle level, so only the range is stable.
      expect(Number.isInteger(result.speedLimitPercent)).toBe(true);
      expect(result.speedLimitPercent).toBeGreaterThanOrEqual(0);
      expect(result.speedLimitPercent).toBeLessThanOrEqual(100);
      expect(native.cpuSpeedLimit().speedLimitPercent).toBeLessThanOrEqual(100);
    } finally {
      native.dispose();
      await adapter.dispose();
    }
    expect(() => native.cpuSpeedLimit()).toThrow(
      expect.objectContaining({
        code: "CANCELLED",
      }),
    );
  },
);
