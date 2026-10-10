import { listenForAppReload } from "#native/windows/bun/app-reload";
import { DevelopmentApp } from "#native/windows/bun/development-app";
import type { AppDefinition } from "@bunaway/core";

const assets = process.argv[2];
if (!assets || !process.send) {
  throw new Error("Expected assets and private IPC");
}
const app: AppDefinition = {
  commands: {
    read: {
      input: {
        const: null,
      },
      output: {},
      async run() {
        return 0;
      },
    },
  },
  events: {},
};
// Keep the private IPC listener alive until the driver disconnects, then release its resources.
const close = listenForAppReload(new DevelopmentApp(app), assets);
process.on("disconnect", () => {
  close();
  process.exit(0);
});
