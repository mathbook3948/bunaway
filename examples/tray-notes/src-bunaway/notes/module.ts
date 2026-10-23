import { defineModule } from "@bunaway/backend";
import { readContract, restoreContract, textContract } from "./contracts.ts";
import {
  readNote,
  restoreWindow,
  saveBeforeClose,
  saveNote,
} from "./service.ts";

/** Exposes validated note commands and the window placement hooks the page calls. */
export const notes = defineModule("notes")
  .command("save", textContract, async (text) => {
    await saveNote(text);
    return null;
  })
  .command("read", readContract, () => readNote())
  .command("restoreWindow", restoreContract, () => restoreWindow())
  .command("closing", textContract, async (text) => {
    await saveBeforeClose(text);
    return null;
  });
