import { BunawayError } from "@bunaway/protocol";
import {
  MAX_IMAGE_BYTES,
  MAX_POOL_BYTES,
  MAX_RESOURCES,
  type Pixels,
} from "#image/contract";

type Resource = {
  pixels: Pixels;
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
      pixels.width > 4096 ||
      pixels.height < 0 ||
      pixels.height > 4096 ||
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
      detach: () => signal?.removeEventListener("abort", cancelled),
    });
    this.bytes += pixels.rgba.length;
    return {
      id,
      ...this.info(id),
    };
  }
  get(id: string): Pixels {
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
    return resource.pixels;
  }
  info(id: string) {
    const pixels = this.get(id);
    return {
      width: pixels.width,
      height: pixels.height,
      empty: pixels.width === 0,
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
