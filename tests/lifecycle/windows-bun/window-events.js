import { createClient } from "@bunaway/client";
import { windows } from "@bunaway/plugin-windows";

const client = createClient();
await client.ready;
if (location.pathname === "/denied.html") {
  for (const method of [
    "listen",
    "once",
  ]) {
    try {
      await client[method]("windows.changed", () => {}, {
        onError: console.error,
      });
      throw new Error("Denied view subscribed to native events");
    } catch (error) {
      if (error.code !== "PERMISSION_DENIED") {
        throw error;
      }
    }
  }
  await client.invoke("test.denied", null);
} else {
  let recording = Promise.resolve();
  const onceEvents = [];
  const onceErrors = [];
  const releaseOnce = await client.once(
    "windows.changed",
    (event) => {
      onceEvents.push(event);
    },
    {
      onError: (error) => onceErrors.push(error),
    },
  );
  const cancelled = new AbortController();
  let cancelledDeliveries = 0;
  const releaseCancelled = await client.once(
    "windows.changed",
    () => {
      cancelledDeliveries++;
    },
    {
      signal: cancelled.signal,
      onError: (error) => onceErrors.push(error),
    },
  );
  cancelled.abort();
  await releaseCancelled();
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
  await releaseOnce();
  await recording;
  if (
    onceEvents.length !== 1 ||
    onceErrors.length !== 0 ||
    cancelledDeliveries !== 0
  ) {
    throw new Error(
      `Invalid once delivery: ${JSON.stringify({
        onceEvents,
        onceErrors,
        cancelledDeliveries,
      })}`,
    );
  }
  const first = onceEvents[0];
  if (first.source !== "native" || first.target !== "main") {
    throw new Error("Wrong once event source or destination");
  }
  await client.invoke("test.unsubscribed", {
    onceCount: onceEvents.length,
    onceSequence: first.sequence,
    onceWindowId: first.payload.windowId,
    cancelledDeliveries,
  });
  if (
    onceEvents.length !== 1 ||
    onceErrors.length !== 0 ||
    cancelledDeliveries !== 0
  ) {
    throw new Error("Released once subscription received another event");
  }
  // Recreation and final close revoke this document's pending request context.
  if (phase === 1) {
    location.replace("/index.html?next=1");
  } else if (phase === 2) {
    await client.invoke("test.recreate", null).catch(() => {});
  } else {
    await client.invoke("test.finish", null).catch(() => {});
  }
}
