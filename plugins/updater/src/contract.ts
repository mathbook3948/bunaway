import { z } from "zod";

/** Platforms the plugin runs on, with the target words the update manifest and endpoint use. */
export const UPDATER_TARGETS = {
  windows: "windows",
  macos: "darwin",
} as const;
export type UpdaterPlatform = keyof typeof UPDATER_TARGETS;

/** Longest endpoint template and downloadUrl accepted, in UTF-16 code units. */
export const MAX_URL_LENGTH = 2048;
/** Largest manifest body read after decompression. */
export const MAX_MANIFEST_BYTES = 64 * 1024;
/** Whole check, redirects included. */
export const UPDATER_CHECK_TIMEOUT_MS = 15_000;
/** Redirects followed before the check fails. */
export const MAX_REDIRECTS = 3;
/** Longest release notes returned to the view. */
export const MAX_NOTES_LENGTH = 16_384;
/** Longest version string parsed from the app or the manifest. */
export const MAX_VERSION_LENGTH = 256;
/** Longest publication date accepted before normalization. */
export const MAX_DATE_LENGTH = 64;
/** Channel names are short lower-case words so they stay a single URL path or query value. */
export const CHANNEL_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const DEFAULT_CHANNEL = "stable";

/** The `plugins.updater` clause of bunaway.json. The app fixes it; callers cannot choose an endpoint. */
export const settingsSchema = z.strictObject({
  endpoint: z.string().min(1).max(MAX_URL_LENGTH),
  channel: z.string().regex(CHANNEL_PATTERN).default(DEFAULT_CHANNEL),
});
export type UpdaterSettings = z.output<typeof settingsSchema>;

export const checkOutputSchema = z.strictObject({
  updateAvailable: z.boolean(),
  currentVersion: z.string(),
  version: z.string().nullable(),
  notes: z.string().nullable(),
  publishedAt: z.string().nullable(),
  downloadUrl: z.string().nullable(),
});
/**
 * Result of updater.check. `notes` and `downloadUrl` come from a remote server: show notes as
 * plain text, and treat the URL as a hint that proves nothing about the update's origin.
 */
export type UpdaterCheckResult = z.infer<typeof checkOutputSchema>;

/** Stable machine-readable failure causes, reported as `details.reason`. */
export type UpdaterFailureReason =
  | "notConfigured"
  | "appVersionMissing"
  | "appVersionInvalid"
  | "unsupportedArch"
  | "network"
  | "httpStatus"
  | "redirectLimit"
  | "redirectScheme"
  | "tooLarge"
  | "invalidJson"
  | "invalidManifest"
  | "invalidVersion"
  | "platformMissing";

/** What every platform adapter provides; operations are typed by this interface, not by a platform module. */
export interface UpdaterInstance {
  check(signal?: AbortSignal): Promise<UpdaterCheckResult>;
  dispose(): void;
}
