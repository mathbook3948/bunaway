import { homedir } from "node:os";
import { join } from "node:path";
import storage from "@bunaway/plugin-storage";
import windowState from "@bunaway/plugin-window-state";
import settings from "../bunaway.json";

// The app chooses its storage directory and accepts only note text from the UI.
const notePath = join(
  process.env.LOCALAPPDATA ?? join(homedir(), ".local", "share"),
  "bunaway",
  settings.app.appId,
  "data",
  "note.txt",
);
const target = {
  view: settings.app.windows[0]?.view ?? "main",
};

/** Writes note text to the app-selected file; permission and I/O failures reject. */
export async function saveNote(text: string): Promise<void> {
  await storage.writeText({
    path: notePath,
    text,
  });
}

/** Reads persisted note text; the first run has no file and reads as empty, other failures reject. */
export async function readNote(): Promise<string> {
  const location = {
    path: notePath,
  };
  if (!(await storage.exists(location))) {
    return "";
  }
  return storage.readText(location);
}

/** Applies the saved position and size to the open window; its visibility is not touched. */
export async function restoreWindow(): Promise<boolean> {
  return (await windowState.restore(target)).restored;
}

/** Saves the note, then the window placement. Only the note write can reject. */
export async function saveBeforeClose(text: string): Promise<void> {
  await saveNote(text);
  try {
    await windowState.save(target);
  } catch {
    // A placement that cannot be stored must not keep the window from closing.
  }
}
