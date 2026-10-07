import type { Policy } from "@bunaway/protocol";

export const MAX_WINDOWS = 128;
export type WindowSpec = {
  view: string;
  home: string;
  title: string;
  window: {
    width: number;
    height: number;
  };
  startup?: boolean;
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a window configuration object.");
  }
  return value as Record<string, unknown>;
}

// Shared validation for CLI settings and verified package boot, without native dependencies.
export function readWindowSpecs(
  value: unknown,
  policy: Policy,
  developmentUrl?: string,
): WindowSpec[] {
  if (!Array.isArray(value) || !value.length || value.length > MAX_WINDOWS) {
    throw new Error(
      "windows must contain between 1 and 128 window definitions.",
    );
  }
  const seen = new Set<string>();
  const specs = value.map((item) => {
    const spec = object(item);
    if (
      Object.keys(spec).some(
        (key) =>
          ![
            "view",
            "home",
            "title",
            "window",
            "startup",
          ].includes(key),
      )
    ) {
      throw new Error("Unknown window configuration field.");
    }
    if (
      typeof spec.view !== "string" ||
      !/^[A-Za-z0-9_.:-]{1,128}$/.test(spec.view) ||
      seen.has(spec.view)
    ) {
      throw new Error("Window view IDs must be valid and unique.");
    }
    seen.add(spec.view);
    if (
      typeof spec.title !== "string" ||
      !spec.title ||
      spec.title.length > 1024 ||
      spec.title.includes("\0")
    ) {
      throw new Error(
        "Window title must contain 1 to 1024 characters without NUL.",
      );
    }
    if (typeof spec.home !== "string") {
      throw new Error("Window home must be a URL.");
    }
    const url = new URL(spec.home);
    const origin = developmentUrl
      ? new URL(developmentUrl).origin
      : "https://app.bunaway.local";
    if (url.origin !== origin || url.username || url.password || url.hash) {
      throw new Error(
        "Window home must use the allowed app origin without credentials or a fragment.",
      );
    }
    if (
      !policy.views
        .find((view) => view.id === spec.view)
        ?.origins.includes(origin)
    ) {
      throw new Error(
        "Window view and home origin must be permitted by policy.json.",
      );
    }
    const size = object(spec.window);
    if (
      Object.keys(size).some(
        (key) =>
          ![
            "width",
            "height",
          ].includes(key),
      )
    ) {
      throw new Error("Unknown window size field.");
    }
    for (const dimension of [
      size.width,
      size.height,
    ]) {
      if (
        typeof dimension !== "number" ||
        !Number.isInteger(dimension) ||
        dimension < 200 ||
        dimension > 4096
      ) {
        throw new Error(
          "Window dimensions must be integers between 200 and 4096.",
        );
      }
    }
    if (spec.startup !== undefined && typeof spec.startup !== "boolean") {
      throw new Error("Window startup must be a boolean.");
    }
    return {
      view: spec.view,
      title: spec.title,
      home: spec.home,
      window: {
        width: Number(size.width),
        height: Number(size.height),
      },
      ...(spec.startup === undefined
        ? {}
        : {
            startup: spec.startup,
          }),
    };
  });
  if (!specs.some((spec) => spec.startup !== false)) {
    throw new Error("At least one window must open at startup.");
  }
  return specs;
}
