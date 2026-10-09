import { defineModule } from "@bunaway/backend";
import { readContract, saveContract, savedSchema } from "./contracts.ts";
import { readMemo, saveMemo } from "./service.ts";

/** Exposes validated memo commands and broadcasts completed writes. */
export const memo = defineModule("memo")
  .command("save", saveContract, async (text, context) => {
    await saveMemo(text);
    // A failed storage write must not be announced as a saved memo.
    await context.events.emit("memo.saved", text, {
      kind: "broadcast",
    });
    return null;
  })
  .command("read", readContract, () => readMemo())
  .event("saved", savedSchema);
