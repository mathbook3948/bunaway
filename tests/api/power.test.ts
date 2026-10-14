import { expect, test } from "bun:test";
import power from "@bunaway/plugin-power";
import { NativeRegistry } from "@bunaway/protocol";
import { powerOperations } from "#plugins/power/src/operations";
import {
  MAX_POWER_BLOCKERS,
  PowerBlockers,
} from "#plugins/power/src/platforms/windows-blockers";
import {
  idleSeconds,
  powerStatus,
} from "#plugins/power/src/platforms/windows-status";
import { pluginParsers } from "../fixtures/plugin-parsers.ts";

const parsers = pluginParsers("power", powerOperations);

test("power status preserves unknown battery measurements, absent batteries and tick wraparound", () => {
  const bytes = new Uint8Array(12);
  bytes.set([
    1,
    8,
    65,
    1,
  ]);
  const data = new DataView(bytes.buffer);
  data.setUint32(4, 1200, true);
  data.setUint32(8, 3600, true);
  expect(powerStatus(bytes)).toEqual({
    source: "ac",
    batteryPresent: true,
    charging: true,
    batteryPercent: 65,
    batterySaver: true,
    remainingSeconds: 1200,
    fullLifeSeconds: 3600,
  });
  bytes.set([
    0,
    0,
    0,
    0,
  ]);
  expect(powerStatus(bytes)).toMatchObject({
    source: "battery",
    batteryPresent: true,
    charging: false,
    batteryPercent: 0,
    batterySaver: false,
  });
  bytes.set([
    255,
    255,
    255,
    0,
  ]);
  data.setUint32(4, 0xffffffff, true);
  data.setUint32(8, 0xffffffff, true);
  expect(powerStatus(bytes)).toEqual({
    source: "unknown",
    batteryPresent: null,
    charging: null,
    batteryPercent: null,
    batterySaver: false,
    remainingSeconds: null,
    fullLifeSeconds: null,
  });
  bytes.set([
    1,
    128,
    50,
    0,
  ]);
  data.setUint32(4, 100, true);
  expect(powerStatus(bytes)).toMatchObject({
    batteryPresent: false,
    charging: false,
    batteryPercent: null,
    remainingSeconds: null,
    fullLifeSeconds: null,
  });
  expect(idleSeconds(1500, 1000)).toBe(0);
  expect(idleSeconds(4000, 1000)).toBe(3);
  expect(idleSeconds(500, 0xfffffc18)).toBe(1);
  expect(() => powerStatus(new Uint8Array(8))).toThrow();
});

