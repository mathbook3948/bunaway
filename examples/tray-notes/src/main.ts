import type { CommandsOf, EventsOf } from "@bunaway/backend";
import { createClient } from "@bunaway/client";
import windows from "@bunaway/plugin-windows";
import type { notesApp } from "../src-bunaway/app.ts";

/** Idle time after the last keystroke before the draft is written. */
const AUTOSAVE_DELAY_MS = 800;
/** Policy view of the only window. */
const VIEW = "main";

const input = document.querySelector<HTMLTextAreaElement>("#note");
const statusEl = document.querySelector<HTMLElement>("#status");
if (!input || !statusEl) {
  throw new Error("Missing UI elements.");
}
const ui = {
  input,
  statusEl,
};
function setStatus(message: string, state = "") {
  ui.statusEl.textContent = message;
  ui.statusEl.dataset.state = state;
}

/** Connects the page, restores the note and window placement, and answers close requests. */
async function start() {
  const client = createClient<
    CommandsOf<typeof notesApp>,
    EventsOf<typeof notesApp>
  >();
  let saved = "";
  let loaded = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Saves the current text; a write that fails leaves the text marked unsaved.
  const save = async () => {
    clearTimeout(timer);
    const value = ui.input.value;
    await client.invoke("notes.save", value);
    saved = value;
    setStatus(ui.input.value === saved ? "Saved." : "Editing...");
  };
  // Stores the note and window placement, then lets the window close; a failed save keeps it open.
  const answerClose = async (request: {
    windowId: string;
    requestId: number;
  }) => {
    let allow = false;
    try {
      // Before the saved note is loaded the input is empty, and writing it would erase the note.
      // A pending autosave stays scheduled so a refused close does not lose it.
      if (loaded) {
        await client.invoke("notes.closing", ui.input.value);
      }
      allow = true;
    } catch {
      setStatus("Could not save. The window stays open.", "error");
    } finally {
      // An unanswered request leaves the window waiting with no deadline.
      await windows.respondClose({
        view: VIEW,
        windowId: request.windowId,
        requestId: request.requestId,
        allow,
      });
    }
  };
  // Subscribe before reading so a close request during loading is not missed.
  await client.listen(
    "windows.closeRequested",
    ({ payload }) => {
      void answerClose(payload).catch(() => {
        // The request is gone with its window or document; the next close asks again.
        setStatus("Could not answer the close request.", "error");
      });
    },
    {
      onError: () => {
        setStatus("Connection lost. Open the app again.", "error");
      },
    },
  );
  try {
    saved = await client.invoke("notes.read", null);
    ui.input.value = saved;
    loaded = true;
    setStatus("Loaded.");
  } catch {
    // The input stays disabled: typing over a note that could not be read would replace it.
    setStatus(
      "Could not load the note. Close and open the app again.",
      "error",
    );
    return;
  }
  ui.input.disabled = false;
  ui.input.focus();
  // A missing saved placement or a failed restore keeps the declared size.
  await client.invoke("notes.restoreWindow", null).catch(() => false);
  ui.input.addEventListener("input", () => {
    setStatus("Editing...");
    clearTimeout(timer);
    timer = setTimeout(() => {
      void save().catch(() => {
        setStatus("Could not save. Keep this window open.", "error");
      });
    }, AUTOSAVE_DELAY_MS);
  });
}

void start().catch(() => {
  setStatus("Could not connect. Open the app again.", "error");
});
