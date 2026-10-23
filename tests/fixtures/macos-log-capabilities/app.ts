import { mkdir, rename, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { defineApp } from "@bunaway/backend";
import capabilities from "@bunaway/plugin-capabilities";
import log from "@bunaway/plugin-log";
import windows from "@bunaway/plugin-windows";

const dataRoot = process.env.HOME;
const temporary = process.env.TMPDIR;
if (!dataRoot || !temporary) {
  throw new Error("Missing fixture host directories.");
}

export default defineApp({
  modules: [],
  plugins: [
    log,
    capabilities,
    windows,
    {
      name: "log-startup",
      version: "1",
      async setup() {
        await log.info("backend-ready");
        // Backend settings need the backend's own authority, so they run in setup rather than in
        // a command that a WebView invoked.
        await log.configure({
          minimumLevel: "warn",
        });
        await log.info("filtered-info");
        await log.warn("kept-warn");
        await log.flush();
        await log.configure({
          minimumLevel: "info",
        });
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
