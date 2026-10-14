import { ImagePlatform } from "#image/platforms/image-platform";
import { createWIC } from "#image/platforms/windows-codec";
export function initialize(): ImagePlatform {
  return new ImagePlatform(createWIC());
}

export function dispose(instance: ImagePlatform): void {
  instance.dispose();
}
