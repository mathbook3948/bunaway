import type { Policy } from "@bunaway/protocol";

export type AppReloadRequest = {
  kind: "bunaway:reload-app";
  id: string;
  sha256: string;
};
export type AppReloadResult = {
  kind: "bunaway:reload-result";
  id: string;
  status: "reloaded" | "restart" | "failed";
  message?: string;
};
const RELOAD_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export const MAX_APP_RELOAD_MESSAGE_CHARS = 4096;

export function readAppReloadRequest(value: unknown): AppReloadRequest {
  if (
    !value ||
    typeof value !== "object" ||
    !("kind" in value) ||
    value.kind !== "bunaway:reload-app" ||
    !("id" in value) ||
    typeof value.id !== "string" ||
    !RELOAD_ID.test(value.id) ||
    !("sha256" in value) ||
    typeof value.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.sha256) ||
    Object.keys(value).length !== 3
  ) {
    throw new Error("Invalid app reload request.");
  }
  return {
    kind: value.kind,
    id: value.id,
    sha256: value.sha256,
  };
}

export function readAppReloadResult(value: unknown): AppReloadResult {
  if (
    !value ||
    typeof value !== "object" ||
    !("kind" in value) ||
    value.kind !== "bunaway:reload-result" ||
    !("id" in value) ||
    typeof value.id !== "string" ||
    !RELOAD_ID.test(value.id) ||
    !("status" in value) ||
    (value.status !== "reloaded" &&
      value.status !== "restart" &&
      value.status !== "failed") ||
    ("message" in value &&
      (typeof value.message !== "string" ||
        value.message.length > MAX_APP_RELOAD_MESSAGE_CHARS)) ||
    Object.keys(value).some(
      (key) =>
        ![
          "kind",
          "id",
          "status",
          "message",
        ].includes(key),
    )
  ) {
    throw new Error("Invalid app reload result.");
  }
  const message = "message" in value ? value.message : undefined;
  return {
    kind: value.kind,
    id: value.id,
    status: value.status,
    ...(typeof message === "string"
      ? {
          message,
        }
      : {}),
  };
}

// Shared by the CLI and Windows host. Development never accepts a LAN or remote origin.
export function developmentUrl(value: unknown): URL {
  if (typeof value !== "string") {
    throw new Error("dev.url must be a loopback HTTP(S) URL.");
  }
  const url = new URL(value);
  if (
    ![
      "http:",
      "https:",
    ].includes(url.protocol) ||
    ![
      "localhost",
      "127.0.0.1",
    ].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error(
      "dev.url must use http(s)://localhost or 127.0.0.1 without credentials or a fragment.",
    );
  }
  return url;
}

export function developmentPolicy(
  policy: Policy,
  viewId: string | readonly string[],
  url: string,
): Policy {
  const origin = developmentUrl(url).origin;
  return {
    ...policy,
    views: policy.views.map((view) =>
      (
        typeof viewId === "string"
          ? view.id === viewId
          : viewId.includes(view.id)
      )
        ? {
            ...view,
            origins: [
              origin,
            ],
          }
        : view,
    ),
  };
}

// Both a development artifact and an explicit launch flag are required.
export function verifyDevelopmentLaunch(
  marker: unknown,
  launchUrl?: string,
): string | undefined {
  if (marker === undefined && launchUrl === undefined) {
    return undefined;
  }
  if (
    !marker ||
    typeof marker !== "object" ||
    Array.isArray(marker) ||
    Object.keys(marker).length !== 1 ||
    !("url" in marker) ||
    launchUrl === undefined ||
    marker.url !== launchUrl
  ) {
    throw new Error(
      "Development URL requires a matching development artifact and --dev-url launch flag.",
    );
  }
  return developmentUrl(launchUrl).href;
}

// Keep each window's production path when using one shared loopback UI server.
export function developmentWindowHome(home: string, server: string): string {
  const source = new URL(home);
  const target = developmentUrl(server);
  target.pathname = source.pathname;
  target.search = source.search;
  return target.href;
}

export function verifyDevelopmentToolsLaunch(
  marker: unknown,
  requested = false,
): boolean {
  if (marker === undefined && !requested) {
    return false;
  }
  if (marker !== true || !requested) {
    throw new Error(
      "DevTools require a development artifact and the --devtools launch flag.",
    );
  }
  return true;
}
