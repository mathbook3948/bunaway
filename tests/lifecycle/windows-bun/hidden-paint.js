import { createClient } from "@bunaway/client";

const SAMPLE_WAIT_MS = 1000;
const VISIBLE_WAIT_MS = 3000;
const client = createClient();
await client.ready;

/** Whether an animation frame was delivered within the wait. A frame needs a page the browser paints. */
function frameWithin(waitMs) {
  return Promise.race([
    new Promise((resolve) => requestAnimationFrame(() => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), waitMs)),
  ]);
}

/** What the page can tell about its own visibility and painting right now. */
async function sample() {
  return {
    visibilityState: document.visibilityState,
    hidden: document.hidden,
    frame: await frameWithin(SAMPLE_WAIT_MS),
    paintEntries: performance
      .getEntriesByType("paint")
      .map((entry) => entry.name),
  };
}

// Timers run while the window is hidden, so the document's scripts are not suspended.
const timerRan = await new Promise((resolve) =>
  setTimeout(() => resolve(true), 50),
);
await client.invoke("test.hidden", {
  payload: {
    timerRan,
    ...(await sample()),
  },
});
// The backend shows the window before this command returns.
await client.invoke("test.awaitShown", null);
// The browser learns about the new visibility asynchronously; wait for it instead of sampling at once.
if (document.visibilityState !== "visible") {
  // A window the browser keeps hidden must still report what the page saw, so the wait is bounded.
  await new Promise((resolve) => {
    setTimeout(resolve, VISIBLE_WAIT_MS);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        resolve();
      }
    });
  });
}
await client.invoke("test.shown", {
  payload: await sample(),
});
