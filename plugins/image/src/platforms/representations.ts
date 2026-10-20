import type { Pixels } from "#image/platforms/codec";

/** Whether `scaled` is the floor or ceil of the base size times `scaleFactor`, as asset tools round differently. */
export function matchesLogicalSize(
  base: number,
  scaled: number,
  scaleFactor: number,
): boolean {
  const exact = base * scaleFactor;
  return scaled === Math.floor(exact) || scaled === Math.ceil(exact);
}

/**
 * Pick the representation for a requested scale factor: the exact one, else the smallest larger one
 * (downscaling stays sharper than upscaling), else the largest. Pixels are never resampled.
 */
export function selectRepresentation(
  base: Pixels,
  reps: ReadonlyMap<number, Pixels>,
  requested: number,
): {
  scaleFactor: number;
  pixels: Pixels;
} {
  const all = new Map(reps).set(1, base);
  const exact = all.get(requested);
  if (exact) {
    return {
      scaleFactor: requested,
      pixels: exact,
    };
  }
  const factors = [
    ...all.keys(),
  ].sort((a, b) => a - b);
  const chosen =
    factors.find((factor) => factor > requested) ?? factors[factors.length - 1];
  return {
    scaleFactor: chosen ?? 1,
    pixels: all.get(chosen ?? 1) ?? base,
  };
}
