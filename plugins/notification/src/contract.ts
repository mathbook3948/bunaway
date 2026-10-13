import { BunawayError, type JsonValue } from "@bunaway/protocol";
import { z } from "zod";

const settingSchema = z.enum([
  "enabled",
  "disabledForApplication",
  "disabledForUser",
  "disabledByGroupPolicy",
  "disabledByManifest",
  "unknown",
]);
const statusSchema = z.discriminatedUnion("support", [
  z.strictObject({
    support: z.literal("supported"),
    appUserModelId: z.string(),
    setting: settingSchema,
  }),
  z.strictObject({
    support: z.literal("unsupported"),
    appUserModelId: z.string(),
    setting: z.null(),
  }),
]);

/** Separate availability of the toast API from Windows' app, user and policy setting. */
export const notificationOperations = {
  getStatus: {
    input: z.null(),
    output: statusSchema,
  },
  openSettings: {
    input: z.null(),
    output: z.null(),
  },
} as const;

export type NotificationSetting = z.infer<typeof settingSchema>;
export type NotificationStatus = z.infer<typeof statusSchema>;

/** Reject alternate app IDs, arbitrary settings URIs and unregistered operations. */
export function validateNotificationInput(
  operation: string,
  input: JsonValue,
): void {
  if (
    operation !== "notification.getStatus" &&
    operation !== "notification.openSettings"
  ) {
    throw new BunawayError({
      code: "UNSUPPORTED",
      message: "Host operation is not registered.",
    });
  }
  if (input !== null) {
    throw new BunawayError({
      code: "INVALID_ARGUMENT",
      message: "Notification operations require null input.",
    });
  }
}
