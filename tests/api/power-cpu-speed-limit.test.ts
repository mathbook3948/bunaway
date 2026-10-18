import { expect, test } from "bun:test";
import power from "@bunaway/plugin-power";
import { NativeRegistry } from "@bunaway/protocol";
import { cpuSpeedLimitSchema } from "#plugins/power/src/contract";
import { powerOperations } from "#plugins/power/src/operations";
import { cpuSpeedLimit } from "#plugins/power/src/platforms/windows-status";
import { pluginParsers } from "../fixtures/plugin-parsers.ts";

const parsers = pluginParsers("power", powerOperations);

/** Build a PROCESSOR_POWER_INFORMATION array from [maxMhz, mhzLimit] pairs. */
function processors(
  entries: [
    number,
    number,
  ][],
): Uint8Array {
  const bytes = new Uint8Array(entries.length * 24);
  const view = new DataView(bytes.buffer);
  entries.forEach(([maxMhz, limitMhz], index) => {
    view.setUint32(index * 24, index, true);
    view.setUint32(index * 24 + 4, maxMhz, true);
    view.setUint32(index * 24 + 8, limitMhz, true);
    view.setUint32(index * 24 + 12, limitMhz, true);
  });
  return bytes;
}

test("cpu speed limit takes the lowest per-processor ratio, skips MaxMhz 0 and rejects unusable data", () => {
  expect(
    cpuSpeedLimit(
      processors([
        [
          3000,
          3000,
        ],
        [
          3000,
          1500,
        ],
        [
          2000,
          1999,
        ],
      ]),
    ),
  ).toEqual({
    speedLimitPercent: 50,
  });
  expect(
    cpuSpeedLimit(
      processors([
        [
          0,
          0,
        ],
        [
          2000,
          2000,
        ],
      ]),
    ),
  ).toEqual({
    speedLimitPercent: 100,
  });
  // A limit above MaxMhz (turbo) never exceeds 100, and a zero limit is a real 0.
  expect(
    cpuSpeedLimit(
      processors([
        [
          2000,
          3000,
        ],
      ]),
    ),
  ).toEqual({
    speedLimitPercent: 100,
  });
  expect(
    cpuSpeedLimit(
      processors([
        [
          2000,
          0,
        ],
      ]),
    ),
  ).toEqual({
    speedLimitPercent: 0,
  });
  expect(() =>
    cpuSpeedLimit(
      processors([
        [
          0,
          0,
        ],
      ]),
    ),
  ).toThrow();
  expect(() => cpuSpeedLimit(new Uint8Array(0))).toThrow();
  expect(() => cpuSpeedLimit(new Uint8Array(30))).toThrow();
});

test("power.getCpuSpeedLimit accepts only null, returns 0..100 integers and needs its own grant", async () => {
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
        operation: "power.getCpuSpeedLimit",
        payload,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  }
  expect(
    (
      await parsers.validateCall({
        operation: "power.getCpuSpeedLimit",
        payload: null,
      })
    ).payload,
  ).toBeNull();
  for (const value of [
    0,
    100,
  ]) {
    expect(
      cpuSpeedLimitSchema.safeParse({
        speedLimitPercent: value,
      }).success,
    ).toBe(true);
  }
  for (const value of [
    -1,
    101,
    50.5,
  ]) {
    expect(
      cpuSpeedLimitSchema.safeParse({
        speedLimitPercent: value,
      }).success,
    ).toBe(false);
  }
  const call = {
    operation: "power.getCpuSpeedLimit",
    payload: null,
  };
  expect(
    registry.allowed(
      {
        permissions: [
          "power.getStatus",
        ],
      },
      call,
    ),
  ).toBe(false);
  expect(
    registry.allowed(
      {
        permissions: [
          "power.getCpuSpeedLimit",
        ],
      },
      call,
    ),
  ).toBe(true);
});
