import { createClient } from "@bunaway/client";

const CLICK_ATTEMPTS = 5;
const EVENT_WAIT_MS = 4000;
const client = createClient();
await client.ready;

// A button over the whole viewport: a real click anywhere in the window is a user gesture on it.
const button = document.createElement("button");
button.textContent = "Fullscreen";
button.style.cssText =
  "position:fixed;inset:0;width:100vw;height:100vh;margin:0;border:0";
// What the page saw, so a failed run shows whether the click arrived and what the request returned.
const notes = [];
button.onclick = () => {
  notes.push(`click activation=${navigator.userActivation.isActive}`);
  document.documentElement.requestFullscreen().catch((error) => {
    notes.push(`requestFullscreen rejected: ${error}`);
  });
};
document.addEventListener("fullscreenchange", () =>
  notes.push(`fullscreenchange element=${!!document.fullscreenElement}`),
);
document.addEventListener("fullscreenerror", () =>
  notes.push("fullscreenerror"),
);
document.body.style.margin = "0";
document.body.append(button);

let current = false;
const events = [];
await client.listen(
  "windows.htmlFullscreenChanged",
  (message) => {
    if (message.source !== "native" || message.target !== "main") {
      throw new Error("Wrong native source or destination");
    }
    current = message.payload.fullscreen;
    events.push(message.payload.fullscreen);
  },
  {
    onError: (error) => {
      throw new Error(JSON.stringify(error));
    },
  },
);

/** Resolve true once the page-state event reports `value`, or false after the wait limit. */
async function reaches(value) {
  const limit = Date.now() + EVENT_WAIT_MS;
  while (current !== value && Date.now() < limit) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return current === value;
}

/** Click until the page enters HTML fullscreen; a click may only activate the window. */
async function enter() {
  for (let attempt = 0; attempt < CLICK_ATTEMPTS; attempt++) {
    await client.invoke("test.click", null);
    if (await reaches(true)) {
      return;
    }
  }
  throw new Error("The page never entered HTML fullscreen");
}

/** End the element and read the window state after the event that reports it. */
async function leave() {
  await document.exitFullscreen();
  if (!(await reaches(false))) {
    throw new Error("The page never reported leaving HTML fullscreen");
  }
}

const report = {};
try {
  await enter();
  report.windowDuringElement = await client.invoke("test.isFullscreen", null);
  await leave();
  report.windowAfterElement = await client.invoke("test.isFullscreen", null);

  await client.invoke("test.setFullscreen", true);
  await enter();
  report.windowDuringElementAlreadyFullscreen = await client.invoke(
    "test.isFullscreen",
    null,
  );
  await leave();
  report.windowAfterElementAlreadyFullscreen = await client.invoke(
    "test.isFullscreen",
    null,
  );
} catch (error) {
  // Report instead of throwing, so the driver fails with the page's notes rather than a timeout.
  report.error = String(error);
}
report.events = events;
report.notes = notes;
await client.invoke("test.finish", report).catch(() => {});
