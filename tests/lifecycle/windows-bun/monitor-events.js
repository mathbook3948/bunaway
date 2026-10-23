import { createClient } from "@bunaway/client";
import windows from "@bunaway/plugin-windows";

const client = createClient();
await client.ready;
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
