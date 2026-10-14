import { win32 } from "node:path";
import type { UserDirectory } from "#path/contract";
import { WindowsKnownFolders } from "#path/platforms/windows-known-folders";
/** Windows path semantics never inherit the I/O Worker's current working directory. */
export class WindowsPath {
  private folders: WindowsKnownFolders | undefined;

  getDirectory(directory: UserDirectory): string {
    this.folders ??= new WindowsKnownFolders();
    return this.folders.get(directory);
  }

  join(paths: string[]): string {
    return win32.join(...paths);
  }

  resolve(base: string, paths: string[]): string {
    return win32.resolve(base, ...paths);
  }

  normalize(path: string): string {
    return win32.normalize(path);
  }

  basename(path: string, suffix?: string): string {
    return win32.basename(path, suffix);
  }

  dirname(path: string): string {
    return win32.dirname(path);
  }

  extname(path: string): string {
    return win32.extname(path);
  }

  isAbsolute(path: string): boolean {
    return win32.isAbsolute(path);
  }

  dispose(): void {
    this.folders?.dispose();
    this.folders = undefined;
  }
}

export function initialize(): WindowsPath {
  return new WindowsPath();
}

export function dispose(instance: WindowsPath): void {
  instance.dispose();
}
