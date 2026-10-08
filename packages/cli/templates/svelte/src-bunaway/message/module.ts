import { defineModule } from "@bunaway/backend";
import { storage } from "@bunaway/plugin-storage";

const messageSchema = {
  type: "string",
  maxLength: 10000,
} as const;
const messagePath = "messages/current.txt";

export const message = defineModule("message")
  .command(
    "save",
    {
      input: messageSchema,
      output: {
        const: null,
      },
    },
    async (text, context) => {
      await storage.writeText({
        scope: "appData",
        path: messagePath,
        text,
      });
      await context.events.emit("message.saved", text, {
        kind: "broadcast",
      });
      return null;
    },
  )
  .command(
    "read",
    {
      input: {
        const: null,
      },
      output: {
        type: "string",
      },
    },
    () =>
      storage.readText({
        scope: "appData",
        path: messagePath,
      }),
  )
  .event("saved", messageSchema);
