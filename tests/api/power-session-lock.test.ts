import { expect, test } from "bun:test";
import power from "@bunaway/plugin-power";
import { NativeRegistry } from "@bunaway/protocol";
import { sessionLockSchema } from "#plugins/power/src/contract";
import { powerOperations } from "#plugins/power/src/operations";
import {
  sessionLocked,
  WTS_INFO_EX_MIN_BYTES,
} from "#plugins/power/src/platforms/windows-status";
import { pluginParsers } from "../fixtures/plugin-parsers.ts";

const parsers = pluginParsers("power", powerOperations);

/** Build a WTSINFOEXW with the given level and SessionFlags. */
function sessionInfo(level: number, flags: number): Uint8Array {
  const bytes = new Uint8Array(WTS_INFO_EX_MIN_BYTES);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, level, true);
  view.setUint32(16, flags, true);
  return bytes;
}

test("sessionLocked reads WTS_SESSIONSTATE_LOCK as locked and UNLOCK as unlocked", () => {
  expect(sessionLocked(sessionInfo(1, 0))).toBe(true);
  expect(sessionLocked(sessionInfo(1, 1))).toBe(false);
  // A longer buffer, as the system returns the whole WTSINFOEXW, still decodes at the same offset.
  const longer = new Uint8Array(208);
  longer.set(sessionInfo(1, 0));
  expect(sessionLocked(longer)).toBe(true);
});

test("sessionLocked rejects an unknown state, another level and a short buffer instead of reporting unlocked", () => {
  expect(() => sessionLocked(sessionInfo(1, 0xffffffff))).toThrow("unknown");
  expect(() => sessionLocked(sessionInfo(1, 2))).toThrow("unknown");
  expect(() => sessionLocked(sessionInfo(0, 1))).toThrow("level 1");
  expect(() => sessionLocked(sessionInfo(2, 1))).toThrow("level 1");
  expect(() =>
    sessionLocked(new Uint8Array(WTS_INFO_EX_MIN_BYTES - 1)),
  ).toThrow("shorter");
});

test("power.isSessionLocked accepts only null, returns a strict boolean object and needs its own grant", async () => {
  const registry = new NativeRegistry([
    power._definition,
  ]);
  for (const payload of [
    {},
    0,
    "",
  ]) {
    await expect(
      parsers.validateCall({
        operation: "power.isSessionLocked",
        payload,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  }
  expect(
    (
      await parsers.validateCall({
        operation: "power.isSessionLocked",
        payload: null,
      })
    ).payload,
  ).toBeNull();
  for (const value of [
    true,
    false,
  ]) {
    expect(
      sessionLockSchema.safeParse({
        locked: value,
      }).success,
    ).toBe(true);
  }
  for (const value of [
    {},
    {
      locked: 1,
    },
    {
      locked: false,
      idle: true,
    },
  ]) {
    expect(sessionLockSchema.safeParse(value).success).toBe(false);
  }
  const call = {
    operation: "power.isSessionLocked",
    payload: null,
  };
  expect(
    registry.allowed(
      {
        permissions: [
          "power.getIdleState",
        ],
      },
      call,
    ),
  ).toBe(false);
  expect(
    registry.allowed(
      {
        permissions: [
          "power.isSessionLocked",
        ],
      },
      call,
    ),
  ).toBe(true);
});

test("only Windows registers power.isSessionLocked and getIdleState keeps its active and idle result", () => {
  const platforms = power._definition.nativePlatforms;
  expect(platforms.windows?.operations).toContain("isSessionLocked");
  expect(platforms.macos?.operations).not.toContain("isSessionLocked");
  expect(powerOperations.getIdleState.output.safeParse("locked").success).toBe(
    false,
  );
});
