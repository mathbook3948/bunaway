import { storage } from "@bunaway/plugin-storage";

const memoPath = "notes/memo.txt";

export async function saveMemo(text: string): Promise<void> {
  await storage.writeText({
    scope: "appData",
    path: memoPath,
    text,
  });
}

export function readMemo(): Promise<string> {
  return storage.readText({
    scope: "appData",
    path: memoPath,
  });
}
