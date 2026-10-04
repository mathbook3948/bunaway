import { runBunApp } from "../../packages/runtime-bun/src/index.ts";

await runBunApp({
  plugins: [
    {
      name: "startup",
      version: "1",
      async setup(context) {
        await context.host.call("log.write", { level: "info", message: "startup", details: null });
        return () => {
          console.error("plugin-stopped");
        };
      },
    },
  ],
  events: {},
  commands: {
    read: {
      input: { const: null },
      output: { type: "string" },
      async run(_payload, context) {
        return context.host.call("storage.readText", { scope: "appData", path: "notes/a.txt" });
      },
    },
  },
});
