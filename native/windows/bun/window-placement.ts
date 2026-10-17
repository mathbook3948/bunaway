import {
  clampWindowSize,
  MAX_WINDOW_COORDINATE,
  MIN_WINDOW_COORDINATE,
  type WindowSpec,
} from "@bunaway/plugin-api/native";
import { BunawayError } from "@bunaway/protocol";
import { logicalPixels, physicalPixels } from "./window-size.ts";

export type WorkArea = {
  x: number;
  y: number;
  width: number;
  height: number;
};

function invalidPlacement(message: string): never {
  throw new BunawayError({
    code: "INVALID_ARGUMENT",
    message,
  });
}

/** Center a physical outer rectangle in a monitor work area, including negative screen origins. */
export function centerInWorkArea(
  area: WorkArea,
  width: number,
  height: number,
) {
  return {
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
  };
}

/**
 * Find the work area of the connected monitor whose public ID matches exactly.
 * An unknown ID is INVALID_ARGUMENT; there is deliberately no primary-monitor fallback.
 */
export function selectMonitorWorkArea(
  monitors: readonly {
    id: string;
    workArea: WorkArea;
  }[],
  monitorId: string,
): WorkArea {
  const monitor = monitors.find((candidate) => candidate.id === monitorId);
  if (!monitor) {
    return invalidPlacement("Monitor is not connected.");
  }
  return monitor.workArea;
}

/** Resolve logical content constraints before physical outer fitting; does not own native resources. */
export function initialWindowPlacement(
  options: WindowSpec["window"],
  dpi: number,
  frame: {
    width: number;
    height: number;
  },
  area: WorkArea,
) {
  const constraints = {
    minWidth: options.minWidth ?? null,
    minHeight: options.minHeight ?? null,
    maxWidth: options.maxWidth ?? null,
    maxHeight: options.maxHeight ?? null,
  };
  const requested =
    options.useContentSize === false
      ? {
          width: logicalPixels(
            physicalPixels(options.width, dpi) - frame.width,
            dpi,
          ),
          height: logicalPixels(
            physicalPixels(options.height, dpi) - frame.height,
            dpi,
          ),
        }
      : options;
  const content = clampWindowSize(
    requested.width,
    requested.height,
    constraints,
  );
  if (options.preventOverflow) {
    function fitContent(
      requested: number,
      available: number,
      minimum: number | null,
    ) {
      let capacity = logicalPixels(available, dpi);
      // Inverse rounding must never put even one physical pixel outside rcWork.
      if (physicalPixels(capacity, dpi) > available) {
        capacity--;
      }
      if (capacity < (minimum ?? 1)) {
        invalidPlacement(
          "Window minimum content size cannot fit in the monitor work area.",
        );
      }
      return Math.min(requested, capacity);
    }
    content.width = fitContent(
      content.width,
      area.width - frame.width,
      constraints.minWidth,
    );
    content.height = fitContent(
      content.height,
      area.height - frame.height,
      constraints.minHeight,
    );
  }
  if (content.width < 1 || content.height < 1) {
    invalidPlacement("Initial outer size must leave a positive content area.");
  }
  const outer = {
    width: physicalPixels(content.width, dpi) + frame.width,
    height: physicalPixels(content.height, dpi) + frame.height,
  };
  let position =
    options.x != null && options.y != null
      ? {
          x: options.x,
          y: options.y,
        }
      : undefined;
  if (options.center) {
    position = centerInWorkArea(area, outer.width, outer.height);
  }
  if (options.preventOverflow) {
    position ??= {
      x: area.x,
      y: area.y,
    };
    position = {
      x: Math.max(
        area.x,
        Math.min(position.x, area.x + area.width - outer.width),
      ),
      y: Math.max(
        area.y,
        Math.min(position.y, area.y + area.height - outer.height),
      ),
    };
  }
  if (
    position &&
    [
      position.x,
      position.y,
      position.x + outer.width,
      position.y + outer.height,
    ].some(
      (value) => value < MIN_WINDOW_COORDINATE || value > MAX_WINDOW_COORDINATE,
    )
  ) {
    invalidPlacement(
      "Initial window rectangle exceeds the supported screen coordinate range.",
    );
  }
  return {
    content,
    outer,
    position,
  };
}
