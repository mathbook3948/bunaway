import { ResourceOwner } from "@bunaway/plugin";
import { WindowsScreenCapture } from "#screen-capture/platforms/windows-capture";
import {
  captureBindings,
  openCaptureLibraries,
} from "#screen-capture/platforms/windows-capture-bindings";

/** Open user32, gdi32 and dwmapi on the host I/O worker; the adapter closes them when it is disposed. */
export function initialize(): WindowsScreenCapture {
  const libraries = openCaptureLibraries();
  const owner = new ResourceOwner("Screen capture libraries");
  owner.acquire(
    () => libraries.user32,
    (library) => library.close(),
  );
  owner.acquire(
    () => libraries.gdi32,
    (library) => library.close(),
  );
  owner.acquire(
    () => libraries.dwmapi,
    (library) => library.close(),
  );
  return new WindowsScreenCapture(captureBindings(libraries), process.pid, () =>
    owner.dispose(),
  );
}

export function dispose(adapter: WindowsScreenCapture): void {
  adapter.dispose();
}
