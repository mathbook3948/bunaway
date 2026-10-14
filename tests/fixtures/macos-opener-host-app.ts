import { resolve } from "node:path";
import { defineApp } from "@bunaway/backend";
import type { CommandContext } from "@bunaway/core";
import opener from "@bunaway/plugin-opener";
import windows from "@bunaway/plugin-windows";

let deniedReady = false;

export default defineApp({
  modules: [],
  plugins: [
    opener,
    windows,
  ],
  events: {},
  commands: {
    "test.denied": {
      input: {
        const: null,
      },
      output: {
        const: null,
      },
      async run() {
        deniedReady = true;
        return null;
      },
    },
    "test.wait": {
      input: {
        const: null,
      },
      output: {
        const: null,
      },
      async run(_value: unknown, context: CommandContext) {
        while (!deniedReady) {
          if (context.signal.aborted) {
            throw new Error("Fixture wait cancelled.");
          }
          await Bun.sleep(5);
        }
        return null;
      },
    },
    "test.report": {
      input: {},
      output: {
        const: null,
      },
      async run(value: unknown) {
        const directory = process.env.TMPDIR;
        if (!directory) {
          throw new Error("Missing fixture temp directory.");
        }
        await Bun.write(
          resolve(directory, "report.json"),
          JSON.stringify(value),
        );
        return null;
      },
    },
  },
});
