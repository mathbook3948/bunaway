import type { Policy } from "@bunaway/protocol";

// Shared by the CLI and Windows host. Development never accepts a LAN or remote origin.
export function developmentUrl(value: unknown): URL {
  if (typeof value !== "string") throw new Error("dev.url must be a loopback HTTP(S) URL.");
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !["localhost", "127.0.0.1"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new Error(
      "dev.url must use http(s)://localhost or 127.0.0.1 without credentials or a fragment.",
    );
  return url;
}

export function developmentPolicy(policy: Policy, viewId: string, url: string): Policy {
  const origin = developmentUrl(url).origin;
  return {
    ...policy,
    views: policy.views.map((view) => (view.id === viewId ? { ...view, origins: [origin] } : view)),
  };
}

// Both a development artifact and an explicit launch flag are required.
export function verifyDevelopmentLaunch(marker: unknown, launchUrl?: string): string | undefined {
  if (marker === undefined && launchUrl === undefined) return undefined;
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
