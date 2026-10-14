import { defineNativeOperation } from "@bunaway/plugin";
import { z } from "zod";
import { type Capabilities, capabilitiesSchema } from "./contract.ts";

const operation = defineNativeOperation<Capabilities>();
/** Share the complete operation over the host-selected support snapshot on both platforms. */
export const capabilitiesOperations = {
  get: operation({
    input: z.null(),
    output: capabilitiesSchema,
    handler: (_input, { instance }) => instance,
  }),
};
