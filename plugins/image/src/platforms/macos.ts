import { ImagePlatform } from "#image/platforms/image-platform";
import { createImageIO } from "#image/platforms/macos-codec";
export function initialize(): ImagePlatform {
  return new ImagePlatform(createImageIO());
}

export function dispose(instance: ImagePlatform): void {
  instance.dispose();
}
