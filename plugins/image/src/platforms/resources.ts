import { BunawayError } from "@bunaway/protocol";
import {
  MAX_IMAGE_BYTES,
  MAX_IMAGE_DIMENSION,
  MAX_POOL_BYTES,
  MAX_REPRESENTATIONS,
  MAX_RESOURCES,
} from "#image/contract";
import type { Pixels } from "#image/platforms/codec";
import {
  matchesLogicalSize,
  selectRepresentation,
} from "#image/platforms/representations";

type Resource = {
  pixels: Pixels;
  /** Extra pixel buffers by scale factor; `pixels` is the scale factor 1 base. */
  reps: Map<number, Pixels>;
  detach(): void;
};
/** Own immutable pixel buffers and creation-cancellation hooks for one app adapter lifetime. */
export class ImageResources {
  private readonly resources = new Map<string, Resource>();
  private bytes = 0;
  private closed = false;

  /** Check resource count before decoding; byte quota is checked again before committing pixels. */
  assertCapacity(): void {
    if (this.closed) {
      throw new BunawayError({
        code: "CANCELLED",
        message: "Image adapter is closed.",
      });
    }
    if (this.resources.size >= MAX_RESOURCES || this.bytes >= MAX_POOL_BYTES) {
      throw new BunawayError({
        code: "BUSY",
        message: "Image resource limit reached. Dispose unused images.",
      });
    }
  }
  /** Take ownership of a detached buffer. Cancellation of the pending host operation discards the allocation. */
  create(pixels: Pixels, signal?: AbortSignal) {
    this.assertCapacity();
    if (signal?.aborted) {
      throw new BunawayError({
        code: "CANCELLED",
        message: "Image creation cancelled.",
      });
    }
    if (
      !Number.isInteger(pixels.width) ||
      !Number.isInteger(pixels.height) ||
      pixels.width < 0 ||
      pixels.width > MAX_IMAGE_DIMENSION ||
      pixels.height < 0 ||
      pixels.height > MAX_IMAGE_DIMENSION ||
      (pixels.width === 0) !== (pixels.height === 0) ||
      pixels.rgba.length !== pixels.width * pixels.height * 4 ||
      pixels.rgba.length > MAX_IMAGE_BYTES
    ) {
      throw new BunawayError({
        code: "INVALID_ARGUMENT",
        message: "Image dimensions exceed the pixel limit.",
      });
    }
    if (this.bytes + pixels.rgba.length > MAX_POOL_BYTES) {
      throw new BunawayError({
        code: "BUSY",
        message: "Image memory limit reached. Dispose unused images.",
      });
    }
    const id = crypto.randomUUID();
    const cancelled = () => {
      this.remove(id);
    };
    signal?.addEventListener("abort", cancelled, {
      once: true,
    });
    this.resources.set(id, {
      pixels,
      reps: new Map(),
      detach: () => signal?.removeEventListener("abort", cancelled),
    });
    this.bytes += pixels.rgba.length;
    return {
      id,
      ...this.info(id),
    };
  }
  /** Pixels of the representation chosen for a scale factor (default 1), with the factor actually used. */
  select(id: string, scaleFactor = 1) {
    const resource = this.resource(id);
    return selectRepresentation(resource.pixels, resource.reps, scaleFactor);
  }
  /** Attach a copy-free reference to `source` pixels as the `scaleFactor` representation of `id`. */
  addRepresentation(id: string, scaleFactor: number, source: string) {
    const resource = this.resource(id);
    const pixels = this.resource(source).pixels;
    const base = resource.pixels;
    if (
      id === source ||
      base.width === 0 ||
      pixels.width === 0 ||
      !matchesLogicalSize(base.width, pixels.width, scaleFactor) ||
      !matchesLogicalSize(base.height, pixels.height, scaleFactor)
    ) {
      throw new BunawayError({
        code: "INVALID_ARGUMENT",
        message:
          "Representation size must equal the base size times the scale factor.",
      });
    }
    const replaced = resource.reps.get(scaleFactor);
    if (!replaced && resource.reps.size >= MAX_REPRESENTATIONS) {
      throw new BunawayError({
        code: "BUSY",
        message: "Image representation limit reached.",
      });
    }
    const delta = pixels.rgba.length - (replaced?.rgba.length ?? 0);
    if (this.bytes + delta > MAX_POOL_BYTES) {
      throw new BunawayError({
        code: "BUSY",
        message: "Image memory limit reached. Dispose unused images.",
      });
    }
    resource.reps.set(scaleFactor, pixels);
    this.bytes += delta;
    return this.representations(id);
  }
  /** Scale factors with pixel sizes in ascending order, always including the base. */
  representations(id: string) {
    const resource = this.resource(id);
    if (resource.pixels.width === 0) {
      return [];
    }
    return [
      [
        1,
        resource.pixels,
      ] as const,
      ...resource.reps,
    ]
      .sort(([a], [b]) => a - b)
      .map(([scaleFactor, pixels]) => ({
        scaleFactor,
        width: pixels.width,
        height: pixels.height,
      }));
  }
  get(id: string): Pixels {
    return this.resource(id).pixels;
  }
  private resource(id: string): Resource {
    if (this.closed) {
      throw new BunawayError({
        code: "CANCELLED",
        message: "Image adapter is closed.",
      });
    }
    const resource = this.resources.get(id);
    if (!resource) {
      throw new BunawayError({
        code: "INVALID_ARGUMENT",
        message: "Image resource does not exist or was disposed.",
      });
    }
    return resource;
  }
  info(id: string) {
    const pixels = this.get(id);
    return {
      width: pixels.width,
      height: pixels.height,
      empty: pixels.width === 0,
    };
  }
  /** Info of the representation chosen for a scale factor, with the factor actually used. */
  selectedInfo(id: string, scaleFactor?: number) {
    const { scaleFactor: chosen, pixels } = this.select(id, scaleFactor);
    return {
      width: pixels.width,
      height: pixels.height,
      empty: pixels.width === 0,
      scaleFactor: chosen,
    };
  }
  /** Idempotently remove one resource and its retained creation signal. */
  remove(id: string): boolean {
    const resource = this.resources.get(id);
    if (!resource) {
      return false;
    }
    resource.detach();
    this.bytes -= resource.pixels.rgba.length;
    for (const rep of resource.reps.values()) {
      this.bytes -= rep.rgba.length;
    }
    return this.resources.delete(id);
  }
  /** Discard all pixel buffers on app shutdown or failed adapter initialization. */
  dispose(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const id of this.resources.keys()) {
      this.remove(id);
    }
  }
}
