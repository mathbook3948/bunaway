import { BunawayError } from "@bunaway/protocol";
import {
  MAX_WINDOW_COORDINATE,
  MIN_WINDOW_COORDINATE,
  type WindowAnchor,
  type WindowInput,
  type WindowRectAlignment,
  type WindowRectPlacement,
} from "#windows/contract";

const LOGICAL_DPI = 96;
type GeometryValue = WindowInput<"windows.toPhysical">["value"];

/** Scale each component about screen (0, 0), rounding ties toward positive infinity. */
export function convertGeometry(
  value: GeometryValue,
  dpi: number,
  unit: "logical" | "physical",
): GeometryValue {
  function convert(component: number, minimum: number) {
    const scaled =
      unit === "physical"
        ? (component * dpi) / LOGICAL_DPI
        : (component * LOGICAL_DPI) / dpi;
    const rounded = Math.round(scaled);
    const result = rounded === 0 ? 0 : rounded;
    if (
      !Number.isFinite(result) ||
      result < minimum ||
      result > MAX_WINDOW_COORDINATE
    ) {
      throw new BunawayError({
        code: "INVALID_ARGUMENT",
        message:
          "Converted window geometry exceeds the supported integer range.",
      });
    }
    return result;
  }
  const position =
    "x" in value
      ? {
          x: convert(value.x, MIN_WINDOW_COORDINATE),
          y: convert(value.y, MIN_WINDOW_COORDINATE),
        }
      : undefined;
  const size =
    "width" in value
      ? {
          width: convert(value.width, 0),
          height: convert(value.height, 0),
        }
      : undefined;
  if (position && size) {
    return {
      ...position,
      ...size,
    };
  }
  if (position) {
    return position;
  }
  if (size) {
    return size;
  }
  throw new BunawayError({
    code: "INVALID_ARGUMENT",
    message: "Expected window geometry.",
  });
}

type AxisSide = "near" | "middle" | "far";
type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/**
 * Place one axis of an outer rectangle in a work-area span. `near` and `far` anchor to the start or
 * end edge inset by `margin`; any other value, or a window that does not fit inside the inset span,
 * is centered, which is how `windows.center` treats a window larger than the work area.
 */
function anchorAxis(
  start: number,
  span: number,
  size: number,
  side: AxisSide,
  margin: number,
): number {
  if (side === "middle" || size + 2 * margin > span) {
    return Math.round(start + (span - size) / 2);
  }
  return side === "near" ? start + margin : start + span - size - margin;
}

/** Horizontal and vertical side of each anchor. */
const ANCHOR_SIDES: Record<
  WindowAnchor,
  {
    column: AxisSide;
    row: AxisSide;
  }
> = {
  "top-left": {
    column: "near",
    row: "near",
  },
  top: {
    column: "middle",
    row: "near",
  },
  "top-right": {
    column: "far",
    row: "near",
  },
  left: {
    column: "near",
    row: "middle",
  },
  center: {
    column: "middle",
    row: "middle",
  },
  right: {
    column: "far",
    row: "middle",
  },
  "bottom-left": {
    column: "near",
    row: "far",
  },
  bottom: {
    column: "middle",
    row: "far",
  },
  "bottom-right": {
    column: "far",
    row: "far",
  },
};

/** Physical outer top-left that puts a window of `size` at `anchor` in `area`, `margin` physical pixels from the edges. */
export function anchorPosition(
  area: Rect,
  size: {
    width: number;
    height: number;
  },
  anchor: WindowAnchor,
  margin: number,
): {
  x: number;
  y: number;
} {
  const { column, row } = ANCHOR_SIDES[anchor];
  return {
    x: anchorAxis(area.x, area.width, size.width, column, margin),
    y: anchorAxis(area.y, area.height, size.height, row, margin),
  };
}

/** Keep an outer span inside a work-area span; a window larger than the span is centered like `windows.center`. */
function clampAxis(
  start: number,
  span: number,
  size: number,
  position: number,
): number {
  if (size > span) {
    return Math.round(start + (span - size) / 2);
  }
  return Math.min(Math.max(position, start), start + span - size);
}

/** Position along the axis parallel to the reference side of `target`. */
function alignAxis(
  start: number,
  span: number,
  size: number,
  align: WindowRectAlignment,
): number {
  if (align === "start") {
    return start;
  }
  return align === "end"
    ? start + span - size
    : Math.round(start + (span - size) / 2);
}

/**
 * Physical outer top-left that puts a window of `size` on the `placement` side of `target`,
 * `margin` physical pixels away and aligned along that side, then clamps it into `area`. The side
 * is never flipped: with too little room the window slides along the work area instead.
 */
export function rectPlacementPosition(
  area: Rect,
  size: {
    width: number;
    height: number;
  },
  target: Rect,
  placement: WindowRectPlacement,
  align: WindowRectAlignment,
  margin: number,
): {
  x: number;
  y: number;
} {
  let x = alignAxis(target.x, target.width, size.width, align);
  let y = alignAxis(target.y, target.height, size.height, align);
  if (placement === "above") {
    y = target.y - margin - size.height;
  } else if (placement === "below") {
    y = target.y + target.height + margin;
  } else if (placement === "left") {
    x = target.x - margin - size.width;
  } else {
    x = target.x + target.width + margin;
  }
  return {
    x: clampAxis(area.x, area.width, size.width, x),
    y: clampAxis(area.y, area.height, size.height, y),
  };
}
