import { expect, setDefaultTimeout, test } from "bun:test";
import { statusSchema } from "#plugins/power/src/contract";
import {
  type DeadlineName,
  deadline,
  killAfter,
} from "../fixtures/deadlines.ts";

setDefaultTimeout(deadline("nativeFixture"));

/** Run the packaged macOS power adapter in a fresh process and return what it printed. */
async function runAdapter(script: string, limit: DeadlineName = "childStep") {
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
const adapter = power._definition.nativePlatforms.macos.create({dataRoot:".",capabilities:[]});
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
  "operations outside the macOS read-only scope are unsupported",
  async () => {
    const result = await runAdapter(`
try {
  const codes = {};
  for (const name of ["getCpuSpeedLimit", "listBlockers", "startBlocker"]) {
    codes[name] = await call(name, name === "startBlocker" ? { type: "system", reason: "x" } : null)
      .then(() => "resolved", (error) => error.code);
  }
  console.log(JSON.stringify(codes));
} finally {
  await adapter.dispose();
}`);
    expect(result).toEqual({
      getCpuSpeedLimit: "UNSUPPORTED",
      listBlockers: "UNSUPPORTED",
      startBlocker: "UNSUPPORTED",
    });
  },
);
