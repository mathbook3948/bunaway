import { type AppDefinition, command } from "@bunaway/backend";

export const memoApp = {
  events: { "memo.saved": { type: "string", maxLength: 10000 } },
  commands: {
    "memo.save": command({
      input: { type: "string", maxLength: 10000 },
      output: { const: null },
      async handle(text, context) {
        await context.host.call("storage.writeText", {
          scope: "appData",
          path: "notes/memo.txt",
          text,
        });
        await context.events.emit("memo.saved", text, { kind: "broadcast" });
        return null;
      },
    }),
    "memo.read": command({
      input: { const: null },
      output: { type: "string" },
      async handle(_payload, context) {
        return context.host.call("storage.readText", { scope: "appData", path: "notes/memo.txt" });
      },
    }),
  },
} satisfies AppDefinition;

export default memoApp;
