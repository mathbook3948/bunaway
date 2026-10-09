import { storage } from "@bunaway/plugin-storage";

const memoPath = "notes/memo.txt";

/** Writes memo text to the appData file; permission and I/O failures reject. */
export async function saveMemo(text: string): Promise<void> {
  await storage.writeText({
    scope: "appData",
    path: memoPath,
    text,
  });
}

/** Reads persisted memo text; a missing file or denied read rejects. */
export function readMemo(): Promise<string> {
  return storage.readText({
    scope: "appData",
    path: memoPath,
  });
}
