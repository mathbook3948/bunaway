import { expect, test } from "bun:test";
import power from "@bunaway/plugin-power";
import type { PowerStatus } from "#plugins/power/src/contract";
import {
  macosPowerOperations,
  powerOperations,
} from "#plugins/power/src/operations";
import { watchMacosPowerLifecycle } from "#plugins/power/src/platforms/macos-lifecycle-events";
import {
  createStatusPublisher,
  watchMacosPowerStatus,
} from "#plugins/power/src/platforms/macos-status-events";

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

test("macOS lifecycle events are not observed when the host has no event service", () => {
  expect(watchMacosPowerLifecycle(undefined)).toBeUndefined();
});

test("macOS power status is not observed when the host has no event service", () => {
  expect(watchMacosPowerStatus(() => onAc, undefined)).toBeUndefined();
});

const onAc: PowerStatus = {
  source: "ac",
  batteryPresent: true,
  charging: true,
  batteryPercent: 80,
  batterySaver: false,
  remainingSeconds: null,
  fullLifeSeconds: null,
};

test("a power source notification emits only when the status differs from the last one", () => {
  let status = onAc;
  let failRead = false;
  const emitted: PowerStatus[] = [];
  const notify = createStatusPublisher(
    () => {
      if (failRead) {
        throw new Error("Read failed");
      }
      return structuredClone(status);
    },
    {
      emit: (_event, payload) => emitted.push(payload),
    },
  );
  // The baseline is the first read, so an unchanged status stays silent.
  notify();
  expect(emitted).toEqual([]);
  status = {
    ...onAc,
    source: "battery",
    charging: false,
    remainingSeconds: 7200,
  };
  notify();
  notify();
  expect(emitted).toEqual([
    status,
  ]);
  // A failed read keeps the baseline, and the next notification reports the pending change.
  failRead = true;
  status = {
    ...status,
    batteryPercent: 79,
  };
  notify();
  expect(emitted).toHaveLength(1);
  failRead = false;
  notify();
  expect(emitted).toHaveLength(2);
  expect(emitted[1]?.batteryPercent).toBe(79);
});
