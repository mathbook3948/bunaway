import { createClient, createWebViewTransport } from "../../../packages/client-sdk/src/index.ts";

const client = createClient({
  transport: createWebViewTransport(window.chrome.webview),
  hello: {
    kind: "hello",
    protocol: { major: 1, minor: 0 },
    features: [],
    buildId: "windows-bun-core",
  },
});
const assert = (value) => {
  if (!value) throw new Error("SDK/core gate failed");
};
await client.ready;
let event;
const off = await client.listen(
  "test.changed",
  (message) => {
    event = message.payload;
  },
  {
    onError: (error) => {
      throw error;
    },
  },
);
assert((await client.invoke("test.echo", 21)) === 42);
document.querySelector("output").textContent = "42";
await new Promise(requestAnimationFrame);
assert(document.querySelector("output").textContent === "42");
await client.invoke("test.emit", 42);
assert(event === 42);
await off();
const abort = new AbortController();
const pending = client.invoke("test.hold", null, { signal: abort.signal });
await new Promise((resolve) => setTimeout(resolve, 100));
abort.abort();
try {
  await pending;
  throw new Error("Expected cancellation");
} catch (error) {
  assert(error.code === "CANCELLED");
}
await client.invoke("test.report", true);
await client.close();
window.close();
