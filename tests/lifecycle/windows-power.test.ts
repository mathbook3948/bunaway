import { nativeFactory } from "../fixtures/native-platform.ts";
import { expect, test } from "bun:test";
import { powerOperations } from "#plugins/power/src/operations";

test.skipIf(process.platform !== "win32")(
  "real Windows power status, session idle and power request handle lifecycle",
  async () => {
    const [{ createPower }, { default: nativeDefinition }, { dlopen, ptr }] =
      await Promise.all([
        import("#plugins/power/src/win32"),
        import("#plugins/power/src/index"),
        import("bun:ffi"),
      ]);
    const createOperations = nativeFactory(nativeDefinition, "windows");
    const driver = dlopen("kernel32.dll", {
      GetSystemPowerStatus: {
        args: [
          "ptr",
        ],
        returns: "i32",
      },
      GetHandleInformation: {
        args: [
          "u64",
          "ptr",
        ],
        returns: "i32",
      },
      GetTickCount: {
        args: [],
        returns: "u32",
      },
    });
    const native = createPower();
    const adapter = createOperations({
      dataRoot: ".",
      capabilities: [],
    });
    const flags = Buffer.alloc(4);
    let handle = 0n;
    try {
      const raw = Buffer.alloc(12);
      expect(driver.symbols.GetSystemPowerStatus(ptr(raw))).not.toBe(0);
      const status = powerOperations.getStatus.output.parse(
        await adapter.execute("power.getStatus", null, "backend"),
      );
      expect(status.source).toBe(
        raw[0] === 1 ? "ac" : raw[0] === 0 ? "battery" : "unknown",
      );
      expect(status.batteryPresent).toBe(
        raw[1] === 255 ? null : !((raw[1] ?? 0) & 128),
      );
      const idle = native.idle();
      expect(idle).toBeGreaterThanOrEqual(0);
      expect(idle).toBeLessThanOrEqual(Math.floor(0xffffffff / 1000));
      expect([
        "active",
        "idle",
      ]).toContain(
        powerOperations.getIdleState.output.parse(
          await adapter.execute(
            "power.getIdleState",
            {
              thresholdSeconds: 1,
            },
            "backend",
          ),
        ),
      );
      handle = native.start("display", "Bunaway native regression 😀");
      expect(driver.symbols.GetHandleInformation(handle, ptr(flags))).not.toBe(
        0,
      );
      native.stop(handle);
      expect(driver.symbols.GetHandleInformation(handle, ptr(flags))).toBe(0);
      handle = native.start("system", "Bunaway cleanup regression");
      native.dispose();
      native.dispose();
      expect(driver.symbols.GetHandleInformation(handle, ptr(flags))).toBe(0);
      expect(() => native.status()).toThrow(
        expect.objectContaining({
          code: "CANCELLED",
        }),
      );
      const first = powerOperations.startBlocker.output.parse(
        await adapter.execute(
          "power.startBlocker",
          {
            type: "system",
            reason: "test",
          },
          "backend",
        ),
      );
      const second = powerOperations.startBlocker.output.parse(
        await adapter.execute(
          "power.startBlocker",
          {
            type: "system",
            reason: "test",
          },
          "backend",
        ),
      );
      expect(first.id).not.toBe(second.id);
      expect(
        await adapter.execute(
          "power.isBlockerActive",
          {
            id: first.id,
          },
          "backend",
        ),
      ).toBe(true);
      expect(
        await adapter.execute(
          "power.stopBlocker",
          {
            id: first.id,
          },
          "backend",
        ),
      ).toBe(true);
      expect(
        await adapter.execute(
          "power.stopBlocker",
          {
            id: first.id,
          },
          "backend",
        ),
      ).toBe(false);
      expect(
        await adapter.execute("power.listBlockers", null, "backend"),
      ).toEqual([
        second,
      ]);
      await adapter.dispose();
      await adapter.dispose();
      await expect(
        adapter.execute("power.listBlockers", null, "backend"),
      ).rejects.toThrow(
        expect.objectContaining({
          code: "CANCELLED",
        }),
      );
    } finally {
      // Idempotent disposal closes outstanding requests even if an assertion fails.
      await adapter.dispose();
      native.dispose();
      driver.close();
    }
  },
);
