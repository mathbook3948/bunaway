import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineApp } from "@bunaway/backend";
import type { CommandContext } from "@bunaway/core";
import { windowsPlugin } from "@bunaway/plugin-windows";
import { probe } from "./probe.ts";

let phase = 0;
const temporary = process.env.TMPDIR;
if (!temporary) {
  throw new Error("Missing fixture temp directory.");
}
export default defineApp({
  modules: [],
  plugins: [
    probe.definition,
    windowsPlugin,
    {
      name: "setup-probe",
      version: "1",
      async setup() {
        const result = await probe.api.run({
          id: "setup",
          mode: "normal",
        });
        if (result.source !== "backend" || result.main) {
          throw new Error("Backend I/O route failed.");
        }
        // This setup-owned timer preserves backend authority when the page asks
        // to start work whose native cancellation must precede Core stop hooks.
        let pending: Promise<unknown> | undefined;
        const watcher = setInterval(() => {
          if (!existsSync(resolve(temporary, "start-shutdown-work"))) {
            return;
          }
          clearInterval(watcher);
          pending = probe.api
            .run({
              id: "shutdown",
              mode: "wait-abort",
            })
            .catch((error) => {
              if (error.code !== "CANCELLED") {
                throw error;
              }
            });
          void pending.catch((error) =>
            console.error("Shutdown probe failed:", error),
          );
        }, 5);
        return async () => {
          clearInterval(watcher);
          if (pending) {
            await pending;
            while (!existsSync(resolve(temporary, "shutdown-aborted"))) {
              await Bun.sleep(5);
            }
            if (existsSync(resolve(temporary, "io-disposing"))) {
              throw new Error("Adapter disposal ran before the stop hook.");
            }
          }
          writeFileSync(resolve(temporary, "core-cleaned"), "done");
        };
      },
    },
  ],
  events: {},
  commands: {
    "test.phase": {
      input: {
        const: null,
      },
      output: {
        type: "integer",
      },
      run: async () => ++phase,
    },
    "test.responsive": {
      input: {
        const: null,
      },
      output: {
        type: "boolean",
      },
      run: async () => !existsSync(resolve(temporary, "blocking-executed")),
    },
    "test.ping": {
      input: {
        const: null,
      },
      output: {
        const: "pong",
      },
      run: async () => "pong",
    },
    "test.startShutdownWork": {
      input: {
        const: null,
      },
      output: {
        const: null,
      },
      async run() {
        writeFileSync(resolve(temporary, "start-shutdown-work"), "start");
        while (!existsSync(resolve(temporary, "shutdown-executing"))) {
          await Bun.sleep(5);
        }
        return null;
      },
    },
    "test.marker": {
      input: {
        type: "string",
        pattern: "^[a-z0-9-]+$",
      },
      output: {
        const: null,
      },
      async run(value: unknown, context: CommandContext) {
        while (!existsSync(resolve(temporary, String(value)))) {
          if (context.signal.aborted) {
            throw new Error("Marker wait cancelled.");
          }
          await Bun.sleep(5);
        }
        return null;
      },
    },
    "test.release": {
      input: {
        type: "string",
        pattern: "^[a-z0-9-]+$",
      },
      output: {
        const: null,
      },
      async run(value: unknown) {
        writeFileSync(resolve(temporary, `${value}-release`), "release");
        return null;
      },
    },
    "test.report": {
      input: {},
      output: {
        const: null,
      },
      async run(value: unknown) {
        await Bun.write(
          resolve(temporary, "report.json"),
          JSON.stringify(value),
        );
        return null;
      },
    },
  },
});
