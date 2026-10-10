import { createClient, createWebViewTransport } from "@bunaway/client";

const client = createClient({
  transport: createWebViewTransport(window.chrome.webview),
  hello: {
    kind: "hello",
    protocol: {
      major: 1,
      minor: 0,
    },
    features: [],
    buildId: "windows-bun-core",
  },
});
const assert = (value) => {
  if (!value) {
    throw new Error("SDK/core gate failed");
  }
};
await client.ready;
// Oversized and disallowed messages must not break the negotiated session or its UI Worker.
window.chrome.webview.postMessage({
  kind: "invoke",
  protocol: {
    major: 1,
    minor: 0,
  },
  id: "oversized-native",
  command: "test.echo",
  payload: "x".repeat(1024 * 1024 + 1),
});
for (let index = 0; index < 256; index++) {
  window.chrome.webview.postMessage({
    kind: "invoke",
    protocol: {
      major: 1,
      minor: 0,
    },
    id: `rejected-${index}`,
    command: "not.allowed",
    payload: null,
  });
}
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
const pending = client.invoke("test.hold", null, {
  signal: abort.signal,
});
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
