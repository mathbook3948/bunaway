import { expect, test } from "bun:test";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { PROCESS_IPC_VERSION, serializeProcessFrame } from "@bunaway/protocol";

test("iOS backend rejects delivery to a destroyed input without acknowledging consumption", async () => {
  const runtime = {
    id: "ios-input-test",
    generation: "1",
  };
  const worker = new Worker(
    new URL("./ios-backend-input.fixture.ts", import.meta.url),
    {
      workerData: runtime,
    },
  );
  try {
    expect((await once(worker, "message"))[0]).toBe("input-closed");
    const outcome = new Promise<string>((resolve) => {
      worker.once("error", () => resolve("error"));
      worker.once("message", (message: unknown) => resolve(String(message)));
      worker.once("exit", () => resolve("exit"));
    });
    worker.postMessage(
      serializeProcessFrame({
        kind: "shutdown",
        ipc: PROCESS_IPC_VERSION,
        runtime,
      }),
    );
    expect(await outcome).toBe("error");
  } finally {
    await worker.terminate();
  }
});
