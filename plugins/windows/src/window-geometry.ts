import { BunawayError } from "@bunaway/protocol";
import {
  MAX_WINDOW_COORDINATE,
  MIN_WINDOW_COORDINATE,
  type WindowInput,
} from "./contract.ts";

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
