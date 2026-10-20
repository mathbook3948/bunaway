import { expect, setDefaultTimeout, test } from "bun:test";
import { resolve } from "node:path";
import { statusSchema } from "#plugins/power/src/contract";
import {
  type DeadlineName,
  deadline,
  killAfter,
} from "../fixtures/deadlines.ts";

setDefaultTimeout(deadline("nativeFixture"));

/** Run the packaged macOS power adapter in a fresh process and return what it printed. */
async function runAdapter(
  script: string,
  limit: DeadlineName = "childStep",
  withEvents = false,
) {
  const entry = Bun.resolveSync(
    "@bunaway/plugin-power/native/macos",
    import.meta.dir,
  );
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "-e",
      `const { default: power } = await import(${JSON.stringify(entry)});
const emitted = [];
const events = ${withEvents ? "{ emit: (event, payload) => emitted.push([event, payload]) }" : "undefined"};
const adapter = power._definition.nativePlatforms.macos.create({dataRoot:".",capabilities:[],events});
const call = (name, input) => adapter.execute("power." + name, input, "backend");
${script}`,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const timer = killAfter(child, limit);
  const [output, errors, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  clearTimeout(timer);
  expect(code, errors).toBe(0);
  return JSON.parse(output);
}

test.skipIf(process.platform !== "darwin")(
  "macOS power status and idle time come from the system and stay within the contract",
  async () => {
    const result = await runAdapter(`
try {
  const status = await call("getStatus", null);
  const idle = await call("getIdleTime", null);
  const stateAtOneYear = await call("getIdleState", { thresholdSeconds: 4294967 });
  console.log(JSON.stringify({ status, idle, stateAtOneYear }));
} finally {
  await adapter.dispose();
}`);
    const status = statusSchema.parse(result.status);
    if (status.batteryPresent === false) {
      // A machine without a battery has no percentage or estimates, and cannot be charging.
      expect(status.batteryPercent).toBeNull();
      expect(status.charging).toBe(false);
    }
    if (status.source !== "battery") {
      expect(status.remainingSeconds).toBeNull();
    }
    // macOS reports no full-charge duration estimate.
    expect(status.fullLifeSeconds).toBeNull();
    expect(Number.isInteger(result.idle)).toBe(true);
    expect(result.idle).toBeGreaterThanOrEqual(0);
    expect(result.stateAtOneYear).toBe("active");
  },
);

test.skipIf(process.platform !== "darwin")(
  "repeated macOS power reads keep returning contract values under GC pressure",
  async () => {
    const result = await runAdapter(
      `
try {
  Bun.unsafe.gcAggressionLevel(2);
  let last;
  for (let index = 0; index < 500; index++) {
    last = await call("getStatus", null);
    await call("getIdleTime", null);
    if (index % 25 === 0) Bun.gc(true);
  }
  Bun.unsafe.gcAggressionLevel(0);
  Bun.gc(true);
  console.log(JSON.stringify({ last }));
} finally {
  await adapter.dispose();
}`,
      "build",
    );
    statusSchema.parse(result.last);
  },
);

test.skipIf(process.platform !== "darwin")(
  "a disposed macOS power adapter refuses queries and disposes twice safely",
  async () => {
    const result = await runAdapter(`
await adapter.dispose();
await adapter.dispose();
const code = await call("getStatus", null).then(() => "resolved", (error) => error.code);
console.log(JSON.stringify({ code }));`);
    expect(result.code).toBe("CANCELLED");
  },
);

test.skipIf(process.platform !== "darwin")(
  "macOS blockers create and release real power assertions that the system lists",
  async () => {
    const result = await runAdapter(
      `
const listed = (reason) => {
  const out = Bun.spawnSync(["/usr/bin/pmset", "-g", "assertions"]).stdout.toString();
  return out.includes(reason);
};
try {
  const system = await call("startBlocker", { type: "system", reason: "bunaway-blocker-system" });
  const display = await call("startBlocker", { type: "display", reason: "bunaway-blocker-display" });
  const duplicate = await call("startBlocker", { type: "system", reason: "bunaway-blocker-system" });
  const active = await call("listBlockers", null);
  const whileActive = {
    system: listed("bunaway-blocker-system"),
    display: listed("bunaway-blocker-display"),
    isActive: await call("isBlockerActive", { id: system.id }),
  };
  const stopped = await call("stopBlocker", { id: system.id });
  const stoppedAgain = await call("stopBlocker", { id: system.id });
  await call("stopBlocker", { id: duplicate.id });
  const afterStop = {
    system: listed("bunaway-blocker-system"),
    display: listed("bunaway-blocker-display"),
    isActive: await call("isBlockerActive", { id: system.id }),
  };
  console.log(JSON.stringify({ system, display, duplicate, active, whileActive, stopped, stoppedAgain, afterStop }));
} finally {
  await adapter.dispose();
}`,
    );
    expect(result.system.type).toBe("system");
    expect(result.display.type).toBe("display");
    expect(result.duplicate.id).not.toBe(result.system.id);
    expect(result.active).toHaveLength(3);
    expect(result.whileActive).toEqual({
      system: true,
      display: true,
      isActive: true,
    });
    expect(result.stopped).toBe(true);
    expect(result.stoppedAgain).toBe(false);
    expect(result.afterStop).toEqual({
      system: false,
      display: true,
      isActive: false,
    });
  },
);

test.skipIf(process.platform !== "darwin")(
  "disposing the macOS power adapter releases every open assertion",
  async () => {
    const result = await runAdapter(`
const listed = () =>
  Bun.spawnSync(["/usr/bin/pmset", "-g", "assertions"]).stdout.toString().includes("bunaway-blocker-dispose");
await call("startBlocker", { type: "display", reason: "bunaway-blocker-dispose" });
const before = listed();
await adapter.dispose();
const after = listed();
const code = await call("startBlocker", { type: "system", reason: "x" }).then(() => "resolved", (error) => error.code);
console.log(JSON.stringify({ before, after, code }));`);
    expect(result).toEqual({
      before: true,
      after: false,
      code: "CANCELLED",
    });
  },
);

test.skipIf(process.platform !== "darwin")(
  "operations outside the macOS scope are unsupported",
  async () => {
    const result = await runAdapter(`
try {
  const code = await call("getCpuSpeedLimit", null).then(() => "resolved", (error) => error.code);
  console.log(JSON.stringify({ code }));
} finally {
  await adapter.dispose();
}`);
    expect(result).toEqual({
      code: "UNSUPPORTED",
    });
  },
);

const PUMP = resolve(import.meta.dir, "fixtures/macos-notification-pump.ts");

test.skipIf(process.platform !== "darwin")(
  "macOS sleep, wake, lock and unlock notifications become payload-free power events until dispose",
  async () => {
    const result = await runAdapter(
      `
const { post, pumpTurns, pumpUntil } = await import(${JSON.stringify(PUMP)});
const deliver = async (center, name, count) => {
  post(center, name);
  await pumpUntil(() => emitted.length >= count, name);
};
try {
  await deliver("workspace", "NSWorkspaceWillSleepNotification", 1);
  await deliver("workspace", "NSWorkspaceDidWakeNotification", 2);
  await deliver("distributed", "com.apple.screenIsLocked", 3);
  await deliver("distributed", "com.apple.screenIsUnlocked", 4);
  const whileWatching = emitted.splice(0);
  await adapter.dispose();
  await adapter.dispose();
  post("workspace", "NSWorkspaceWillSleepNotification");
  post("distributed", "com.apple.screenIsLocked");
  pumpTurns(25);
  console.log(JSON.stringify({ whileWatching, afterDispose: emitted }));
} finally {
  await adapter.dispose();
}`,
      "nativeFixture",
      true,
    );
    expect(result).toEqual({
      whileWatching: [
        [
          "power.suspended",
          {},
        ],
        [
          "power.resumed",
          {},
        ],
        [
          "power.sessionLocked",
          {},
        ],
        [
          "power.sessionUnlocked",
          {},
        ],
      ],
      afterDispose: [],
    });
  },
);
