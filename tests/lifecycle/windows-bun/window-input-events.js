import { createClient } from "@bunaway/client";

const client = createClient();
await client.ready;
let recording = Promise.resolve();
for (const event of [
  "windows.appCommand",
  "windows.systemContextMenu",
  "windows.thumbnailToolbarClicked",
]) {
  await client.listen(
    event,
    (message) => {
      if (message.source !== "native" || message.target !== "main") {
        throw new Error("Wrong native source or destination");
      }
      recording = recording.then(() =>
        client.invoke("test.record", {
          event,
          payload: message.payload,
        }),
      );
    },
    {
      onError: (error) => {
        throw new Error(JSON.stringify(error));
      },
    },
  );
}
await client.invoke("test.exercise", null);
await recording;
await client.invoke("test.finish", null).catch(() => {});
