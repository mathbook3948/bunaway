import { validateResourceIconPath } from "@bunaway/plugin/resource-icon";
import {
  hasValidWindowPlacement,
  hasValidWindowSizeConstraints,
  isWindowSizeDimension,
  MAX_WINDOW_DIMENSION,
  MIN_WINDOW_DIMENSION,
  normalizeWindowBackgroundColor,
  transparentWindowError,
  type WindowSizeConstraints,
  type WindowSpec,
} from "@bunaway/plugin-api/native";
import type { Policy } from "@bunaway/protocol";
import { isRecord } from "@bunaway/protocol";

export type { WindowSpec } from "@bunaway/plugin-api/native";

function object(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error("Expected a window configuration object.");
  }
  return value;
}

const SPEC_FIELDS = [
  "view",
  "home",
  "title",
  "window",
  "startup",
  "visible",
  "showWhenReady",
];

const SIZE_FIELDS = [
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
  "titlebar",
  "alwaysOnTop",
  "skipTaskbar",
  "contentProtection",
  "backgroundColor",
  "accentColor",
  "transparent",
  "icon",
  "maximized",
  "fullscreen",
];

const INITIAL_STATE_OPTIONS = [
  "maximized",
  "fullscreen",
  "alwaysOnTop",
  "skipTaskbar",
  "contentProtection",
] as const;

type InitialState = Pick<
  WindowSpec["window"],
  (typeof INITIAL_STATE_OPTIONS)[number]
>;

type Defined<T> = {
  [Key in keyof T]?: Exclude<T[Key], undefined>;
};

/** Copies the entries whose value is defined, so optional fields stay absent instead of undefined. */
function definedEntries<T extends object>(entries: T): Defined<T> {
  return Object.fromEntries(
    Object.entries(entries).filter(([, value]) => value !== undefined),
  ) as Defined<T>;
}

/**
 * Validates the app's single window definition against the app origin and view policy.
 * A development URL, when supplied, becomes the required home origin.
 * Startup liveness is validated by the host after loading the app definition.
 */
export function readWindowSpecs(
  value: unknown,
  policy: Policy,
  developmentUrl?: string,
): WindowSpec[] {
  if (!Array.isArray(value) || value.length !== 1) {
    throw new Error("windows must contain exactly one window definition.");
  }
  const seen = new Set<string>();
  return value.map((item) =>
    readWindowSpec(object(item), policy, developmentUrl, seen),
  );
}

function readWindowSpec(
  spec: Record<string, unknown>,
  policy: Policy,
  developmentUrl: string | undefined,
  seen: Set<string>,
): WindowSpec {
  if (Object.keys(spec).some((key) => !SPEC_FIELDS.includes(key))) {
    throw new Error("Unknown window configuration field.");
  }
  const view = readViewId(spec.view, seen);
  const title = readTitle(spec.title);
  const home = readHome(spec.home, view, policy, developmentUrl);
  const size = readWindowSize(object(spec.window));
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
    view,
    title,
    home,
    ...definedEntries({
      visible: spec.visible,
      showWhenReady: spec.showWhenReady,
    }),
    window: size,
    ...definedEntries({
      startup: spec.startup,
    }),
  };
}

/** Requires a well-formed view ID that no earlier window declared. */
function readViewId(view: unknown, seen: Set<string>): string {
  if (
    typeof view !== "string" ||
    !/^[A-Za-z0-9_.:-]{1,128}$(?![\s\S])/.test(view)
  ) {
    throw new Error(
      "Window view IDs must contain 1 to 128 ASCII letters, digits, underscores, dots, colons or hyphens.",
    );
  }
  if (seen.has(view)) {
    throw new Error(
      `Only one window declaration per view is supported (duplicate: ${view}).`,
    );
  }
  seen.add(view);
  return view;
}

const MAX_TITLE_LENGTH = 1024;

function readTitle(title: unknown): string {
  if (
    typeof title !== "string" ||
    !title ||
    title.length > MAX_TITLE_LENGTH ||
    title.includes("\0")
  ) {
    throw new Error(
      `Window title must contain 1 to ${MAX_TITLE_LENGTH} characters without NUL.`,
    );
  }
  return title;
}

