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
import { isRecord } from "@bunaway/protocol";

export { MAX_WINDOWS, type WindowSpec } from "@bunaway/plugin-api/native";

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
  "instances",
  "maxInstances",
  "profile",
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
  const { instances, maxInstances } = readInstances(spec);
  if (
    spec.profile !== undefined &&
    spec.profile !== "shared" &&
    spec.profile !== "isolated"
  ) {
    throw new Error("Window profile must be shared or isolated.");
  }
  return {
    view,
    title,
    ...definedEntries({
      instances,
      maxInstances,
      profile: spec.profile,
    }),
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
      `Only one window declaration per view is supported (duplicate: ${view}). Declare instances: multiple to create multiple windows.`,
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

/** Validates `instances` and `maxInstances`: multiple needs a bounded count, single permits only 1. */
function readInstances(spec: Record<string, unknown>): {
  instances: WindowSpec["instances"];
  maxInstances: number | undefined;
} {
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
  return {
    instances: spec.instances,
    maxInstances:
      spec.maxInstances === undefined ? undefined : Number(spec.maxInstances),
  };
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
