import { BunawayError } from "@bunaway/plugin";
import {
  isWindowsFileName,
  WINDOWS_MAX_FILE_NAME_LENGTH,
} from "@bunaway/protocol";
import {
  fileIconExtension,
  type JumpListInput,
  type JumpListTask,
  jumpListInput,
  MAX_FILE_PATH_LENGTH,
  type ShortcutDetails,
  type ShortcutOperation,
  shortcutDetailsSchema,
} from "#opener/contract";

/** A selected application is a native executable, not a shell command or shortcut. */
export function normalizeApplicationPath(input: unknown): string {
  const path = normalizeFilePath(input);
  if (!/\.exe$/i.test(path)) {
    throw new BunawayError({
      code: "INVALID_ARGUMENT",
      message: "Expected an absolute Windows .exe application path.",
    });
  }
  return path;
}
/** The file a path resolves to keeps the extension its operation requires, whatever its link was named. */
export function assertResolvedExtension(
  path: string,
  extension: "exe" | "lnk",
): void {
  if (!path.toLowerCase().endsWith(`.${extension}`)) {
    throw new BunawayError({
      code: "INVALID_ARGUMENT",
      message: `The path resolves to a file that is not a .${extension} file.`,
    });
  }
}

/** A shortcut file is a Windows `.lnk` file, so the Shell never treats another file as a link. */
export function normalizeShortcutPath(input: unknown): string {
  const path = normalizeFilePath(input);
  if (!/\.lnk$/i.test(path)) {
    throw new BunawayError({
      code: "INVALID_ARGUMENT",
      message: "Expected an absolute Windows .lnk shortcut path.",
    });
  }
  return path;
}

/**
 * Validate shortcut properties without filesystem access. Targets, working directories
 * and icon files are absolute paths that need not exist yet; `create` and `replace` start
 * from an empty link and so need a target.
 */
export function normalizeShortcutDetails(
  input: unknown,
  operation: ShortcutOperation,
): ShortcutDetails {
  const parsed = shortcutDetailsSchema.safeParse(input);
  if (!parsed.success) {
    throw new BunawayError({
      code: "INVALID_ARGUMENT",
      message: "Invalid shortcut properties.",
    });
  }
  const details = parsed.data;
  if (operation !== "update" && details.target === undefined) {
    throw new BunawayError({
      code: "INVALID_ARGUMENT",
      message: "A shortcut target is required.",
    });
  }
  const normalized: ShortcutDetails = {
    ...details,
  };
  for (const key of [
    "target",
    "cwd",
    "icon",
  ] as const) {
    const value = details[key];
    // An empty working directory or icon file clears the property; the target cannot be cleared.
    if (value !== undefined && !(value === "" && key !== "target")) {
      normalized[key] = normalizeFilePath(value);
    }
  }
  return normalized;
}

/**
 * Validate a Jump List request without filesystem access. Task working directories and icon
 * files are absolute Windows paths that need not exist, as for shortcuts.
 */
export function normalizeJumpList(input: unknown): JumpListInput {
  const parsed = jumpListInput.safeParse(input);
  if (!parsed.success) {
    throw new BunawayError({
      code: "INVALID_ARGUMENT",
      message: "Invalid Jump List.",
    });
  }
  const normalizeTask = (task: JumpListTask): JumpListTask => ({
    ...task,
    ...(task.cwd === undefined
      ? {}
      : {
          cwd: normalizeFilePath(task.cwd),
        }),
    ...(task.iconPath === undefined
      ? {}
      : {
          iconPath: normalizeFilePath(task.iconPath),
        }),
  });
  return {
    categories: parsed.data.categories.map((category) =>
      category.type === "custom"
        ? {
            ...category,
            items: category.items.map(normalizeTask),
          }
        : {
            ...category,
            items: category.items.map((item) =>
              item.type === "task" ? normalizeTask(item) : item,
            ),
          },
    ),
  };
}

/** Validate a fully qualified Windows file path without filesystem access. */
export function normalizeFilePath(input: unknown): string {
  const invalid = () =>
    new BunawayError({
      code: "INVALID_ARGUMENT",
      message:
        "Expected an absolute Windows file path of at most 259 UTF-16 code units.",
    });
  if (
    typeof input !== "string" ||
    input.length > MAX_FILE_PATH_LENGTH ||
    /[\p{Cc}\p{Cs}<>:"|?*]/u.test(input.slice(2))
  ) {
    throw invalid();
  }
  const path = input.replaceAll("/", "\\");
  const drivePath = /^[A-Za-z]:\\/.test(path);
  const parts = path.split("\\");
  const rootParts = drivePath ? 1 : 4;
  if (!drivePath && (!path.startsWith("\\\\") || !parts[2] || !parts[3])) {
    throw invalid();
  }
  const names = drivePath ? parts.slice(1) : parts.slice(2);
  if (
    parts.length <= rootParts ||
    names.some((part) => !isWindowsFileName(part, WINDOWS_MAX_FILE_NAME_LENGTH))
  ) {
    throw invalid();
  }
  return drivePath ? `${path.charAt(0).toUpperCase()}${path.slice(1)}` : path;
}

/** An extension for a file icon lookup, checked like the host input so a bad value fails before the call. */
export function normalizeFileIconExtension(input: unknown): string {
  const parsed = fileIconExtension.safeParse(input);
  if (!parsed.success) {
    throw new BunawayError({
      code: "INVALID_ARGUMENT",
      message: "Expected a file extension such as .txt.",
    });
  }
  return parsed.data;
}
