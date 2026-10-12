import type { ChannelConfig } from "./contract.ts";

type Associations = NonNullable<ChannelConfig["associations"]>;

function object(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected an object.");
  }
  const result = value as Record<string, unknown>;
  for (const key of Object.keys(result)) {
    if (!allowed.includes(key)) {
      throw new Error(`Unknown field ${key}.`);
    }
  }
  return result;
}

function text(value: unknown, field: string, pattern?: RegExp): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 128 ||
    /[\r\n\0]/.test(value) ||
    (pattern && !pattern.test(value))
  ) {
    throw new Error(`Invalid ${field}.`);
  }
  return value;
}

function entries(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    throw new Error("Each association list must contain 1 to 32 entries.");
  }
  return value;
}

/** Validates bounded installer declarations, including registry path components. */
export function parseAssociations(value: unknown): Associations {
  const raw = object(value, [
    "files",
    "urlSchemes",
  ]);
  if (raw.files === undefined && raw.urlSchemes === undefined) {
    throw new Error("Declare files or urlSchemes.");
  }
  const result: Associations = {};
  if (raw.files !== undefined) {
    const seen = new Set<string>();
    result.files = entries(raw.files).map((entry) => {
      const raw = object(entry, [
        "extension",
        "name",
        "mimeType",
      ]);
      const extension = text(
        raw.extension,
        "extension",
        /^\.[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/,
      ).toLowerCase();
      if (seen.has(extension)) {
        throw new Error(`Duplicate extension ${extension}.`);
      }
      seen.add(extension);
      return {
        extension,
        name: text(raw.name, "name"),
        ...(raw.mimeType !== undefined
          ? {
              mimeType: text(
                raw.mimeType,
                "mimeType",
                /^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/,
              ).toLowerCase(),
            }
          : {}),
      };
    });
  }
  if (raw.urlSchemes !== undefined) {
    const seen = new Set<string>();
    result.urlSchemes = entries(raw.urlSchemes).map((entry) => {
      const raw = object(entry, [
        "scheme",
        "name",
      ]);
      const scheme = text(
        raw.scheme,
        "scheme",
        /^[a-zA-Z][a-zA-Z0-9+.-]{0,31}$/,
      ).toLowerCase();
      if (seen.has(scheme)) {
        throw new Error(`Duplicate scheme ${scheme}.`);
      }
      seen.add(scheme);
      return {
        scheme,
        name: text(raw.name, "name"),
      };
    });
  }
  return result;
}
