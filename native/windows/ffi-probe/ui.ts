import assert from "node:assert/strict";
import { parentPort, workerData } from "node:worker_threads";
import { runProbe } from "./main.ts";
import type { ProbeWorkerData } from "./worker.ts";

const views = workerData as ProbeWorkerData[];
assert(views.length >= 1 && views.length <= 2);
try {
  // Both windows and all their callbacks run on this one Bun UI thread.
  const results = await Promise.allSettled(views.map((view) => runProbe(view)));
  for (const result of results) if (result.status === "rejected") throw result.reason;
} finally {
  parentPort?.close();
}
