import { createClient } from "@bunaway/client";

const ICON_A =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E";
const ICON_B =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='2'/%3E";
// Longer than the 2048 code unit limit, so the event carries an empty address.
const ICON_LONG = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'%3E%3C!--${"x".repeat(3000)}--%3E%3C/svg%3E`;
const client = createClient();
await client.ready;
const waiters = new Map();
let recording = Promise.resolve();
await client.listen(
  "windows.documentFaviconChanged",
  (message) => {
    if (message.source !== "native" || message.target !== "main") {
      throw new Error("Wrong native source or destination");
    }
    recording = recording.then(() =>
      client.invoke("test.record", {
        payload: message.payload,
      }),
    );
    waiters.get(message.payload.url)?.();
  },
  {
    onError: (error) => {
      throw new Error(JSON.stringify(error));
    },
  },
);

const link = document.createElement("link");
link.rel = "icon";

/** Point the page icon at an address and wait for the event that carries the (limited) value. */
async function setIcon(href, expected = href) {
  const arrived = new Promise((resolve) => waiters.set(expected, resolve));
  link.href = href;
  if (!link.isConnected) {
    document.head.append(link);
  }
  // The host's native fixture deadline ends a run that never receives the event.
  await arrived;
}

await setIcon(ICON_A);
await setIcon(ICON_B);
await setIcon(ICON_LONG, "");
await recording;
await client.invoke("test.finish", null).catch(() => {});
