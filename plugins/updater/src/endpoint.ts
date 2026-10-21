import { BunawayError } from "@bunaway/protocol";
import {
  MAX_CHANNEL_LENGTH,
  MAX_TARGET_LENGTH,
  MAX_URL_LENGTH,
  MAX_VERSION_LENGTH,
} from "#updater/contract";

/** Placeholders an endpoint template may use; each value is URL-encoded when substituted. */
const PLACEHOLDERS = [
  "target",
  "arch",
  "channel",
  "current_version",
] as const;
export type EndpointValues = Record<(typeof PLACEHOLDERS)[number], string>;

const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;
const LOOPBACK_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
]);

function invalid(message: string): BunawayError {
  return new BunawayError({
    code: "INVALID_ARGUMENT",
    message,
  });
}

/**
 * Whether `url` may be requested. Only https is allowed; http is allowed for a loopback host when
 * the app runs from a development launch, so a packaged app cannot be pointed at plain http.
 */
export function isAllowedUrl(url: URL, development: boolean): boolean {
  if (url.username || url.password) {
    return false;
  }
  if (url.protocol === "https:") {
    return true;
  }
  return (
    url.protocol === "http:" && development && LOOPBACK_HOSTS.has(url.hostname)
  );
}

/** Validate an endpoint template once, so a bad setting fails at startup rather than at check time. */
export function validateEndpointTemplate(
  template: string,
  development: boolean,
): void {
  const unknown = [
    ...template.matchAll(PLACEHOLDER),
  ].find((match) => !PLACEHOLDERS.some((name) => name === match[1]));
  if (unknown) {
    throw invalid(
      `updater endpoint uses unknown placeholder {{${unknown[1]}}}.`,
    );
  }
  // Placeholders are limited to the path and query, so a value can never change scheme or host.
  const head = /^([^/?#]*):\/\/([^/?#]*)/.exec(template);
  if (!head) {
    throw invalid("updater endpoint must be an absolute URL.");
  }
  if (head[1]?.includes("{{") || head[2]?.includes("{{")) {
    throw invalid(
      "updater endpoint must not use placeholders in the scheme or host.",
    );
  }
  let url: URL;
  try {
    url = new URL(template.replaceAll(PLACEHOLDER, "x"));
  } catch {
    throw invalid("updater endpoint is not a valid URL.");
  }
  if (url.hash) {
    throw invalid("updater endpoint must not have a fragment.");
  }
  if (!isAllowedUrl(url, development)) {
    throw invalid(
      "updater endpoint must be https without credentials (http only for loopback in development).",
    );
  }
  // Reject at startup a template that could exceed the length limit once the longest values are
  // substituted, so a check call never fails on the settings. `+` is the worst case: it becomes %2B.
  expandEndpoint(template, {
    target: "x".repeat(MAX_TARGET_LENGTH),
    arch: "x".repeat(MAX_TARGET_LENGTH),
    channel: "x".repeat(MAX_CHANNEL_LENGTH),
    current_version: "+".repeat(MAX_VERSION_LENGTH),
  });
}

/** Substitute the values into a template that passed `validateEndpointTemplate`. */
export function expandEndpoint(template: string, values: EndpointValues): URL {
  const expanded = template.replaceAll(PLACEHOLDER, (_match, name: string) =>
    encodeURIComponent(values[name as keyof EndpointValues]),
  );
  if (expanded.length > MAX_URL_LENGTH * 2) {
    throw invalid("updater endpoint is too long after substitution.");
  }
  return new URL(expanded);
}
