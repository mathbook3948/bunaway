import { expect, test } from "bun:test";
import power from "@bunaway/plugin-power";
import {
  macosPowerOperations,
  powerOperations,
} from "#plugins/power/src/operations";

test("macOS implements the queries and blockers, and shares their schemas with Windows", () => {
  const macos = power._definition.nativePlatforms.macos;
  expect(macos?.operations).toEqual([
    "getStatus",
    "getIdleTime",
    "getIdleState",
    "startBlocker",
    "listBlockers",
    "isBlockerActive",
    "stopBlocker",
  ]);
  // The same output schemas validate both platforms, so a macOS result cannot drift from the contract.
  expect(macosPowerOperations.getStatus.output).toBe(
    powerOperations.getStatus.output,
  );
  expect(macosPowerOperations.getIdleTime.output).toBe(
    powerOperations.getIdleTime.output,
  );
  expect(macosPowerOperations.getIdleState.input).toBe(
    powerOperations.getIdleState.input,
  );
  expect(macosPowerOperations.getStatus.input.safeParse(null).success).toBe(
    true,
  );
  expect(macosPowerOperations.getIdleTime.input.safeParse({}).success).toBe(
    false,
  );
  const windows = power._definition.nativePlatforms.windows;
  expect(windows?.operations).toContain("startBlocker");
  expect(macos?.operations).not.toContain("getCpuSpeedLimit");
  // Blocker inputs and results use the Windows schemas, so a macOS result cannot drift from them.
  expect(macosPowerOperations.startBlocker.input).toBe(
    powerOperations.startBlocker.input,
  );
  expect(macosPowerOperations.startBlocker.output).toBe(
    powerOperations.startBlocker.output,
  );
  expect(macosPowerOperations.stopBlocker.input).toBe(
    powerOperations.stopBlocker.input,
  );
  expect(macosPowerOperations.isBlockerActive.input).toBe(
    powerOperations.isBlockerActive.input,
  );
  expect(macosPowerOperations.listBlockers.input.safeParse(null).success).toBe(
    true,
  );
});
