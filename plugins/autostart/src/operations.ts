import { defineNativeOperation } from "@bunaway/plugin";
import { z } from "zod";
import { enableSchema, statusSchema } from "#autostart/contract";
import {
  disable as disableMacos,
  enable as enableMacos,
  getStatus as getStatusMacos,
  type initialize as initializeMacos,
} from "#autostart/platforms/macos";
import {
  disable,
  enable,
  getStatus,
  type initialize,
} from "#autostart/platforms/windows";

const operation = defineNativeOperation<ReturnType<typeof initialize>>();
const macosOperation =
  defineNativeOperation<ReturnType<typeof initializeMacos>>();
/** Complete Windows login registration operations. Imports never register the app. */
export const autostartOperations = {
  enable: operation({
    input: enableSchema,
    output: statusSchema,
    handler: (input, { instance, signal }) => enable(instance, input, signal),
  }),
  disable: operation({
    input: z.null(),
    output: z.null(),
    handler: (_input, { instance, signal }) => disable(instance, signal),
  }),
  getStatus: operation({
    input: z.null(),
    output: statusSchema,
    handler: (_input, { instance, signal }) => getStatus(instance, signal),
  }),
};
/** The same operations over the user's LaunchAgent on macOS. */
export const macosAutostartOperations = {
  enable: macosOperation({
    input: enableSchema,
    output: statusSchema,
    handler: (input, { instance }) => enableMacos(instance, input),
  }),
  disable: macosOperation({
    input: z.null(),
    output: z.null(),
    handler: (_input, { instance }) => disableMacos(instance),
  }),
  getStatus: macosOperation({
    input: z.null(),
    output: statusSchema,
    handler: (_input, { instance }) => getStatusMacos(instance),
  }),
};
