import { dlopen } from "bun:ffi";
import { type NativeEnvironment, ResourceOwner } from "@bunaway/plugin";
import { COINIT_APARTMENTTHREADED, OLE32, pick } from "@bunaway/plugin/win32";
import { BunawayError, isRecord } from "@bunaway/protocol";
import {
  DEFAULT_FILE_ICON_SIZE,
  type FileIcon,
  type FileIconInput,
  type JumpListInput,
  type JumpListResult,
  type RemovedJumpListTask,
  type ShortcutDetails,
  type ShortcutLink,
  type ShortcutOperation,
  type UrlHandler,
} from "#opener/contract";
import {
  assertExistingFile,
  assertNameFree,
  assertParentDirectory,
  resolveReadableFile,
} from "#opener/platforms/file-check";
import { encodeRgbaPng } from "#opener/platforms/rgba-png";
import { createFileIcons } from "#opener/platforms/windows-file-icon";
import { createUrlHandlerQuery } from "#opener/platforms/windows-handler";
import { createJumpLists } from "#opener/platforms/windows-jump-list";
import {
  assertResolvedExtension,
  normalizeApplicationPath,
  normalizeFilePath,
  normalizeJumpList,
  normalizeShortcutDetails,
  normalizeShortcutPath,
} from "#opener/platforms/windows-path";
import { createRecentDocuments } from "#opener/platforms/windows-recent";
import { createSchemeStore } from "#opener/platforms/windows-scheme-registry";
import { createShell } from "#opener/platforms/windows-shell";
import { createShortcuts } from "#opener/platforms/windows-shortcut";
import {
  assertFitsRecycleBin,
  trashWindowsFile,
  validateTrashDrive,
} from "#opener/platforms/windows-trash";
import { createUrlSchemeRegistration } from "#opener/platforms/windows-url-scheme";
import { normalizeUrl } from "#opener/url";
import { normalizeUrlScheme } from "#opener/url-scheme";

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
export function initialize(environment?: NativeEnvironment) {
  const owner = new ResourceOwner("Opener cleanup failed.");
  owner.acquire(createApartment, (apartment) => apartment.dispose());
  const shell = owner.acquire(createShell, (resource) => resource.dispose());
  const recent = owner.acquire(createRecentDocuments, (resource) =>
    resource.dispose(),
  );
  const handlers = owner.acquire(createUrlHandlerQuery, (resource) =>
    resource.dispose(),
  );
  const fileIcons = owner.acquire(createFileIcons, (resource) =>
    resource.dispose(),
  );
  const shortcuts = owner.acquire(createShortcuts, (resource) =>
    resource.dispose(),
  );
  const schemeStore = owner.acquire(createSchemeStore, (resource) =>
    resource.dispose(),
  );
  // Without a host app identity the Jump List operations report UNSUPPORTED.
  const jumpLists = owner.acquire(
    () => createJumpLists(environment?.app),
    (resource) => resource.dispose(),
  );
  return {
    owner,
    shell,
    jumpLists,
    shortcuts,
    recent,
    handlers,
    fileIcons,
    // Without a host app identity the registration operations report UNSUPPORTED.
    urlSchemes: createUrlSchemeRegistration(environment?.app, schemeStore),
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

/**
 * Rasterize the Shell icon of an existing file or of an extension as a PNG. A path is resolved
 * through links to a readable file first, as `openFile` does, so a link's name cannot stand in
 * for its target; an extension never touches the file system. The Shell call is synchronous and
 * not interruptible, so cancellation is checked only before it starts. Thumbnails are never
 * requested.
 */
export function getFileIcon(
  state: State,
  input: FileIconInput,
  signal?: AbortSignal,
): FileIcon {
  active(state);
  notCancelled(signal);
  const size = input.size ?? DEFAULT_FILE_ICON_SIZE;
  const pixels = state.fileIcons.render(
    "path" in input
      ? {
          path: resolveReadableFile(normalizeFilePath(input.path)),
        }
      : {
          extension: input.extension,
        },
    size,
  );
  return {
    mime: "image/png",
    data: encodeRgbaPng(pixels.rgba, pixels.width, pixels.height).toString(
      "base64",
    ),
    width: pixels.width,
    height: pixels.height,
  };
}

/**
 * Register this app as the current user's handler of a custom URL scheme. The executable is
 * the running app, never a caller path. Synchronous registry work, so cancellation is
 * checked only before it starts.
 */
export function registerUrlScheme(
  state: State,
  scheme: string,
  signal?: AbortSignal,
): null {
  active(state);
  notCancelled(signal);
  return state.urlSchemes.register(normalizeUrlScheme(scheme));
}

/** Remove a registration this app made. Resolves false when there is none of its own. */
export function unregisterUrlScheme(
  state: State,
  scheme: string,
  signal?: AbortSignal,
): boolean {
  active(state);
  notCancelled(signal);
  return state.urlSchemes.unregister(normalizeUrlScheme(scheme));
}

/** Whether the registry holds this app's registration for the scheme. */
export function isUrlSchemeRegistered(
  state: State,
  scheme: string,
  signal?: AbortSignal,
): boolean {
  active(state);
  notCancelled(signal);
  return state.urlSchemes.isRegistered(normalizeUrlScheme(scheme));
}

export function openFile(state: State, path: string): null {
  active(state);
  // The resolved path is what the Shell is asked to open, so a link's name cannot stand in for its target.
  state.shell.open(resolveReadableFile(normalizeFilePath(path)));
  return null;
}

export function revealFile(state: State, path: string): null {
  active(state);
  const selected = normalizeFilePath(path);
  resolveReadableFile(selected);
  state.shell.reveal(selected);
  return null;
}

export function trashFile(state: State, path: string): null {
  active(state);
  const selected = normalizeFilePath(path);
  validateTrashDrive(selected);
  const { size } = assertExistingFile(selected);
  assertFitsRecycleBin(selected, size);
  trashWindowsFile(selected);
  return null;
}

/** The call is synchronous and not interruptible, so cancellation is checked only before it starts. */
function notCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new BunawayError({
      code: "CANCELLED",
      message: "Opener request cancelled.",
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
  resolveReadableFile(selected);
  state.recent.request(selected);
  return null;
}

/** Clear the user's entire Shell Recent Items list, not only entries this app added. */
export function clearRecentDocuments(state: State, signal?: AbortSignal): null {
  active(state);
  notCancelled(signal);
  state.recent.request(null);
  return null;
}

/** Read an existing shortcut file's properties without resolving or launching its target. */
export function readShortcutLink(
  state: State,
  path: string,
  signal?: AbortSignal,
): ShortcutLink {
  active(state);
  notCancelled(signal);
  const resolved = resolveShortcutFile(normalizeShortcutPath(path));
  return state.shortcuts.read(resolved);
}

/** Resolve an existing shortcut file, requiring that its target still be a `.lnk` file. */
function resolveShortcutFile(selected: string): string {
  const resolved = resolveReadableFile(selected);
  assertResolvedExtension(resolved, "lnk");
  return resolved;
}

/** The file check reports a missing leaf or parent as `INVALID_ARGUMENT` with `FILE_NOT_FOUND`. */
function isMissingFile(error: unknown): boolean {
  if (!(error instanceof BunawayError)) {
    return false;
  }
  const details = error.details;
  return isRecord(details) && details.reason === "FILE_NOT_FOUND";
}

/**
 * Write a shortcut file. `create` writes a new link or overwrites an existing file;
 * `replace` overwrites an existing file without checking that it is a shortcut;
 * `update` needs an existing shortcut. Parent directories are never created.
 */
export function writeShortcutLink(
  state: State,
  path: string,
  details: ShortcutDetails,
  operation: ShortcutOperation,
  signal?: AbortSignal,
): null {
  active(state);
  notCancelled(signal);
  const selected = normalizeShortcutPath(path);
  const checked = normalizeShortcutDetails(details, operation);
  if (operation !== "create") {
    state.shortcuts.write(resolveShortcutFile(selected), checked, operation);
    return null;
  }
  try {
    state.shortcuts.write(resolveShortcutFile(selected), checked, operation);
  } catch (error) {
    if (!isMissingFile(error)) {
      throw error;
    }
    // A new shortcut is written where it was asked for, so the name must be free (a dangling link is
    // not) and its parent folder must already exist.
    assertNameFree(selected);
    assertParentDirectory(selected);
    state.shortcuts.write(selected, checked, operation);
  }
  return null;
}

/**
 * Replace this app's taskbar Jump List. Tasks always start this app, never a caller-chosen
 * program. The call is synchronous and not interruptible, so cancellation is checked only
 * before it starts.
 */
export function setJumpList(
  state: State,
  input: JumpListInput,
  signal?: AbortSignal,
): JumpListResult {
  active(state);
  notCancelled(signal);
  return state.jumpLists.set(normalizeJumpList(input));
}

/** Entries the user removed from the list, so the app can leave them out of its next list. */
export function getJumpListRemovedItems(
  state: State,
  signal?: AbortSignal,
): RemovedJumpListTask[] {
  active(state);
  notCancelled(signal);
  return state.jumpLists.removedItems();
}

/** Remove the Jump List this app set. */
export function deleteJumpList(state: State, signal?: AbortSignal): null {
  active(state);
  notCancelled(signal);
  state.jumpLists.clear();
  return null;
}

/** Resolve a selected application, requiring that what runs is an `.exe` file whatever its link was named. */
function resolveApplicationFile(application: string): string {
  const resolved = resolveReadableFile(normalizeApplicationPath(application));
  assertResolvedExtension(resolved, "exe");
  return resolved;
}

export function openFileWith(
  state: State,
  path: string,
  application: string,
): null {
  active(state);
  const app = resolveApplicationFile(application);
  state.shell.open(app, resolveReadableFile(normalizeFilePath(path)));
  return null;
}

export function openUrlWith(
  state: State,
  url: string,
  application: string,
): null {
  active(state);
  const app = resolveApplicationFile(application);
  state.shell.open(app, normalizeUrl(url));
  return null;
}

export function dispose(state: State): void {
  state.owner.dispose();
}
