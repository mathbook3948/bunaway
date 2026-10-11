import { type Infer, s } from "@bunaway/plugin";
import { BunawayError, type JsonValue, validateValue } from "@bunaway/protocol";

const nullableString = {
  anyOf: [
    s.string(),
    s.null(),
  ],
} as const;
const statusSchema = s.object({
  registrationName: s.string(),
  registered: s.boolean(),
  commandLine: nullableString,
  executablePath: nullableString,
  args: {
    anyOf: [
      s.array(s.string()),
      s.null(),
    ],
  },
  startupState: s.enum([
    "enabled",
    "disabled",
    "unknown",
  ]),
  matchesCurrentLaunch: s.boolean(),
});

/** App launch registration inputs and observed Windows startup status. */
export const autostartOperations = {
  enable: {
    input: s.object({
      args: s.array(
        s.string({
          maxLength: 260,
        }),
        {
          maxItems: 64,
        },
      ),
    }),
    output: statusSchema,
  },
  disable: {
    input: s.null(),
    output: s.null(),
  },
  getStatus: {
    input: s.null(),
    output: statusSchema,
  },
} as const;

/** Stored launch data and the independently observed Windows startup approval state. */
export type AutostartStatus = Infer<typeof statusSchema>;

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