test("power operations validate blocker inputs and grant queries independently of request control", async () => {
  const registry = new NativeRegistry([
    power._definition,
  ]);
  for (const input of [
    {
      type: "away",
      reason: "work",
    },
    {
      type: "system",
      reason: "",
    },
    {
      type: "system",
      reason: "x\0y",
    },
    {
      type: "system",
      reason: "x".repeat(513),
    },
    {
      type: "display",
      reason: "work",
      id: crypto.randomUUID(),
    },
  ]) {
    await expect(
      parsers.validateCall({
        operation: "power.startBlocker",
        payload: input,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  }
  for (const thresholdSeconds of [
    0,
    -1,
    1.5,
    4294968,
  ]) {
    await expect(
      parsers.validateCall({
        operation: "power.getIdleState",
        payload: {
          thresholdSeconds,
        },
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  }
  const input = {
    type: "display",
    reason: "내보내기 😀",
  };
  expect(
    (
      await parsers.validateCall({
        operation: "power.startBlocker",
        payload: input,
      })
    ).payload,
  ).toEqual(input);
  const policy = {
    permissions: [
      "power.getStatus",
      "power.listBlockers",
    ],
  };
  expect(
    registry.allowed(policy, {
      operation: "power.getStatus",
      payload: null,
    }),
  ).toBe(true);
  expect(
    registry.allowed(policy, {
      operation: "power.startBlocker",
      payload: input,
    }),
  ).toBe(false);
  expect(
    registry.allowed(policy, {
      operation: "power.stopBlocker",
      payload: {
        id: crypto.randomUUID(),
      },
    }),
  ).toBe(false);
  await expect(
    parsers.validateCall({
      operation: "power.stopBlocker",
      payload: {
        id: "native-handle",
      },
    }),
  ).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
});

test("power blocker reason boundaries count Unicode code points, including supplementary and combining characters", async () => {
  for (const reason of [
    "😀",
    "x".repeat(512),
    "😀".repeat(512),
    "e\u0301".repeat(256),
  ]) {
    const payload = {
      type: "system",
      reason,
    };
    expect(
      (
        await parsers.validateCall({
          operation: "power.startBlocker",
          payload,
        })
      ).payload,
    ).toEqual(payload);
  }
  for (const reason of [
    "😀".repeat(513),
    `${"e\u0301".repeat(256)}😀`,
  ]) {
    await expect(
      parsers.validateCall({
        operation: "power.startBlocker",
        payload: {
          type: "system",
          reason,
        },
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  }
});

test("duplicate blocker starts remain independent; capacity, failed activation and retryable cleanup preserve ownership", () => {
  let sequence = 0n;
  let failStart = false;
  let failStop: bigint | null = null;
  const open = new Set<bigint>();
  const blockers = new PowerBlockers({
    start() {
      if (failStart) {
        throw new Error("activation failure");
      }
      const handle = ++sequence;
      open.add(handle);
      return handle;
    },
    stop(handle) {
      if (handle === failStop) {
        throw new Error("close failure");
      }
      expect(open.delete(handle)).toBe(true);
    },
  });
  failStart = true;
  expect(() => blockers.start("system", "test")).toThrow("activation failure");
  expect(blockers.list()).toEqual([]);
  failStart = false;
  const first = blockers.start("display", "same reason");
  const second = blockers.start("display", "same reason");
  expect(first.id).not.toBe(second.id);
  expect(blockers.stop(first.id)).toBe(true);
  expect(blockers.stop(first.id)).toBe(false);
  expect(blockers.active(second.id)).toBe(true);
  failStop = 2n;
  expect(() => blockers.stop(second.id)).toThrow("close failure");
  expect(blockers.active(second.id)).toBe(true);
  for (let index = 1; index < MAX_POWER_BLOCKERS; index++) {
    blockers.start("system", "capacity");
  }
  expect(() => blockers.start("system", "overflow")).toThrow(
    expect.objectContaining({
      code: "BUSY",
    }),
  );
  expect(() => blockers.dispose()).toThrow(AggregateError);
  expect(blockers.list()).toEqual([
    second,
  ]);
  expect(open.size).toBe(1);
  expect(() => blockers.start("system", "after disposal")).toThrow(
    expect.objectContaining({
      code: "CANCELLED",
    }),
  );
  failStop = null;
  blockers.dispose();
  blockers.dispose();
  expect(open.size).toBe(0);
  expect(blockers.list()).toEqual([]);
});

test("display activation rolls back system counts, retains failed closes, and closes after OS-terminated counts", async () => {
  const { PowerRequestHandles } = await import(
    "#plugins/power/src/platforms/windows-request-handles"
  );
  const calls: string[] = [];
  let sequence = 0n;
  let failSet = true;
  let failClose = true;
  const native = new PowerRequestHandles({
    create(reason) {
      calls.push(reason);
      return ++sequence;
    },
    set(handle, type) {
      calls.push(`set:${handle}:${type}`);
      return !(failSet && type === 0);
    },
    clear(handle, type) {
      calls.push(`clear:${handle}:${type}`);
      return false;
    },
    close(handle) {
      calls.push(`close:${handle}`);
      return !failClose;
    },
  });
  expect(() => native.start("display", "rollback")).toThrow(AggregateError);
  expect(calls).toEqual([
    "rollback",
    "set:1:1",
    "set:1:0",
    "clear:1:1",
    "close:1",
  ]);
  failSet = false;
  failClose = false;
  const handle = native.start("display", "live");
  native.dispose();
  native.dispose();
  expect(calls).toContain("close:1");
  expect(calls.filter((call) => call === "clear:1:1").length).toBe(1);
  expect(calls).toContain(`clear:${handle}:1`);
  expect(calls).toContain(`clear:${handle}:0`);
  expect(calls.filter((call) => call === `close:${handle}`).length).toBe(1);
});
