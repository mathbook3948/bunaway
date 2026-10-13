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
      hidden: z.boolean().default(false),
      args: z
        .array(
          z
            .string()
            .refine(
              (value) => Array.from(value).length <= 260,
              "Text exceeds the Unicode character limit.",
            ),
        )
        .max(64),
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
/** App arguments and optional hidden startup. Hidden startup requires desktop.tray. */
export type AutostartOptions = {
  args?: string[];
  hidden?: boolean;
};
/** Validate a native call, rejecting operations outside this plugin with UNSUPPORTED. */
export function validateAutostartInput(operation: string, input: JsonValue) {
  try {
    switch (operation) {
      case "autostart.enable":
        return autostartOperations.enable.input.parse(validateValue({}, input));
      case "autostart.disable":
      case "autostart.getStatus":
        return autostartOperations.disable.input.parse(
          validateValue({}, input),
        );
      default:
        throw new BunawayError({
          code: "UNSUPPORTED",
          message: "Host operation is not registered.",
        });
    }
  } catch (error) {
    if (error instanceof BunawayError) {
      throw error;
    }
    throw new BunawayError({
      code: "INVALID_ARGUMENT",
      message: "Invalid plugin input.",
    });
  }
}
