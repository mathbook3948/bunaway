import { storagePlugin } from "@bunaway/plugin-storage";
import type { AppDefinition } from "../../../../packages/core/src/index.ts";
import { contracts } from "../../host-plugins.ts";

/** Storage-backed memo commands for the Windows host fixture. */
export const memoApp = {
  events: {
    "memo.saved": {
      type: "string",
      maxLength: 10000,
    },
  },
  plugins: [
    storagePlugin,
  ],
  commands: {
    "memo.save": {
      input: {
        type: "string",
        maxLength: 10000,
      },
      output: {
        const: null,
      },
      async run(text, context) {
        // Persist before broadcasting so listeners can immediately read the
        // stored memo.
        await context.host.call(contracts["storage.writeText"], {
          scope: "appData",
          path: "notes/memo.txt",
          text: text as string,
        });
        await context.events.emit("memo.saved", text as string, {
          kind: "broadcast",
        });
        return null;
      },
    },
    "memo.read": {
      input: {
        const: null,
      },
      output: {
        type: "string",
      },
      async run(_payload, context) {
        return context.host.call(contracts["storage.readText"], {
          scope: "appData",
          path: "notes/memo.txt",
        });
      },
    },
  },
} satisfies AppDefinition;
