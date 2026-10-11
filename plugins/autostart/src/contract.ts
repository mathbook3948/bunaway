import { BunawayError, type JsonValue, validateValue } from "@bunaway/protocol";
import { z } from "zod";

const nullableString = z.union([
  z.string(),
  z.null(),
]);
const statusSchema = z.strictObject({
  registrationName: z.string(),
  registered: z.boolean(),
  commandLine: nullableString,
  executablePath: nullableString,
  args: z.union([
    z.array(z.string()),
    z.null(),
  ]),
  startupState: z.enum([
    "enabled",
    "disabled",
    "unknown",
  ]),
  matchesCurrentLaunch: z.boolean(),
});
/** App launch registration inputs and observed Windows startup status. */
export const autostartOperations = {
  enable: {
    input: z.strictObject({
      args: z.array(z.string().max(260)).max(64),
    }),
    output: statusSchema,
  },
  disable: {
    input: z.null(),
    output: z.null(),
  },
  getStatus: {
    input: z.null(),
    output: statusSchema,
  },
} as const;
/** Stored launch data and the independently observed Windows startup approval state. */
export type AutostartStatus = z.infer<typeof statusSchema>;
/** Validate a native call, rejecting operations outside this plugin with UNSUPPORTED. */
export function validateAutostartInput(operation: string, input: JsonValue) {
  switch (operation) {
    case "autostart.enable":
      return validateValue(autostartOperations.enable.input, input);
    case "autostart.disable":
    case "autostart.getStatus":
      return validateValue(autostartOperations.disable.input, input);
    default:
      throw new BunawayError({
        code: "UNSUPPORTED",
        message: "Host operation is not registered.",
      });
  }
}
