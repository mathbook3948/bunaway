import { defineNativeOperation } from "@bunaway/plugin";
import { z } from "zod";
import {
  type AppearanceInstance,
  preferencesSchema,
} from "#appearance/contract";

const operation = defineNativeOperation<AppearanceInstance>();
export const appearanceOperations = {
  getPreferences: operation({
    input: z.null(),
    output: preferencesSchema,
    handler: (_input, { instance }) => instance.read(),
  }),
};
