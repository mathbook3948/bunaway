import { expect, test } from "bun:test";
import { powerOperations } from "#plugins/power/src/operations";
import { nativeFactory } from "../fixtures/native-platform.ts";

test.skipIf(process.platform !== "win32")(
  "real Windows WTSQuerySessionInformationW reports a boolean lock state and fails after dispose",
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
      const result = powerOperations.isSessionLocked.output.parse(
        await adapter.execute("power.isSessionLocked", null, "backend"),
      );
      console.log(`PROBE power.isSessionLocked locked=${result.locked}`);
      expect(typeof result.locked).toBe("boolean");
      expect(typeof native.sessionLocked()).toBe("boolean");
      // Repeated queries free each system buffer, so many calls neither fail nor drift.
      for (let index = 0; index < 200; index += 1) {
        expect(native.sessionLocked()).toBe(result.locked);
      }
    } finally {
      native.dispose();
      await adapter.dispose();
    }
    expect(() => native.sessionLocked()).toThrow(
      expect.objectContaining({
        code: "CANCELLED",
      }),
    );
  },
);
