import { createClient } from "@bunaway/client";
import windows from "@bunaway/plugin-windows";

const client = createClient();
await client.ready;
const denied = location.pathname !== "/index.html";
if (denied) {
  if (location.pathname === "/no-event.html") {
    try {
      await client.listen("windows.monitorsChanged", () => {}, {
        onError: console.error,
      });
      throw new Error("Missing event grant accepted");
    } catch (error) {
      if (error.code !== "PERMISSION_DENIED") {
        throw error;
      }
    }
    await windows.getMonitorSnapshot();
  } else {
    let delivered = false;
    await client.listen(
      "windows.monitorsChanged",
      () => {
        delivered = true;
      },
      {
        onError: console.error,
      },
    );
    try {
      await windows.getMonitorSnapshot();
      throw new Error("Missing snapshot grant accepted");
    } catch (error) {
      if (error.code !== "PERMISSION_DENIED") {
        throw error;
      }
    }
    // Keep this listener alive through every synthetic transition in the allowed document.
    while (!(await client.invoke("test.waitDenied", null))) {
      await new Promise((done) => setTimeout(done, 100));
    }
    if (delivered) {
      throw new Error("Monitor event leaked without snapshot permission");
    }
  }
  await client.invoke("test.denied", location.pathname);
} else {
  let recording = Promise.resolve();
  const release = await client.listen(
    "windows.monitorsChanged",
    (event) => {
      if (event.source !== "native" || event.target !== "main") {
        throw new Error("Wrong monitor event route");
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
  const initial = await windows.getMonitorSnapshot();
  const phase = await client.invoke("test.exercise", null);
  const recovered = await windows.getMonitorSnapshot();
  if (
    initial.sourceId !== recovered.sourceId ||
    recovered.revision <= initial.revision ||
    recovered.error !== null
  ) {
    throw new Error("Snapshot recovery lost source or revision");
  }
  await release();
  await recording;
  await client.invoke("test.unsubscribed", null);
  if (phase === 1) {
    location.replace("/index.html?next=1");
  } else if (phase === 2) {
    await client.invoke("test.recreate", null).catch(() => {});
  } else {
    await client.invoke("test.finish", null).catch(() => {});
  }
}
