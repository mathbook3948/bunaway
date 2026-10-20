import type {
  WindowResizeDirection,
  WindowSizeConstraints,
} from "@bunaway/plugin-api/native";
import { BunawayError } from "@bunaway/protocol";

/** Non-client left button press; DefWindowProc turns it into the system move or size loop. */
export const WM_NCLBUTTONDOWN = 0x00a1;

/** Hit-test codes that select the loop: a caption press moves, an edge press sizes from that edge. */
export const HTCAPTION = 2;
export const HIT_TEST: Record<WindowResizeDirection, number> = {
  west: 10,
  east: 11,
  north: 12,
  northWest: 13,
  northEast: 14,
  south: 15,
  southWest: 16,
  southEast: 17,
};

const HORIZONTAL = new Set<WindowResizeDirection>([
  "west",
  "east",
  "northWest",
  "northEast",
  "southWest",
  "southEast",
]);
const VERTICAL = new Set<WindowResizeDirection>([
  "north",
  "south",
  "northWest",
  "northEast",
  "southWest",
  "southEast",
]);

/** A drag request the current window or input state cannot satisfy; same code as other state rejections. */
export const dragRejected = (message: string) =>
  new BunawayError({
    code: "INVALID_ARGUMENT",
    message,
  });

const fixed = (min: number | null, max: number | null) =>
  min !== null && max !== null && min === max;

/** True when every axis the direction would change is pinned by equal minimum and maximum sizes. */
export function resizeIsPinned(
  direction: WindowResizeDirection,
  limits: WindowSizeConstraints,
): boolean {
  const widthFixed = fixed(limits.minWidth, limits.maxWidth);
  const heightFixed = fixed(limits.minHeight, limits.maxHeight);
  return (
    (!HORIZONTAL.has(direction) || widthFixed) &&
    (!VERTICAL.has(direction) || heightFixed)
  );
}

/** Pack a screen point into a WM_NCLBUTTONDOWN lParam: signed 16-bit x in the low word, y in the high word. */
export function screenPointParam(x: number, y: number): bigint {
  return BigInt((((y & 0xffff) << 16) | (x & 0xffff)) >>> 0);
}
