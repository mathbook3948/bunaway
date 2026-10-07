import { defineModule, storage } from "@bunaway/backend";

export const message = defineModule("message")
  .command(
    "save",
    { input: { type: "string", maxLength: 10000 }, output: { const: null } },
    async (text, context) => {
      await storage.writeText({
        scope: "appData",
        path: "messages/current.txt",
        text,
      });
      await context.events.emit("message.saved", text, { kind: "broadcast" });
      return null;
    },
  )
  .command("read", { input: { const: null }, output: { type: "string" } }, () =>
    storage.readText({
      scope: "appData",
      path: "messages/current.txt",
    }),
  )
  .event("saved", { type: "string", maxLength: 10000 });
