import { createClient } from "@bunaway/client";
import windows from "@bunaway/plugin-windows";

// Stands in for an editor that saves before it lets its window close.
const SAVE_DELAY_MS = 300;

const client = createClient();
await client.ready;
let requests = 0;
await client.listen(
  "windows.closeRequested",
  (event) => {
    const { viewId, requestId } = event.payload;
    requests++;
    // The window declines its first close and accepts the next.
    const allow = requests > 1;
    void (async () => {
      await client.invoke("test.requested", event.payload);
      await new Promise((resolve) => setTimeout(resolve, SAVE_DELAY_MS));
      // Report before answering: an accepted close revokes this document.
      await client.invoke("test.answering", {
        view: viewId,
        requestId,
        allow,
      });
      try {
        await windows.respondClose({
          requestId,
          allow,
        });
      } catch (error) {
        // An accepted close can end this document before the reply arrives.
        if (!allow) {
          throw error;
        }
        return;
      }
      if (!allow) {
        await client.invoke("test.answered", {
          view: viewId,
          requestId,
        });
      }
    })().catch((error) => {
      void client.invoke("test.failed", String(error));
    });
  },
  {
    onError: console.error,
  },
);
await client.invoke("test.ready", "main");
