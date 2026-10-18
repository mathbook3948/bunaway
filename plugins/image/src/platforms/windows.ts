import { ImagePlatform } from "#image/platforms/image-platform";
import { createWIC } from "#image/platforms/windows-codec";
import { createFileTypeIconSource } from "#image/platforms/windows-file-icon";
export function initialize(): ImagePlatform {
  const codec = createWIC();
  try {
    return new ImagePlatform(codec, createFileTypeIconSource());
  } catch (error) {
    codec.dispose();
    throw error;
  }
}

export function dispose(instance: ImagePlatform): void {
  instance.dispose();
}
