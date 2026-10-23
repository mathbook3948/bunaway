import { ImagePlatform } from "#image/platforms/image-platform";
import { createImageIO } from "#image/platforms/macos-codec";
import { createFileTypeIconSource } from "#image/platforms/macos-file-icon";
export function initialize(): ImagePlatform {
  const codec = createImageIO();
  try {
    return new ImagePlatform(codec, createFileTypeIconSource(codec));
  } catch (error) {
    codec.dispose();
    throw error;
  }
}

export function dispose(instance: ImagePlatform): void {
  instance.dispose();
}
