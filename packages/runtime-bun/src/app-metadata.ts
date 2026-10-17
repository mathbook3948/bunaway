import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { APP_INFO_MAX_LENGTH, type AppInfo } from "@bunaway/plugin-api";

/**
 * App facts known before the backend starts. Hosts add the runtime-dependent
 * Bun and WebView versions with `toAppInfo`.
 */
export type AppMetadata = {
  /** App settings `title`. */
  readonly name: string;
  /** App settings `appId`. */
  readonly identifier: string;
  /** Package manifest `app.version`, or `null` when absent. */
  readonly version: string | null;
  /** Package manifest `framework.version`, or `null` when absent. */
  readonly framework: string | null;
  /** Whether the host runs a compiled app; mobile and process backends are always bundled. */
  readonly isPackaged: boolean;
  /** App locations, or `null` for runtimes without a file system package. */
  readonly paths: AppInfo["paths"];
};

/**
 * Builds desktop `AppInfo.paths` from the verified package root and the real
 * executable path. The root doubles as the resources directory: Windows keeps
 * resources beside the executable, macOS packaged apps pass `Contents/Resources`
 * as the root, and development launches use the build output directory.
 */
export function desktopAppPaths(
  root: string,
  executable: string,
): NonNullable<AppInfo["paths"]> {
  return {
    package: root,
    executable,
    resources: root,
  };
}

/**
 * Whether `value` is acceptable as an `AppInfo` string: non-empty and at most
 * `APP_INFO_MAX_LENGTH` UTF-16 code units. The single rule shared by the CLI
 * (build time) and the hosts (startup); callers add their own error context.
 */
export function isAppInfoText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= APP_INFO_MAX_LENGTH
  );
}

function boundedText(field: string, value: unknown): string {
  if (!isAppInfoText(value)) {
    throw new Error(`Invalid package manifest ${field}.`);
  }
  return value;
}

/** Reads an optional version string from a manifest section; an absent field is `null`. */
function optionalVersion(
  manifest: object,
  section: "app" | "framework",
): string | null {
  const value: unknown = Reflect.get(manifest, section);
  if (value === undefined) {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid package manifest ${section}.`);
  }
  const version = Reflect.get(value, "version");
  return version === undefined
    ? null
    : boundedText(`${section}.version`, version);
}

/**
 * Extracts the app and framework versions from the package-level
 * `manifest.json`. Absent fields yield `null`; present values that are not
 * bounded non-empty strings reject so startup fails like other manifest errors.
 */
export function parsePackageVersions(
  value: unknown,
): Pick<AppMetadata, "version" | "framework"> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid package manifest.");
  }
  return {
    version: optionalVersion(value, "app"),
    framework: optionalVersion(value, "framework"),
  };
}

/**
 * Reads and parses the package-level `manifest.json` in `packageRoot`.
 * A missing file yields `null` versions, because packages built before
 * `ctx.app` existed and hand-assembled packages have none. Other read errors
 * and malformed content reject.
 */
export async function readPackageVersions(
  packageRoot: string,
): Promise<Pick<AppMetadata, "version" | "framework">> {
  let text: string;
  try {
    text = await readFile(resolve(packageRoot, "manifest.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        version: null,
        framework: null,
      };
    }
    throw error;
  }
  return parsePackageVersions(JSON.parse(text));
}

/**
 * Resolves the `AppInfo.name` from the app settings `title`. Manifests without
 * a title fall back to the app identifier; a present title must be valid.
 */
export function appName(title: unknown, identifier: string): string {
  return title === undefined ? identifier : boundedText("app title", title);
}

/**
 * Combines host-known metadata with the runtime versions the host measured.
 * Rejects when `metadata` is absent, because hosts must always supply it and a
 * `TypeError` on a missing property would not say so.
 */
export function toAppInfo(
  metadata: AppMetadata,
  runtime: {
    readonly bun: string;
    readonly webview: string | null;
  },
): AppInfo {
  // The type says present; JavaScript callers and stale hosts can still omit it.
  // Metadata from before isPackaged and paths existed lacks both fields.
  if (
    !metadata ||
    typeof metadata !== "object" ||
    typeof metadata.isPackaged !== "boolean" ||
    metadata.paths === undefined
  ) {
    throw new Error(
      "Missing app metadata: the host must pass the app name, identifier, versions, isPackaged and paths.",
    );
  }
  return {
    name: metadata.name,
    identifier: metadata.identifier,
    version: metadata.version,
    isPackaged: metadata.isPackaged,
    paths: metadata.paths,
    runtime: {
      framework: metadata.framework,
      bun: runtime.bun,
      webview: runtime.webview,
    },
  };
}
