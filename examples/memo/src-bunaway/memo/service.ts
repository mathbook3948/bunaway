import type { HostAPI } from "@bunaway/backend";

export class MemoService {
  async save(text: string, host: HostAPI): Promise<null> {
    await host.call("storage.writeText", {
      scope: "appData",
      path: "notes/memo.txt",
      text,
    });
    return null;
  }

  read(host: HostAPI): Promise<string> {
    return host.call("storage.readText", { scope: "appData", path: "notes/memo.txt" });
  }
}
