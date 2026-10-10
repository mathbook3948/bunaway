import type { JsonValue } from "@bunaway/plugin";
import { normalizeFilePath } from "./path.ts";

/** Match one exact file path. The registry validates both objects before matching. */
export function matches(
  _permission: string,
  input: JsonValue,
  scope: JsonValue,
): boolean {
  const target = input as {
    path: string;
  };
  const grant = scope as {
    path: string;
  };
  try {
    return normalizeFilePath(target.path) === normalizeFilePath(grant.path);
  } catch {
    // Invalid path spellings never authorize an OS operation.
    return false;
  }
}
