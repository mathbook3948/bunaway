import { APP_INFO_MAX_LENGTH, type AppInfo } from "@bunaway/plugin-api";
import { BunawayError } from "@bunaway/protocol";

function invalid(field: string): never {
  throw new BunawayError({
    code: "INVALID_ARGUMENT",
    message: `Invalid app info "${field}".`,
  });
}

function requireText(field: string, value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > APP_INFO_MAX_LENGTH
  ) {
    return invalid(field);
  }
  return value;
}

function optionalText(field: string, value: unknown): string | null {
  return value === null ? null : requireText(field, value);
}

/**
 * Validates host-supplied app metadata once at the host to Core boundary.
 * Returns a detached, deeply frozen copy so every context shares one immutable
 * object and later host mutations cannot change it. Fails with
 * `INVALID_ARGUMENT` for missing, empty, oversized or non-string fields.
 */
export function freezeAppInfo(info: AppInfo): AppInfo {
  // The type describes the contract, but the value crosses a host boundary.
  if (typeof info !== "object" || info === null) {
    return invalid("app");
  }
  const { runtime } = info;
  if (typeof runtime !== "object" || runtime === null) {
    return invalid("runtime");
  }
  return Object.freeze({
    name: requireText("name", info.name),
    identifier: requireText("identifier", info.identifier),
    version: optionalText("version", info.version),
    runtime: Object.freeze({
      framework: optionalText("runtime.framework", runtime.framework),
      bun: requireText("runtime.bun", runtime.bun),
      webview: optionalText("runtime.webview", runtime.webview),
    }),
  });
}
