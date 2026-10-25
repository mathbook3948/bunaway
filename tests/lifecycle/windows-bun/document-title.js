import { createClient } from "@bunaway/client";

const LIMIT = 1024;
const client = createClient();
await client.ready;
const waiters = new Map();
let recording = Promise.resolve();
await client.listen(
  "windows.documentTitleChanged",
  (message) => {
    if (message.source !== "native" || message.target !== "main") {
      throw new Error("Wrong native source or destination");
    }
    recording = recording.then(() =>
      client.invoke("test.record", {
        payload: message.payload,
      }),
    );
    waiters.get(message.payload.title)?.();
  },
  {
    onError: (error) => {
      throw new Error(JSON.stringify(error));
    },
  },
);

/** Set the title and wait for the event that carries the (limited) value. */
async function setTitle(title, expected = title) {
  const arrived = new Promise((resolve) => waiters.set(expected, resolve));
  document.title = title;
  await arrived;
}

await setTitle("Second");
await setTitle("한글 제목 ✓");
// A title over the limit arrives cut to 1024 code units.
await setTitle("x".repeat(LIMIT + 500), "x".repeat(LIMIT));
// A surrogate pair across the limit is dropped whole.
await setTitle(`${"y".repeat(LIMIT - 1)}😀tail`, "y".repeat(LIMIT - 1));
await setTitle("Last");
await recording;
await client.invoke("test.finish", null).catch(() => {});
