import {
  hasValidWindowSizeConstraints,
  isWindowSizeDimension,
  MAX_WINDOW_DIMENSION,
  MIN_WINDOW_DIMENSION,
  type WindowSizeConstraints,
  type WindowSpec,
} from "@bunaway/plugin-api/native";
import type { Policy } from "@bunaway/protocol";

export type { WindowSpec } from "@bunaway/plugin-api/native";

/** Maximum number of window definitions accepted at startup. */
export const MAX_WINDOWS = 128;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a window configuration object.");
  }
  return value as Record<string, unknown>;
}

/**
 * Validates window definitions against the app origin and view policy.
 * A development URL, when supplied, becomes the required home origin.
 * Startup liveness is validated by the host after loading the app definition.
 */
export function readWindowSpecs(
  value: unknown,
  policy: Policy,
  developmentUrl?: string,
): WindowSpec[] {
  if (!Array.isArray(value) || value.length > MAX_WINDOWS) {
    throw new Error(
      "windows must contain between 0 and 128 window definitions.",
    );
  }
  const seen = new Set<string>();
  const specs = value.map((item): WindowSpec => {
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
            "visible",
            "showWhenReady",
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
            "minWidth",
            "minHeight",
            "maxWidth",
            "maxHeight",
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
        dimension < MIN_WINDOW_DIMENSION ||
        dimension > MAX_WINDOW_DIMENSION
      ) {
        throw new Error(
          `Window dimensions must be integers between ${MIN_WINDOW_DIMENSION} and ${MAX_WINDOW_DIMENSION}.`,
        );
      }
    }
    const minWidth = readSizeConstraint(size.minWidth, "minWidth");
    const minHeight = readSizeConstraint(size.minHeight, "minHeight");
    const maxWidth = readSizeConstraint(size.maxWidth, "maxWidth");
    const maxHeight = readSizeConstraint(size.maxHeight, "maxHeight");
    const constraints: WindowSizeConstraints = {
      minWidth: minWidth ?? null,
      minHeight: minHeight ?? null,
      maxWidth: maxWidth ?? null,
      maxHeight: maxHeight ?? null,
    };
    if (!hasValidWindowSizeConstraints(constraints)) {
      throw new Error(
        "Window minimum dimensions cannot exceed maximum dimensions.",
      );
    }
    if (spec.startup !== undefined && typeof spec.startup !== "boolean") {
      throw new Error("Window startup must be a boolean.");
    }
    if (spec.visible !== undefined && typeof spec.visible !== "boolean") {
      throw new Error("Window visible must be a boolean.");
    }
    if (
      spec.showWhenReady !== undefined &&
      spec.showWhenReady !== "document" &&
      spec.showWhenReady !== "sdk"
    ) {
      throw new Error("Window showWhenReady must be document or sdk.");
    }
    return {
      view: spec.view,
      title: spec.title,
      home: spec.home,
      ...(spec.visible === undefined
        ? {}
        : {
            visible: spec.visible,
          }),
      ...(spec.showWhenReady === undefined
        ? {}
        : {
            showWhenReady: spec.showWhenReady,
          }),
      window: {
        width: Number(size.width),
        height: Number(size.height),
        ...(minWidth === undefined
          ? {}
          : {
              minWidth,
            }),
        ...(minHeight === undefined
          ? {}
          : {
              minHeight,
            }),
        ...(maxWidth === undefined
          ? {}
          : {
              maxWidth,
            }),
        ...(maxHeight === undefined
          ? {}
          : {
              maxHeight,
            }),
      },
      ...(spec.startup === undefined
        ? {}
        : {
            startup: spec.startup,
          }),
    };
  });
  return specs;
}

function readSizeConstraint(
  value: unknown,
  name: string,
): number | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isWindowSizeDimension(value)) {
    throw new Error(
      `Window ${name} must be null or an integer between ${MIN_WINDOW_DIMENSION} and ${MAX_WINDOW_DIMENSION}.`,
    );
  }
  return value;
}
