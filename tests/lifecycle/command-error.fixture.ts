import { runBunApp } from "@bunaway/runtime-bun";
import { testAppMetadata } from "../fixtures/app-info.ts";

// The parent test checks this sentinel in the command failure diagnostics.
await runBunApp(
  {
    events: {},
    commands: {
      fail: {
        input: {
          const: null,
        },
        output: {
          const: null,
        },
        async run() {
          throw new TypeError("runtime diagnostic sentinel");
        },
      },
    },
  },
  {
    app: testAppMetadata,
  },
);
