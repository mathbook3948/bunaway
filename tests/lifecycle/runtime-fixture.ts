import { runBunApp } from "@bunaway/runtime-bun";
import { contracts, plugins } from "../fixtures/host-plugins.ts";

await runBunApp({
  plugins: [
    ...plugins,
    {
      name: "startup",
      version: "1",
      async setup(context) {
        // The parent tests use these setup and teardown markers to coordinate runtime shutdown.
        await context.host.call(contracts["log.write"], {
          level: "info",
          message: "startup",
          details: null,
        });
        return () => {
          console.error("plugin-stopped");
        };
      },
    },
  ],
  events: {},
  commands: {
    read: {
      input: {
        const: null,
      },
      output: {
        type: "string",
      },
      async run(_payload, context) {
        return context.host.call(contracts["storage.readText"], {
          scope: "appData",
          path: "notes/a.txt",
        });
      },
    },
  },
});
