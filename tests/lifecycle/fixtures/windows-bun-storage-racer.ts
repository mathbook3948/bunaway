import { unlink, writeFile } from "node:fs/promises";
import { parentPort, workerData } from "node:worker_threads";

const config = workerData as {
  path: string;
  state: SharedArrayBuffer;
};
// Shared write/delete counts let the driver observe progress while running synchronous FFI.
const state = new Int32Array(config.state);
let stopping = false;
parentPort?.on("message", () => {
  stopping = true;
});
parentPort?.postMessage("ready");

while (!stopping) {
  try {
    await writeFile(config.path, "changing file");
    Atomics.add(state, 0, 1);
    await unlink(config.path);
    Atomics.add(state, 1, 1);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // The query deliberately pins the file against deletion until its handle closes.
    if (
      ![
        "ENOENT",
        "EPERM",
        "EACCES",
        "EBUSY",
      ].includes(code ?? "")
    ) {
      parentPort?.postMessage({
        error: String(error),
      });
      break;
    }
  }
}
parentPort?.close();
