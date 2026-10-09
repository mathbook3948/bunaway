import { defineModule } from "@bunaway/backend";
import { storage } from "@bunaway/plugin-storage";

/** Validates message input and events against the 10,000-character limit. */
const messageSchema = {
  type: "string",
  maxLength: 10000,
} as const;
/** Relative path resolved inside the host-managed appData scope. */
const messagePath = "messages/current.txt";

/** Saves messages before broadcasting them and exposes a read command. */
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
      // Publish only after storage confirms the write.
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