/** Requires the home URL to sit on the app origin and that origin to be permitted for the view. */
function readHome(
  home: unknown,
  view: string,
  policy: Policy,
  developmentUrl: string | undefined,
): string {
  if (typeof home !== "string") {
    throw new Error("Window home must be a URL.");
  }
  const url = new URL(home);
  const origin = developmentUrl
    ? new URL(developmentUrl).origin
    : "https://app.bunaway.local";
  if (url.origin !== origin || url.username || url.password || url.hash) {
    throw new Error(
      "Window home must use the allowed app origin without credentials or a fragment.",
    );
  }
  if (
    !policy.views.find((entry) => entry.id === view)?.origins.includes(origin)
  ) {
    throw new Error(
      "Window view and home origin must be permitted by policy.json.",
    );
  }
  return home;
}

/** Validates the `window` object and returns it with only the fields the definition set. */
function readWindowSize(size: Record<string, unknown>): WindowSpec["window"] {
  if (Object.keys(size).some((key) => !SIZE_FIELDS.includes(key))) {
    throw new Error("Unknown window size field.");
  }
  if (!hasValidWindowPlacement(size)) {
    throw new Error(
      "Window placement requires paired integer x/y, boolean options and no center/position conflict.",
    );
  }
  const titlebar = size.titlebar;
  if (
    titlebar !== undefined &&
    titlebar !== "system" &&
    titlebar !== "custom"
  ) {
    throw new Error("Window titlebar must be system or custom.");
  }
  const focusable = size.focusable;
  if (focusable !== undefined && typeof focusable !== "boolean") {
    throw new Error("Window focusable must be a boolean.");
  }
  const initialState = readInitialState(size);
  const backgroundColor = readBackgroundColor(size.backgroundColor);
  const accentColor = readAccentColor(size.accentColor);
  const transparent = size.transparent;
  if (transparent !== undefined && typeof transparent !== "boolean") {
    throw new Error("Window transparent must be a boolean.");
  }
  const transparentError = transparentWindowError({
    transparent,
    titlebar,
    backgroundColor,
  });
  if (transparentError !== undefined) {
    throw new Error(transparentError);
  }
  // The path rules run at startup so a bad declaration fails before any window exists; the file
  // itself is read when the window is created.
  const icon =
    size.icon === undefined
      ? undefined
      : validateResourceIconPath(size.icon, "window.icon");
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
  return {
    ...definedEntries({
      focusable,
    }),
    ...initialState,
    ...definedEntries({
      backgroundColor,
      accentColor,
      transparent,
      icon,
      titlebar,
      x: size.x,
      y: size.y,
      center: size.center,
      useContentSize: size.useContentSize,
      preventOverflow: size.preventOverflow,
    }),
    width: Number(size.width),
    height: Number(size.height),
    ...definedEntries({
      minWidth,
      minHeight,
      maxWidth,
      maxHeight,
    }),
  };
}

/** Normalizes an optional `#RGB` or `#RRGGBB` background color to `#rrggbb`. */
function readBackgroundColor(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const color = normalizeWindowBackgroundColor(value);
  if (color === undefined) {
    throw new Error("Window backgroundColor must be #RGB or #RRGGBB.");
  }
  return color;
}

/** Normalizes an optional `#RGB` or `#RRGGBB` accent color to `#rrggbb`. */
function readAccentColor(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const color = normalizeWindowBackgroundColor(value);
  if (color === undefined) {
    throw new Error("Window accentColor must be #RGB or #RRGGBB.");
  }
  return color;
}

/** Collects the boolean initial-state options that are present, rejecting any other type. */
function readInitialState(size: Record<string, unknown>): InitialState {
  const initialState: InitialState = {};
  for (const name of INITIAL_STATE_OPTIONS) {
    const option = size[name];
    if (option === undefined) {
      continue;
    }
    if (typeof option !== "boolean") {
      throw new Error(`Window ${name} must be a boolean.`);
    }
    initialState[name] = option;
  }
  return initialState;
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
