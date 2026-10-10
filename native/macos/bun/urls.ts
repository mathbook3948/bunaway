/** Normalize only the validated host-owned scheme into its declared HTTPS origin. */
export function macosOrigin(value: string): string {
  try {
    const url = new URL(value);
    if (url.username || url.password || !url.hostname) {
      return "";
    }
    if (url.protocol === "bunaway:") {
      // WHATWG does not change a non-special scheme to a special scheme in place.
      return new URL(`https://${url.host}`).origin;
    }
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.origin
      : "";
  } catch {
    return "";
  }
}

/** Packaged homes use WebKit's custom scheme. Loopback dev URLs stay HTTP. */
export function platformUrl(value: string): string {
  const url = new URL(value);
  return url.protocol === "https:" && url.hostname === "app.bunaway.local"
    ? value.replace(/^https:/, "bunaway:")
    : value;
}

/** WebKit destination filters allow exact declared scheme/host/port tuples. */
export function resourceRules(origins: readonly string[]): string {
  const rules: object[] = [
    {
      trigger: {
        "url-filter": "^https?://",
      },
      action: {
        type: "block",
      },
    },
  ];
  for (const value of origins) {
    const url = new URL(value);
    let defaultPort = "";
    if (!url.port) {
      defaultPort = url.protocol === "https:" ? "(:443)?" : "(:80)?";
    }
    const prefix = `^${url.origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}${defaultPort}`;
    for (const ending of [
      "[/?#]",
      "$",
    ]) {
      rules.push({
        trigger: {
          "url-filter": prefix + ending,
        },
        action: {
          type: "ignore-previous-rules",
        },
      });
    }
  }
  return JSON.stringify(rules);
}
