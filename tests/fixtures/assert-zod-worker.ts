import { expect } from "bun:test";
import { Worker } from "node:worker_threads";

/** Exercise identical SDK input/output cases in source and installed app Workers. */
export async function assertZodWorker(entry: string | URL): Promise<void> {
  const worker = new Worker(entry);
  const exit = new Promise<number>((resolve, reject) => {
    worker.once("exit", resolve);
    worker.once("error", reject);
  });
  const request = (operation: string) =>
    Promise.race([
      new Promise<unknown>((resolve) => {
        worker.once("message", resolve);
        worker.postMessage(operation);
      }),
      exit.then((code) => {
        throw new Error(`Worker exited before replying: ${code}`);
      }),
    ]);
  try {
    for (const mode of [
      "refine",
      "promise",
      "transform",
      "nested",
      "checks",
      "checkChain",
      "object",
      "array",
      "tuple",
      "union",
      "intersection",
      "record",
      "when",
      "never",
    ]) {
      for (const boundary of [
        "input",
        "output",
      ]) {
        for (const execution of [
          "io",
          "ui",
        ]) {
          expect(await request(`${execution}:${mode}:${boundary}`)).toEqual({
            kind: "error",
            error: {
              code: boundary === "input" ? "INVALID_ARGUMENT" : "INTERNAL",
              message: `Invalid plugin ${boundary}.`,
            },
          });
          expect(await request("ping")).toEqual({
            kind: "result",
            payload: "alive",
          });
        }
      }
    }
    worker.postMessage("close");
    expect(await exit).toBe(0);
  } finally {
    await worker.terminate();
  }
}
