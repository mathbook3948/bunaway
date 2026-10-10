// A same-origin subframe may see Android's native object, but must never control the main session.
const native: unknown = Reflect.get(globalThis, "bunawayNative");
if (
  typeof native === "object" &&
  native !== null &&
  "postMessage" in native &&
  typeof native.postMessage === "function"
) {
  native.postMessage(
    JSON.stringify({
      kind: "shutdown",
    }),
  );
  document.body.dataset.attempted = "yes";
}
