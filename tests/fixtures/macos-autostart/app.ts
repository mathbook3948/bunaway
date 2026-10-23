import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineApp } from "@bunaway/backend";
import autostart from "@bunaway/plugin-autostart";
import windows from "@bunaway/plugin-windows";
import { REGISTERED_ARGS } from "./args.ts";

const temporary = process.env.TMPDIR;
if (!temporary) {
  throw new Error("Missing fixture host directories.");
}
const args = REGISTERED_ARGS;

async function errorCode(work: Promise<unknown>) {
  try {
    await work;
  } catch (error) {
    return Reflect.get(Object(error), "code");
  }
  return null;
}

export default defineApp({
  modules: [],
  plugins: [
    windows,
    autostart,
    {
      name: "autostart-test",
      version: "1",
      async setup() {
        // A restarted host sees the registration the previous run left behind.
        const before = await autostart.getAutostartStatus();
        const enabled = await autostart.enableAutostart(args);
        const repeated = await autostart.enableAutostart(args);
        // The macOS host does not offer hidden start yet, so the request is rejected.
        const hiddenCode = await errorCode(
          autostart.enableAutostart({
            args,
            hidden: true,
          }),
        );
        const afterHidden = await autostart.getAutostartStatus();
        const disabled = await autostart.disableAutostart();
        const removed = await autostart.getAutostartStatus();
        const disabledAgain = await autostart.disableAutostart();
        // The last registration stays for the driver to read from disk and for the next run.
        const final = await autostart.enableAutostart(args);
        writeFileSync(
          resolve(temporary, "backend-report.json"),
          JSON.stringify({
            before,
            enabled,
            repeated,
            hiddenCode,
            afterHidden,
            disabled,
            removed,
            disabledAgain,
            final,
          }),
        );
      },
    },
  ],
  commands: {},
});
