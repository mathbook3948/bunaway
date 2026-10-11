import { homedir } from "node:os";
import { join } from "node:path";
import { defineModule } from "@bunaway/backend";
import { storage } from "@bunaway/plugin-storage";
import settings from "../bunaway.json";

/** Validates message input and events against the 10,000-character limit. */
const messageSchema = {
  type: "string",
  maxLength: 10000,
} as const;
// This app chooses its data directory and keeps file paths out of UI input.
const messagePath = join(
  process.env.LOCALAPPDATA ?? join(homedir(), ".local", "share"),
  "bunaway",
  settings.app.appId,
  "data",
  "messages",
  "current.txt",
);

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
        path: messagePath,
      }),
  )
  .event("saved", messageSchema);
