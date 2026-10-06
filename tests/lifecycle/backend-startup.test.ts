import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import {
  parseProcessFrame,
  PROCESS_IPC_VERSION,
  type ProcessFrame,
} from "../../packages/protocol/src/index.ts";

const backend = fileURLToPath(new URL("../../native/macos/probe/backend.ts", import.meta.url));
const base = { ipc: PROCESS_IPC_VERSION, runtime: { id: "probe", generation: "1" } };
const boot = { ...base, kind: "boot", payload: { entrypoint: backend, buildId: "macos-probe" } };
const shutdown = { ...base, kind: "shutdown" };

async function run(frames: unknown[]): Promise<{ exit: number; frames: ProcessFrame[] }> {
  const child = Bun.spawn([process.execPath, "--no-env-file", backend, "normal"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const deadline = setTimeout(() => child.kill(), 3000);
  try {
    const output = new Response(child.stdout).text();
    const errors = new Response(child.stderr).text();
    child.stdin.write(`${frames.map((frame) => JSON.stringify(frame)).join("\n")}\n`);
    child.stdin.end();
    const [exit, text, stderr] = await Promise.all([child.exited, output, errors]);
    expect(stderr).toBe("");
    return { exit, frames: text.trim().split("\n").map(parseProcessFrame) };
  } finally {
    clearTimeout(deadline);
    child.kill();
  }
}

for (const phase of ["before boot", "after boot"] as const) {
  test(`backend shutdown ${phase} is a normal cancellation`, async () => {
    const response = await run(phase === "before boot" ? [shutdown] : [boot, shutdown]);
    expect(response.exit).toBe(0);
    expect(response.frames.map((frame) => frame.kind)).toEqual(
      phase === "before boot" ? ["stopping"] : ["hello", "stopping"],
    );
  });
}

test("pre-ready shutdown still validates protocol and runtime identity", async () => {
  for (const frame of [
    { ...shutdown, ipc: { major: 2, minor: 0 } },
    { ...shutdown, runtime: { id: "probe", generation: "0" } },
  ]) {
    const response = await run([frame]);
    expect(response.exit).toBe(1);
    expect(response.frames.map((frame) => frame.kind)).toEqual(["fatal"]);
  }
});
