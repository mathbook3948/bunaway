import { createClient } from "@bunaway/client";
import windows from "@bunaway/plugin-windows";

// Stands in for an editor that saves before it lets its window close.
const SAVE_DELAY_MS = 300;

const client = createClient();
await client.ready;
const role = location.pathname.slice(1, -".html".length);
let requests = 0;
await client.listen(
  "windows.closeRequested",
  (event) => {
    const { windowId, viewId, requestId } = event.payload;
    requests++;
    // `main` declines its first close and accepts the next; `observer` accepts every close.
    const allow = role !== "main" || requests > 1;
    void (async () => {
      await client.invoke("test.requested", event.payload);
      if (role === "main") {
        await new Promise((resolve) => setTimeout(resolve, SAVE_DELAY_MS));
      }
      // Report before answering: an accepted close revokes this document.
      await client.invoke("test.answering", {
        view: viewId,
        requestId,
        allow,
      });
      try {
        await windows.respondClose({
          view: viewId,
          windowId,
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
if (role === "observer") {
  // Serialized so that the backend sees the phases in the order they were delivered.
  let recording = Promise.resolve();
  await client.listen(
    "windows.lifecycle",
    (event) => {
      recording = recording.then(() =>
        client.invoke("test.lifecycle", event.payload),
      );
    },
    {
      onError: console.error,
    },
  );
}
await client.invoke("test.ready", role);
