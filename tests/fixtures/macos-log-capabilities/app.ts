import { mkdir, rename, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { defineApp, type CommandContext } from "@bunaway/backend";
import { capabilities, capabilitiesPlugin } from "@bunaway/plugin-capabilities";
import { log, logPlugin } from "@bunaway/plugin-log";
import { windowsPlugin } from "@bunaway/plugin-windows";

const dataRoot = process.env.HOME;
const temporary = process.env.TMPDIR;
if (!dataRoot || !temporary) {
  throw new Error("Missing fixture host directories.");
}
let denied = false;

export default defineApp({
  modules: [],
  plugins: [
    logPlugin,
    capabilitiesPlugin,
    windowsPlugin,
    {
      name: "log-startup",
      version: "1",
      async setup() {
        await log.info("backend-ready");
        await Bun.write(
          resolve(temporary, "setup.json"),
          JSON.stringify(await capabilities()),
        );
        return async () => {
          await Bun.write(resolve(temporary, "stopped.json"), "true");
        };
      },
    },
  ],
  commands: {
    "test.denied": {
      input: {
        const: null,
      },
      output: {
        const: null,
      },
      async run() {
        denied = true;
        return null;
      },
    },
    "test.waitDenied": {
      input: {
        const: null,
      },
      output: {
        const: null,
      },
      async run(_value: unknown, context: CommandContext) {
        while (!denied) {
          if (context.signal.aborted) {
            throw new Error("Cancelled wait.");
          }
          await Bun.sleep(5);
        }
        return null;
      },
    },
    "test.writeFailure": {
      input: {
        const: null,
      },
      output: {
        const: true,
      },
      async run() {
        const path = resolve(dataRoot, "logs/app.log");
        const held = resolve(temporary, "held.log");
        await rename(path, held);
        try {
          await mkdir(path);
          try {
            await log.info("write-should-fail");
            throw new Error("Expected a write failure.");
          } catch (error) {
            if (
              !(
                error instanceof Error &&
                "code" in error &&
                error.code === "INTERNAL"
              )
            ) {
              throw error;
            }
          }
        } finally {
          await rm(path, {
            recursive: true,
            force: true,
          });
          await rename(held, path);
        }
        return true;
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
