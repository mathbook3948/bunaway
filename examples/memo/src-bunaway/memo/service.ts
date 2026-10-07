import { storage } from "@bunaway/plugin-storage";

export class MemoService {
  async save(text: string): Promise<null> {
    await storage.writeText({
      scope: "appData",
      path: "notes/memo.txt",
      text,
    });
    return null;
  }

  read(): Promise<string> {
    return storage.readText({ scope: "appData", path: "notes/memo.txt" });
  }
}
