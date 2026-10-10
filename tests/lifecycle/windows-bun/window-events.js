import { createClient } from "@bunaway/client";
import { windows } from "@bunaway/plugin-windows";

const client = createClient();
await client.ready;
if (location.pathname === "/denied.html") {
  try {
    await client.listen("windows.changed", () => {}, {
      onError: console.error,
    });
    throw new Error("Denied view subscribed to native events");
  } catch (error) {
    if (error.code !== "PERMISSION_DENIED") {
      throw error;
    }
    await client.invoke("test.denied", null);
  }
} else {
  let recording = Promise.resolve();
  const release = await client.listen(
    "windows.changed",
    (event) => {
      if (event.source !== "native" || event.target !== "main") {
        throw new Error("Wrong native source or destination");
      }
      recording = recording.then(() =>
        client.invoke("test.record", event.payload),
      );
    },
    {
      onError: (error) => {
        throw new Error(JSON.stringify(error));
      },
    },
  );
  const initial = await windows.getSnapshot({
    view: "main",
  });
  const { phase, snapshot } = await client.invoke("test.exercise", null);
  const recovered = await windows.getSnapshot({
    view: "main",
  });
  if (
    initial.windowId !== snapshot.windowId ||
    recovered.windowId !== snapshot.windowId ||
    recovered.revision < snapshot.revision
  ) {
    throw new Error(
      "Snapshot recovery did not retain the current window revision",
    );
  }
  await release();
  await recording;
  await client.invoke("test.unsubscribed", null);
  // Recreation and final close revoke this document's pending request context.
  if (phase === 1) {
    location.replace("/index.html?next=1");
  } else if (phase === 2) {
    await client.invoke("test.recreate", null).catch(() => {});
  } else {
    await client.invoke("test.finish", null).catch(() => {});
  }
}
