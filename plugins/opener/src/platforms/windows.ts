import { dlopen } from "bun:ffi";
import { ResourceOwner } from "@bunaway/plugin";
import { COINIT_APARTMENTTHREADED, OLE32, pick } from "@bunaway/plugin/win32";
import { BunawayError } from "@bunaway/protocol";
import type { UrlHandler } from "#opener/contract";
import { createFiles } from "#opener/platforms/windows-file";
import { createUrlHandlerQuery } from "#opener/platforms/windows-handler";
import {
  normalizeApplicationPath,
  normalizeFilePath,
} from "#opener/platforms/windows-path";
import { createRecentDocuments } from "#opener/platforms/windows-recent";
import { createShell } from "#opener/platforms/windows-shell";
import {
  trashWindowsFile,
  validateTrashDrive,
} from "#opener/platforms/windows-trash";
import { normalizeUrl } from "#opener/url";

/**
 * Own one balanced COM initialization on the adapter's I/O thread. The process may
 * already hold a multithreaded apartment (for example after SHAddToRecentDocs), which
 * makes threads without initialization implicit MTA members; an explicit STA
 * initialization still succeeds there and is the only one released on dispose.
 */
function createApartment() {
  const ole = dlopen("ole32.dll", {
    ...pick(OLE32, "CoInitializeEx", "CoUninitialize"),
  });
  if (ole.symbols.CoInitializeEx(null, COINIT_APARTMENTTHREADED) < 0) {
    ole.close();
    throw new BunawayError({
      code: "INTERNAL",
      message: "Opener could not initialize its COM apartment.",
    });
  }
  return {
    dispose() {
      ole.symbols.CoUninitialize();
      ole.close();
    },
  };
}

/**
 * Prepare the STA and retain each resource until all shell references are released.
 * The owner releases them in reverse order, on a failed later step as well as on dispose.
 */
export function initialize() {
  const owner = new ResourceOwner("Opener cleanup failed.");
  owner.acquire(createApartment, (apartment) => apartment.dispose());
  const shell = owner.acquire(createShell, (resource) => resource.dispose());
  const files = owner.acquire(createFiles, (resource) => resource.dispose());
  const recent = owner.acquire(createRecentDocuments, (resource) =>
    resource.dispose(),
  );
  const handlers = owner.acquire(createUrlHandlerQuery, (resource) =>
    resource.dispose(),
  );
  return {
    owner,
    shell,
    files,
    recent,
    handlers,
  };
}

type State = ReturnType<typeof initialize>;

function active(state: State): void {
  if (state.owner.disposed) {
    throw new BunawayError({
      code: "CANCELLED",
      message: "Opener has been disposed.",
    });
  }
}

export function openUrl(state: State, url: string): null {
  active(state);
  state.shell.open(normalizeUrl(url));
  return null;
}

/**
 * Look up the application registered for the URL scheme without starting it. The call is
 * synchronous and not interruptible, so cancellation is checked only before it starts.
 */
export function getUrlHandler(
  state: State,
  url: string,
  signal?: AbortSignal,
): UrlHandler | null {
  active(state);
  notCancelled(signal);
  const scheme = new URL(normalizeUrl(url)).protocol.slice(0, -1);
  return state.handlers.query(scheme);
}

export function openFile(state: State, path: string): null {
  active(state);
  const selected = normalizeFilePath(path);
  state.files.withFile(selected, () => state.shell.open(selected));
  return null;
}

export function revealFile(state: State, path: string): null {
  active(state);
  const selected = normalizeFilePath(path);
  state.files.withFile(selected, () => state.shell.reveal(selected));
  return null;
}

export function trashFile(state: State, path: string): null {
  active(state);
  const selected = normalizeFilePath(path);
  validateTrashDrive(selected);
  state.files.withTrashFile(selected, (verifyIdentity) =>
    trashWindowsFile(selected, verifyIdentity),
  );
  return null;
}

/** The call is synchronous and not interruptible, so cancellation is checked only before it starts. */
function notCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new BunawayError({
      code: "CANCELLED",
      message: "Recent Items request cancelled.",
    });
  }
}

/** Add an existing file to the user's Shell Recent Items. */
export function addRecentDocument(
  state: State,
  path: string,
  signal?: AbortSignal,
): null {
  active(state);
  notCancelled(signal);
  const selected = normalizeFilePath(path);
  // The pin lasts until SHAddToRecentDocs returns; the Shell reads the file after that.
  state.files.withFile(selected, () => state.recent.request(selected));
  return null;
}

/** Clear the user's entire Shell Recent Items list, not only entries this app added. */
export function clearRecentDocuments(state: State, signal?: AbortSignal): null {
  active(state);
  notCancelled(signal);
  state.recent.request(null);
  return null;
}

export function openFileWith(
  state: State,
  path: string,
  application: string,
): null {
  active(state);
  const app = normalizeApplicationPath(application);
  state.files.withFile(app, () => {
    const selected = normalizeFilePath(path);
    state.files.withFile(selected, () => state.shell.open(app, selected));
  });
  return null;
}

export function openUrlWith(
  state: State,
  url: string,
  application: string,
): null {
  active(state);
  const app = normalizeApplicationPath(application);
  state.files.withFile(app, () => state.shell.open(app, normalizeUrl(url)));
  return null;
}

export function dispose(state: State): void {
  state.owner.dispose();
}
