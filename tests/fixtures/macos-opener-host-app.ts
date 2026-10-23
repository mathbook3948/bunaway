import { resolve } from "node:path";
import { defineApp } from "@bunaway/backend";
import opener from "@bunaway/plugin-opener";
import windows from "@bunaway/plugin-windows";

export default defineApp({
  modules: [],
  plugins: [
    opener,
    windows,
  ],
  events: {},
  commands: {
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
