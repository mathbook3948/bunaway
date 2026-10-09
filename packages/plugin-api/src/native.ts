export const MIN_WINDOW_DIMENSION = 200;
export const MAX_WINDOW_DIMENSION = 4096;

export type WindowSizeConstraints = {
  minWidth: number | null;
  minHeight: number | null;
  maxWidth: number | null;
  maxHeight: number | null;
};

export function isWindowSizeDimension(value: unknown): value is number | null {
  return (
    value === null ||
    (typeof value === "number" &&
      Number.isInteger(value) &&
      value >= MIN_WINDOW_DIMENSION &&
      value <= MAX_WINDOW_DIMENSION)
  );
}

export function hasValidWindowSizeConstraints(
  constraints: WindowSizeConstraints,
): boolean {
  return (
    isWindowSizeDimension(constraints.minWidth) &&
    isWindowSizeDimension(constraints.minHeight) &&
    isWindowSizeDimension(constraints.maxWidth) &&
    isWindowSizeDimension(constraints.maxHeight) &&
    (constraints.minWidth === null ||
      constraints.maxWidth === null ||
      constraints.minWidth <= constraints.maxWidth) &&
    (constraints.minHeight === null ||
      constraints.maxHeight === null ||
      constraints.minHeight <= constraints.maxHeight)
  );
}

export function clampWindowSize(
  width: number,
  height: number,
  constraints: WindowSizeConstraints,
): {
  width: number;
  height: number;
} {
  return {
    width: Math.max(
      constraints.minWidth ?? Number.NEGATIVE_INFINITY,
      Math.min(constraints.maxWidth ?? Number.POSITIVE_INFINITY, width),
    ),
    height: Math.max(
      constraints.minHeight ?? Number.NEGATIVE_INFINITY,
      Math.min(constraints.maxHeight ?? Number.POSITIVE_INFINITY, height),
    ),
  };
}

export type WindowSpec = {
  view: string;
  home: string;
  title: string;
  window: {
    width: number;
    height: number;
    minWidth?: number | null;
    minHeight?: number | null;
    maxWidth?: number | null;
    maxHeight?: number | null;
  };
  startup?: boolean;
};
export type WindowState = {
  closed: boolean;
  cleaned: boolean;
  ready: boolean;
  failure: unknown;
  deadline: number;
};
export type NativeWindow = {
  show(visible: boolean): void;
  focus(): boolean;
  close(): boolean | Promise<boolean>;
  isFullscreen(): boolean;
  getSizeConstraints(): WindowSizeConstraints;
  setSizeConstraints(constraints: WindowSizeConstraints): void;
  setSize(width: number, height: number): void;
  setPosition(x: number, y: number): void;
  setFullscreen(value: boolean): void;
  setCloseConfirmation(message: string | null): void;
};
export type NativeWindowServices = {
  specs: readonly WindowSpec[];
  read(view: string): WindowState | undefined;
  create(spec: WindowSpec): void;
  close(view: string): boolean | Promise<boolean>;
  window(view: string): NativeWindow;
  stopping(): boolean;
  cancelled(requestId: string): boolean;
  now(): number;
  tick(): Promise<void>;
};
