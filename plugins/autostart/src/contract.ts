import type { NativeEnvironment } from "@bunaway/plugin";
import { BunawayError, type JsonValue, validateValue } from "@bunaway/protocol";
import { z } from "zod";

const nullableString = z.union([
  z.string(),
  z.null(),
]);
export const statusSchema = z.strictObject({
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
/** App launch registration inputs; the stored result is described by `statusSchema`. */
export const enableSchema = z.strictObject({
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
});
/**
 * Stored launch data and the independently observed startup approval state. Windows reports the
 * user's Startup Apps choice; macOS has no public API for it, so `startupState` is `unknown`.
 */
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
        return enableSchema.parse(validateValue({}, input));
      case "autostart.disable":
      case "autostart.getStatus":
        return z.null().parse(validateValue({}, input));
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

export type AppLaunch = NonNullable<NativeEnvironment["app"]>;
