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
/** Image formats the Windows toast renderer accepts for local files. */
export const TOAST_IMAGE_EXTENSIONS = [
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".bmp",
] as const;
/**
 * Microsoft documents a 3 MB limit for toast images on a normal connection (3 MB, not 3 MiB), so reject larger
 * files before the picture silently disappears.
 */
export const MAX_TOAST_IMAGE_BYTES = 3_000_000;
const MAX_TOAST_IMAGE_PATH_LENGTH = 260;
/**
 * Windows system sounds addressable as `ms-winsoundevent:Notification.<name>`. Unpackaged apps cannot play
 * arbitrary files. Only the `Looping.*` names honor `soundLoop`.
 */
export const TOAST_SOUNDS = [
  "Default",
  "IM",
  "Mail",
  "Reminder",
  "SMS",
  "Looping.Alarm",
  "Looping.Alarm2",
  "Looping.Alarm3",
  "Looping.Alarm4",
  "Looping.Alarm5",
  "Looping.Alarm6",
  "Looping.Alarm7",
  "Looping.Alarm8",
  "Looping.Alarm9",
  "Looping.Alarm10",
  "Looping.Call",
  "Looping.Call2",
  "Looping.Call3",
  "Looping.Call4",
  "Looping.Call5",
  "Looping.Call6",
  "Looping.Call7",
  "Looping.Call8",
  "Looping.Call9",
  "Looping.Call10",
] as const;
const imagePathSchema = z
  .string()
  .max(MAX_TOAST_IMAGE_PATH_LENGTH)
  // Drive-absolute only: relative paths depend on the host cwd and UNC paths would reach network shares.
  .regex(/^[A-Za-z]:[\\/]/, "Path must be an absolute local drive path.")
  // Lone surrogates (\p{Cs}) would make encodeURIComponent throw outside the error contract.
  .regex(/^[^"<>|*?\p{Cc}\p{Cs}]*$/u, "Path contains invalid characters.")
  // A colon after the drive designator would select an NTFS alternate data stream.
  .refine((path) => !path.slice(2).includes(":"), "Path must not contain ':'.")
  .refine(
    (path) => !path.split(/[\\/]/).includes(".."),
    "Path must not contain '..'.",
  )
  .refine(
    (path) =>
      TOAST_IMAGE_EXTENSIONS.some((extension) =>
        path.toLowerCase().endsWith(extension),
      ),
    `Image must be one of ${TOAST_IMAGE_EXTENSIONS.join(", ")}.`,
  );
/** Stable tag/group in the host-selected app's namespace. Neither field selects another app. */
export const notificationIdentitySchema = z.strictObject({
  id: identifierSchema,
  group: identifierSchema.default("bunaway"),
});
export const notificationShowSchema = notificationIdentitySchema
  .extend({
    title: xmlText(256).min(1),
    body: xmlText(2048).default(""),
    data: z.string().max(2048).nullable().default(null),
    silent: z.boolean().default(false),
    suppressPopup: z.boolean().default(false),
    icon: imagePathSchema.nullable().default(null),
    image: imagePathSchema.nullable().default(null),
    imagePlacement: z
      .enum([
        "inline",
        "hero",
      ])
      .default("inline"),
    sound: z.enum(TOAST_SOUNDS).nullable().default(null),
    soundLoop: z.boolean().default(false),
  })
  .refine((input) => !(input.silent && input.sound !== null), {
    message: "silent and sound are mutually exclusive.",
    path: [
      "sound",
    ],
  })
  .refine((input) => !input.soundLoop || input.sound?.startsWith("Looping."), {
    message: "soundLoop requires a Looping.* sound.",
    path: [
      "soundLoop",
    ],
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
