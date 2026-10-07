import { runBunApp } from "../../packages/runtime-bun/src/index.ts";

await runBunApp({
  events: {},
  commands: {
    fail: {
      input: { const: null },
      output: { const: null },
      async run() {
        throw new TypeError("runtime diagnostic sentinel");
      },
    },
  },
});
