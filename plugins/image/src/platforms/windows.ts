import { ImagePlatform } from "../image-platform.ts";
import { createWIC } from "../wic.ts";

export function initialize(): ImagePlatform {
  return new ImagePlatform(createWIC());
}

export function dispose(instance: ImagePlatform): void {
  instance.dispose();
}
