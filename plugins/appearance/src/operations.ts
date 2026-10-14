import { defineNativeOperation } from "@bunaway/plugin";
import { z } from "zod";
import { type AppearancePreferences, preferencesSchema } from "./contract.ts";

/** Both platforms read the same preference snapshot without platform-specific handler decisions. */
export type AppearanceInstance = {
  read(): AppearancePreferences;
};
const operation = defineNativeOperation<AppearanceInstance>();
export const appearanceOperations = {
  getPreferences: operation({
    input: z.null(),
    output: preferencesSchema,
    handler: (_input, { instance }) => instance.read(),
  }),
};
