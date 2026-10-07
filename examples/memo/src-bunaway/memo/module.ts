import { defineModule } from "@bunaway/backend";
import { readContract, saveContract, savedSchema } from "./contracts.ts";
import { MemoService } from "./service.ts";

const service = new MemoService();

export const memo = defineModule("memo")
  .command("save", saveContract, async (text, context) => {
    await service.save(text);
    await context.events.emit("memo.saved", text, { kind: "broadcast" });
    return null;
  })
  .command("read", readContract, () => service.read())
  .event("saved", savedSchema);
