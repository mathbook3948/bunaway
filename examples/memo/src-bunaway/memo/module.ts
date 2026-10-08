import { defineModule } from "@bunaway/backend";
import { readContract, saveContract, savedSchema } from "./contracts.ts";
import { readMemo, saveMemo } from "./service.ts";

export const memo = defineModule("memo")
  .command("save", saveContract, async (text, context) => {
    await saveMemo(text);
    await context.events.emit("memo.saved", text, {
      kind: "broadcast",
    });
    return null;
  })
  .command("read", readContract, () => readMemo())
  .event("saved", savedSchema);
