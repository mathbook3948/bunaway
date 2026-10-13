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
        return () => writeFileSync(resolve(temporary, "core-cleaned"), "done");
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
