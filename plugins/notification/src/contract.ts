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
  if (
    operation === "notification.show" ||
    operation === "notification.clear" ||
    operation === "notification.clearGroup"
  ) {
    const schema = {
      "notification.show": notificationShowSchema,
      "notification.clear": notificationIdentitySchema,
      "notification.clearGroup": notificationGroupSchema,
    }[operation];
    if (!schema.safeParse(input).success) {
      throw new BunawayError({
        code: "INVALID_ARGUMENT",
        message: "Invalid notification input.",
      });
    }
    return;
  }
  if (
    operation !== "notification.clearAll" &&
    operation !== "notification.list" &&
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
/** Windows shows at most five buttons on a toast, and the reply submit button counts as one. */
export const MAX_TOAST_ACTIONS = 5;
export const MAX_ACTION_LABEL_LENGTH = 64;
export const MAX_REPLY_PLACEHOLDER_LENGTH = 128;
/** Same bound as `data`, so a reply fits any payload an app already accepts from a toast. */
export const MAX_REPLY_LENGTH = 2048;
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
] as const;
/**
 * Microsoft documents a 3 MB limit for toast images on a normal connection (3 MB, not 3 MiB), so reject larger
 * files before the picture silently disappears.
 */
export const MAX_TOAST_IMAGE_BYTES = 3_000_000;
// MAX_PATH is 260 including the terminating NUL.
const MAX_TOAST_IMAGE_PATH_LENGTH = 259;
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
const toastActionSchema = z.strictObject({
  id: identifierSchema,
  label: xmlText(MAX_ACTION_LABEL_LENGTH).min(1),
});
const toastReplySchema = z.strictObject({
  placeholder: xmlText(MAX_REPLY_PLACEHOLDER_LENGTH).default(""),
  buttonLabel: xmlText(MAX_ACTION_LABEL_LENGTH).min(1),
});
/** Stable tag/group in the host-selected app's namespace. Neither field selects another app. */
export const notificationIdentitySchema = z.strictObject({
  id: identifierSchema,
  group: identifierSchema.default("bunaway"),
});
/** Group-wide removal. The group is required so an omitted field cannot select the default group. */
export const notificationGroupSchema = z.strictObject({
  group: identifierSchema,
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
    actions: z.array(toastActionSchema).default([]),
    reply: toastReplySchema.nullable().default(null),
  })
  .refine(
    (input) =>
      new Set(input.actions.map((action) => action.id)).size ===
      input.actions.length,
    {
      message: "actions must have unique ids.",
      path: [
        "actions",
      ],
    },
  )
  .refine(
    (input) =>
      input.actions.length + (input.reply ? 1 : 0) <= MAX_TOAST_ACTIONS,
    {
      message: `A toast shows at most ${MAX_TOAST_ACTIONS} buttons, including the reply button.`,
      path: [
        "actions",
      ],
    },
  )
  .refine((input) => input.imagePlacement !== "hero" || input.image !== null, {
    message: "imagePlacement hero requires image.",
    path: [
      "imagePlacement",
    ],
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
export const notificationListSchema = z.array(notificationResultSchema);
export type NotificationIdentity = z.input<typeof notificationIdentitySchema>;
export type NotificationOptions = z.input<typeof notificationShowSchema>;
export type ResolvedNotification = z.output<typeof notificationShowSchema>;
export type NotificationResult = z.output<typeof notificationResultSchema>;
export type ToastEvent =
  | {
      /** Raw activation: the activator arguments and, when the toast has a reply input, the typed text. */
      kind: "activated";
      arguments: string;
      reply: string | undefined;
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
  "notification.actionInvoked": {
    type: "object",
    properties: {
      ...identityProperties,
      actionId: {
        anyOf: [
          {
            type: "string",
            pattern: "^[A-Za-z0-9._-]{1,16}(?![\\s\\S])",
          },
          {
            const: null,
          },
        ],
      },
      reply: {
        anyOf: [
          {
            type: "string",
            maxLength: MAX_REPLY_LENGTH,
          },
          {
            const: null,
          },
        ],
      },
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
      "actionId",
      "reply",
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
