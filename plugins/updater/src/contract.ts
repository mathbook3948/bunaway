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
/** Largest update package accepted, whatever size the manifest declares. */
export const MAX_PACKAGE_BYTES = 1024 * 1024 * 1024;
/** Whole package download, redirects included. */
export const UPDATER_DOWNLOAD_TIMEOUT_MS = 30 * 60_000;
/** Redirects followed before a check or download fails. */
export const MAX_REDIRECTS = 3;
/** Longest release notes returned to the view. */
export const MAX_NOTES_LENGTH = 16_384;
/** Longest version string parsed from the app or the manifest. */
export const MAX_VERSION_LENGTH = 256;
/** Longest publication date accepted before normalization. */
export const MAX_DATE_LENGTH = 64;
/** Channel names are short lower-case words so they stay a single URL path or query value. */
export const CHANNEL_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const MAX_CHANNEL_LENGTH = 32;
/** Longest target or architecture word (`windows`, `darwin`, `x86_64`, `aarch64`) with headroom. */
export const MAX_TARGET_LENGTH = 8;
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

export const downloadOutputSchema = z.strictObject({
  /** Absolute path of the verified package inside the app's own update folder. */
  path: z.string(),
  version: z.string(),
  size: z.number().int().nonnegative(),
  sha256: z.string(),
});
/**
 * Result of updater.download. The file matches the SHA-256 and size the manifest declared, which
 * detects transfer errors and tampering in transit; it does not prove who published the package.
 */
export type UpdaterDownloadResult = z.infer<typeof downloadOutputSchema>;

/** What the last successful check found, kept by the adapter so a caller never supplies an address. */
export type UpdateTarget = {
  version: string;
  url: string;
  /** Raw manifest values; the download validates them. */
  sha256: unknown;
  size: unknown;
};

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
  | "platformMissing"
  | "notChecked"
  | "downloadInProgress"
  | "integrityMissing"
  | "integrityInvalid"
  | "integrityMismatch"
  | "sizeMismatch"
  | "storage"
  | "notAvailable";

/** What every platform adapter provides; operations are typed by this interface, not by a platform module. */
export interface UpdaterInstance {
  check(signal?: AbortSignal): Promise<UpdaterCheckResult>;
  download(signal?: AbortSignal): Promise<UpdaterDownloadResult>;
  dispose(): Promise<void>;
  /** Whether a download is running, so the host can delay auto-close. */
  busy(): boolean;
}

/** An open package being written; `discard` is safe after any other call. */
export interface PackageSink {
  write(chunk: Uint8Array): Promise<void>;
  /** Flush and close the file, then report the SHA-256 (lower-case hex) of what was written. */
  finish(): Promise<string>;
  /** Move the finished file to its final name and return its absolute path. */
  publish(): Promise<string>;
  discard(): Promise<void>;
}

/** The app's update folder. The adapter in `platforms/` owns the file system access. */
export interface PackageFiles {
  /** Path of an existing package with exactly this digest and size, or null; a mismatching file is removed. */
  reuse(
    sha256: string,
    size: number,
    signal: AbortSignal,
  ): Promise<string | null>;
  create(sha256: string): Promise<PackageSink>;
  /** Remove every other package and partial file left in the folder. */
  prune(sha256: string): Promise<void>;
}
