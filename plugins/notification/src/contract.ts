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
export const statusSchema = z.discriminatedUnion("support", [
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

export type NotificationSetting = z.infer<typeof settingSchema>;
export type NotificationStatus = z.infer<typeof statusSchema>;

/** Reject alternate app IDs, arbitrary settings URIs and unregistered operations. */
export function validateNotificationInput(
  operation: string,
  input: JsonValue,
): void {
  if (operation === "notification.show" || operation === "notification.clear") {
    const schema =
      operation === "notification.show"
        ? notificationShowSchema
        : notificationIdentitySchema;
    if (!schema.safeParse(input).success) {
      throw new BunawayError({
        code: "INVALID_ARGUMENT",
        message: "Invalid notification input.",
      });
    }
    return;
  }
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

export const MAX_ACTIVE_TOASTS = 64;
const identifierSchema = z.string().regex(/^[A-Za-z0-9._-]{1,16}(?![\s\S])/);
const xmlText = (maximum: number) =>
  z
    .string()
    .max(maximum)
    .regex(
      /^[\t\n\r\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]*$/u,
      "Text must contain valid XML characters.",
    );
/** Stable tag/group in the host-selected app's namespace. Neither field selects another app. */
export const notificationIdentitySchema = z.strictObject({
  id: identifierSchema,
  group: identifierSchema.default("bunaway"),
});
export const notificationShowSchema = notificationIdentitySchema.extend({
  title: xmlText(256).min(1),
  body: xmlText(2048).default(""),
  data: z.string().max(2048).nullable().default(null),
  silent: z.boolean().default(false),
  suppressPopup: z.boolean().default(false),
});
export const notificationResultSchema = z.strictObject({
  id: identifierSchema,
  group: identifierSchema,
});
export type NotificationIdentity = z.input<typeof notificationIdentitySchema>;
export type NotificationOptions = z.input<typeof notificationShowSchema>;
export type ResolvedNotification = z.output<typeof notificationShowSchema>;
export type NotificationResult = z.output<typeof notificationResultSchema>;
export type ToastEvent =
  | {
      kind: "clicked";
    }
  | {
      kind: "dismissed";
      reason: "userCanceled" | "applicationHidden" | "timedOut" | "unknown";
    }
  | {
      kind: "failed";
      hresult: number;
    };
const identityProperties = {
  id: {
    type: "string",
    pattern: "^[A-Za-z0-9._-]{1,16}(?![\\s\\S])",
  },
  group: {
    type: "string",
    pattern: "^[A-Za-z0-9._-]{1,16}(?![\\s\\S])",
  },
} as const;
/** Events describe native callbacks, never inferred display success or cold-start activation. */
export const notificationEvents = {
  "notification.clicked": {
    type: "object",
    properties: {
      ...identityProperties,
      data: {
        anyOf: [
          {
            type: "string",
            maxLength: 2048,
          },
          {
            const: null,
          },
        ],
      },
    },
    required: [
      "id",
      "group",
      "data",
    ],
    additionalProperties: false,
  },
  "notification.dismissed": {
    type: "object",
    properties: {
      ...identityProperties,
      reason: {
        type: "string",
        enum: [
          "userCanceled",
          "applicationHidden",
          "timedOut",
          "unknown",
        ],
      },
    },
    required: [
      "id",
      "group",
      "reason",
    ],
    additionalProperties: false,
  },
  "notification.failed": {
    type: "object",
    properties: {
      ...identityProperties,
      hresult: {
        type: "integer",
        minimum: 0,
        maximum: 4294967295,
      },
    },
    required: [
      "id",
      "group",
      "hresult",
    ],
    additionalProperties: false,
  },
} as const;
