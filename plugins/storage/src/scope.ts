import type { JsonValue } from "@bunaway/plugin";
import type { StorageLocation } from "./index.ts";

export function matches(
  _permission: string,
  input: JsonValue,
  scope: JsonValue,
): boolean {
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
