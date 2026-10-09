import { existsSync } from "node:fs";
import { resolve } from "node:path";

const [project, signal] = process.argv.slice(2);
if (!project || (signal !== "SIGINT" && signal !== "SIGTERM")) {
  throw new Error("Expected project and build signal.");
}
const initial = [
  process.listenerCount("SIGINT"),
  process.listenerCount("SIGTERM"),
];
// Compare against the baseline after cancellation to catch leaked CLI handlers.
// Windows process.kill terminates a process instead of delivering a console
// event. Emit the same Node signal event there; POSIX tests send a real signal.
const timer =
  process.platform === "win32"
    ? setInterval(() => {
        if (existsSync(resolve(project, "build-interrupt.txt"))) {
          clearInterval(timer);
          process.emit(signal);
        }
      }, 20)
    : undefined;
process.argv.splice(3);
try {
  await import("./build.fixture.ts");
} catch (error) {
  console.error(String(error));
  process.exitCode = 1;
} finally {
  clearInterval(timer);
}
if (
  initial.some(
    (count, index) =>
      count !== process.listenerCount(index ? "SIGTERM" : "SIGINT"),
  )
) {
  throw new Error("Build left signal handlers registered.");
}
console.log("PASS build signal handler cleanup");
