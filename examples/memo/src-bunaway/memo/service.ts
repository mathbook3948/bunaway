import { homedir } from "node:os";
import { join } from "node:path";
import { storage } from "@bunaway/plugin-storage";
import settings from "../bunaway.json";

// The memo app chooses its storage directory and accepts only memo content from UI.
const memoPath = join(
  process.env.LOCALAPPDATA ?? join(homedir(), ".local", "share"),
  "bunaway",
  settings.app.appId,
  "data",
  "notes",
  "memo.txt",
);

/** Writes memo text to the app-selected file; permission and I/O failures reject. */
export async function saveMemo(text: string): Promise<void> {
  await storage.writeText({
    path: memoPath,
    text,
  });
}

/** Reads persisted memo text; a missing file or denied read rejects. */
export function readMemo(): Promise<string> {
  return storage.readText({
    path: memoPath,
  });
}
