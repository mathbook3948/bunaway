import { expect, setDefaultTimeout, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { deadline } from "../fixtures/deadlines.ts";

// A cold Zod load in a Worker can pass the 5s default on a loaded Windows runner.
setDefaultTimeout(deadline("toolchain"));

for (const format of [
  "esm",
  "cjs",
]) {
  test(`Zod ${format} observes abandoned work and preserves parsing behavior`, async () => {
    const worker = new Worker(
      fileURLToPath(
        new URL("../fixtures/zod-promise-worker.ts", import.meta.url),
      ),
      {
        workerData: format,
      },
    );
    const messages: unknown[] = [];
    worker.on("message", (value) => messages.push(value));
    try {
      const code = await new Promise<number>((resolve, reject) => {
        worker.once("exit", resolve);
        worker.once("error", reject);
      });
      expect(code).toBe(0);
      expect(messages).toEqual([
        "alive",
      ]);
    } finally {
      await worker.terminate();
    }
  });
}

test("Zod source exports carry the same Promise ownership patch", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "--conditions=@zod/source",
      fileURLToPath(
        new URL("../fixtures/zod-promise-worker.ts", import.meta.url),
      ),
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10000,
    },
  );
  const [code, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);
  expect(stderr).toBe("");
  expect(code).toBe(0);
});
