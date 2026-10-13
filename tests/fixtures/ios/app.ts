import { appendFile, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { command, defineApp } from "@bunaway/backend";
import { BunawayError } from "@bunaway/protocol";
import data from "./backend-data.txt" with { type: "file" };
import { BACKEND_BUSY_MS, BURST_EVENT_COUNT } from "./limits.ts";

// Fixture logs must not corrupt the host control stream.
console.log("iOS backend Worker ready");
let count = 0;
const nullable = {
  const: null,
} as const;
export const app = defineApp({
  modules: [],
  events: {
    "test.changed": {
      type: "integer",
    },
  },
  commands: {
    "test.burst": command({
      input: nullable,
      output: nullable,
      handle: async (_value, context) => {
        await Bun.sleep(100);
        for (let index = 0; index < BURST_EVENT_COUNT; index++) {
          await context.events.emit("test.changed", index, {
            kind: "broadcast",
          });
          // Let Core flush its subscription queue while WebKit is deliberately busy.
          await Bun.sleep(1);
        }
        return null;
      },
    }),
    "test.block": command({
      input: nullable,
      output: nullable,
      handle: () => {
        Bun.sleepSync(BACKEND_BUSY_MS);
        return null;
      },
    }),
    "test.echo": command({
      input: {
        type: "string",
      },
      output: {
        type: "string",
      },
      handle: (value) => value,
    }),
    "test.count": command({
      input: nullable,
      output: {
        type: "integer",
      },
      handle: async (_value, context) => {
        count++;
        await context.events.emit("test.changed", count, {
          kind: "broadcast",
        });
        return count;
      },
    }),
    "test.files": command({
      input: nullable,
      output: {
        type: "string",
      },
      handle: () => readFile(new URL(data, import.meta.url), "utf8"),
    }),
    "test.hold": command({
      input: nullable,
      output: nullable,
      handle: (_value, { signal }) => {
        if (signal.aborted) {
          return null;
        }
        return new Promise<null>((resolve) => {
          const aborted = () => {
            signal.removeEventListener("abort", aborted);
            resolve(null);
          };
          signal.addEventListener("abort", aborted);
        });
      },
    }),
    "test.denied": command({
      input: nullable,
      output: nullable,
      handle: () => null,
    }),
    "test.error": command({
      input: nullable,
      output: nullable,
      handle: () => {
        throw new BunawayError({
          code: "INVALID_ARGUMENT",
          message: "Fixture error.",
        });
      },
    }),
    "test.record": command({
      input: {
        type: "string",
      },
      output: nullable,
      handle: async (value) => {
        await appendFile(join(homedir(), "ios-results.jsonl"), `${value}\n`);
        return null;
      },
    }),
  },
});
export default app;
