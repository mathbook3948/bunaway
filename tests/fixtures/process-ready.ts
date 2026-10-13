import assert from "node:assert/strict";
import { rename } from "node:fs/promises";

const pidFile = process.argv[2];
assert(pidFile);
// File existence signals readiness only after the complete PID is written.
const pendingFile = `${pidFile}.pending`;
await Bun.write(pendingFile, String(process.pid));
await rename(pendingFile, pidFile);
setInterval(() => {}, 1000);
