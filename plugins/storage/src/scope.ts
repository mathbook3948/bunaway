import type { JsonValue } from "@bunaway/plugin";
import type { StorageLocation } from "./index.ts";

/**
 * Match grants by storage area and case-sensitive segments. `notes` excludes
 * `notes-old`, while an empty prefix covers the area. Filesystem checks happen
 * in the native adapter after authorization.
 */
export function matches(
  _permission: string,
  input: JsonValue,
  scope: JsonValue,
): boolean {
  // The registry validates operation inputs and grants against their schemas before matching.
  const location = input as StorageLocation;
  const grant = scope as {
    scope: StorageLocation["scope"];
    pathPrefix: string;
  };
  const segments = location.path.split("/");
  const prefix = grant.pathPrefix ? grant.pathPrefix.split("/") : [];
  return (
    grant.scope === location.scope &&
    prefix.every((part, index) => part === segments[index])
  );
}
