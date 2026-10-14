import { createImageIO } from "../image-io.ts";
import { ImagePlatform } from "../image-platform.ts";

export function initialize(): ImagePlatform {
  return new ImagePlatform(createImageIO());
}

export function dispose(instance: ImagePlatform): void {
  instance.dispose();
}
