import { type AppDefinition, command } from "@bunaway/backend";

export const app = {
  events: { "message.saved": { type: "string", maxLength: 10000 } },
  commands: {
    "message.save": command({
      input: { type: "string", maxLength: 10000 },
      output: { const: null },
      async handle(text, context) {
        await context.host.call("storage.writeText", {
          scope: "appData",
          path: "messages/current.txt",
          text,
        });
        await context.events.emit("message.saved", text, { kind: "broadcast" });
        return null;
      },
    }),
    "message.read": command({
      input: { const: null },
      output: { type: "string" },
      async handle(_input, context) {
        return context.host.call("storage.readText", {
          scope: "appData",
          path: "messages/current.txt",
        });
      },
    }),
  },
} satisfies AppDefinition;
