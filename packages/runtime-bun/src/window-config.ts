import {
  hasValidWindowPlacement,
  hasValidWindowSizeConstraints,
  isWindowSizeDimension,
  MAX_WINDOW_DIMENSION,
  MAX_WINDOW_INSTANCES,
  MAX_WINDOWS,
  MIN_WINDOW_DIMENSION,
  type WindowSizeConstraints,
  type WindowSpec,
} from "@bunaway/plugin-api/native";
import type { Policy } from "@bunaway/protocol";

export { MAX_WINDOWS, type WindowSpec } from "@bunaway/plugin-api/native";

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
      `windows must contain between 0 and ${MAX_WINDOWS} window definitions.`,
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
            "instances",
            "maxInstances",
            "profile",
          ].includes(key),
      )
    ) {
      throw new Error("Unknown window configuration field.");
    }
    if (
      typeof spec.view !== "string" ||
      !/^[A-Za-z0-9_.:-]{1,128}$(?![\s\S])/.test(spec.view)
    ) {
      throw new Error(
        "Window view IDs must contain 1 to 128 ASCII letters, digits, underscores, dots, colons or hyphens.",
      );
    }
    if (seen.has(spec.view)) {
      throw new Error(
        `Only one window declaration per view is supported (duplicate: ${spec.view}). Declare instances: multiple to create multiple windows.`,
      );
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
            "x",
            "y",
            "center",
            "useContentSize",
            "preventOverflow",
            "focusable",
            "maximized",
            "fullscreen",
          ].includes(key),
      )
    ) {
      throw new Error("Unknown window size field.");
    }
    if (!hasValidWindowPlacement(size)) {
      throw new Error(
        "Window placement requires paired integer x/y, boolean options and no center/position conflict.",
      );
    }
    const focusable = size.focusable;
    if (focusable !== undefined && typeof focusable !== "boolean") {
      throw new Error("Window focusable must be a boolean.");
    }
    const initialState: Pick<WindowSpec["window"], "maximized" | "fullscreen"> =
      {};
    for (const name of [
      "maximized",
      "fullscreen",
    ] as const) {
      const option = size[name];
      if (option === undefined) {
        continue;
      }
      if (typeof option !== "boolean") {
        throw new Error(`Window ${name} must be a boolean.`);
      }
      initialState[name] = option;
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
    if (
      spec.instances !== undefined &&
      spec.instances !== "single" &&
      spec.instances !== "multiple"
    ) {
      throw new Error("Window instances must be single or multiple.");
    }
    if (
      (spec.instances === "multiple" && spec.maxInstances === undefined) ||
      (spec.maxInstances !== undefined &&
        (typeof spec.maxInstances !== "number" ||
          !Number.isInteger(spec.maxInstances) ||
          spec.maxInstances < 1 ||
          spec.maxInstances > MAX_WINDOW_INSTANCES ||
          (spec.instances !== "multiple" && spec.maxInstances !== 1)))
    ) {
      throw new Error(
        `Multiple windows require maxInstances from 1 through ${MAX_WINDOW_INSTANCES}; single permits only 1.`,
      );
    }
    if (
      spec.profile !== undefined &&
      spec.profile !== "shared" &&
      spec.profile !== "isolated"
    ) {
      throw new Error("Window profile must be shared or isolated.");
    }
    return {
      view: spec.view,
      title: spec.title,
      ...(spec.instances === undefined
        ? {}
        : {
            instances: spec.instances,
          }),
      ...(spec.maxInstances === undefined
        ? {}
        : {
            maxInstances: Number(spec.maxInstances),
          }),
      ...(spec.profile === undefined
        ? {}
        : {
            profile: spec.profile,
          }),
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
        ...(focusable === undefined
          ? {}
          : {
              focusable,
            }),
        ...initialState,
        ...(size.x === undefined
          ? {}
          : {
              x: size.x,
            }),
        ...(size.y === undefined
          ? {}
          : {
              y: size.y,
            }),
        ...(size.center === undefined
          ? {}
          : {
              center: size.center,
            }),
        ...(size.useContentSize === undefined
          ? {}
          : {
              useContentSize: size.useContentSize,
            }),
        ...(size.preventOverflow === undefined
          ? {}
          : {
              preventOverflow: size.preventOverflow,
            }),
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
