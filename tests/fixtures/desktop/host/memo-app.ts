import type { AppDefinition } from "../../../../packages/core/src/index.ts";

export const memoApp = {
  events: { "memo.saved": { type: "string", maxLength: 10000 } },
  commands: {
    "memo.save": {
      input: { type: "string", maxLength: 10000 },
      output: { const: null },
      async run(text, context) {
        await context.host.call("storage.writeText", {
          scope: "appData",
          path: "notes/memo.txt",
          text: text as string,
        });
        await context.events.emit("memo.saved", text as string, { kind: "broadcast" });
        return null;
      },
    },
    "memo.read": {
      input: { const: null },
      output: { type: "string" },
      async run(_payload, context) {
        return context.host.call("storage.readText", { scope: "appData", path: "notes/memo.txt" });
      },
    },
  },
} satisfies AppDefinition;
