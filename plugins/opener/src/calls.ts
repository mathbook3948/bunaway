import type { NativeInvokeOptions, NativePluginAPI } from "@bunaway/plugin";
import type {
  FileIcon,
  FileIconSize,
  JumpListInput,
  JumpListResult,
  RemovedJumpListTask,
  ShortcutDetails,
  ShortcutLink,
  ShortcutOperation,
  UrlHandler,
} from "#opener/contract";
import { DEFAULT_FILE_ICON_SIZE } from "#opener/contract";
import type { windowsOperations } from "#opener/operations";
import { normalizeMacosFilePath } from "#opener/platforms/macos-path";
import {
  normalizeApplicationPath,
  normalizeFileIconExtension,
  normalizeFilePath,
  normalizeJumpList,
  normalizeShortcutDetails,
  normalizeShortcutPath,
} from "#opener/platforms/windows-path";
import { normalizeUrl } from "#opener/url";
import { normalizeUrlScheme } from "#opener/url-scheme";

/** Accept either path spelling; the host adapter enforces its own platform. */
function normalizeOpenerFilePath(input: unknown): string {
  return typeof input === "string" &&
    input.startsWith("/") &&
    !input.startsWith("//")
    ? normalizeMacosFilePath(input)
    : normalizeFilePath(input);
}

/** A POSIX-style path reaches the macOS host, which reports UNSUPPORTED for shortcut operations. */
function isPosixPath(input: unknown): input is string {
  return (
    typeof input === "string" &&
    input.startsWith("/") &&
    !input.startsWith("//")
  );
}

/** Build public helpers around the plugin's typed operations. */
export function createOpener(api: NativePluginAPI<typeof windowsOperations>) {
  /** Open an absolute HTTP or HTTPS URL. Success means the OS accepted the request. */
  async function openUrl(
    url: string,
    options?: NativeInvokeOptions,
  ): Promise<null> {
    return api.openUrl(
      {
        url: normalizeUrl(url),
      },
      options,
    );
  }

  /**
   * Look up the application the OS associates with the URL scheme, without opening the URL
   * or starting the app. Resolves null when no application handles the scheme. The result
   * exposes the executable path, so it has its own permission. Windows only.
   */
  async function getUrlHandler(
    url: string,
    options?: NativeInvokeOptions,
  ): Promise<UrlHandler | null> {
    return api.getUrlHandler(
      {
        url: normalizeUrl(url),
      },
      options,
    );
  }

  /**
   * Register this app as the current user's handler of a custom URL scheme such as
   * `myapp`, so links open the app with the URL as its last argument. Only the running
   * app can be registered. A scheme registered by something else is not replaced and
   * rejects with INVALID_ARGUMENT, as do reserved schemes such as `http` and `ms-settings`.
   * Windows only.
   */
  async function registerUrlScheme(
    scheme: string,
    options?: NativeInvokeOptions,
  ): Promise<null> {
    return api.registerUrlScheme(
      {
        scheme: normalizeUrlScheme(scheme),
      },
      options,
    );
  }

  /**
   * Remove this app's registration for the scheme. Resolves true when it was removed and
   * false when the app has none, including a scheme owned by someone else. Windows only.
   */
  async function unregisterUrlScheme(
    scheme: string,
    options?: NativeInvokeOptions,
  ): Promise<boolean> {
    return api.unregisterUrlScheme(
      {
        scheme: normalizeUrlScheme(scheme),
      },
      options,
    );
  }

  /**
   * Whether this app holds a complete registration for the scheme. This reads the app's own
   * registry entry; the user may still have chosen another app for the scheme, which
   * `getUrlHandler` reports. Windows only.
   */
  async function isUrlSchemeRegistered(
    scheme: string,
    options?: NativeInvokeOptions,
  ): Promise<boolean> {
    return api.isUrlSchemeRegistered(
      {
        scheme: normalizeUrlScheme(scheme),
      },
      options,
    );
  }

  /** Open an existing absolute file with its default app on Windows or macOS. Success is request acceptance. */
  async function openFile(
    path: string,
    options?: NativeInvokeOptions,
  ): Promise<null> {
    return api.openFile(
      {
        path: normalizeOpenerFilePath(path),
      },
      options,
    );
  }

  /** Select an existing absolute file in Explorer or Finder. Success is request acceptance. */
  async function revealFile(
    path: string,
    options?: NativeInvokeOptions,
  ): Promise<null> {
    return api.revealFile(
      {
        path: normalizeOpenerFilePath(path),
      },
      options,
    );
  }
  /** Open an existing file with a selected absolute .exe application. Success is request acceptance. */
  async function openFileWith(
    path: string,
    app: string,
    options?: NativeInvokeOptions,
  ): Promise<null> {
    return api.openFileWith(
      {
        path: normalizeFilePath(path),
        app: normalizeApplicationPath(app),
      },
      options,
    );
  }

  /** Open an HTTP or HTTPS URL with a selected absolute .exe application. Success is request acceptance. */
  async function openUrlWith(
    url: string,
    app: string,
    options?: NativeInvokeOptions,
  ): Promise<null> {
    return api.openUrlWith(
      {
        url: normalizeUrl(url),
        app: normalizeApplicationPath(app),
      },
      options,
    );
  }
  /** Recycle an existing Windows file. Success means the Shell reported an item in the Recycle Bin. */
  async function trashFile(
    path: string,
    options?: NativeInvokeOptions,
  ): Promise<null> {
    return api.trashFile(
      {
        path: normalizeFilePath(path),
      },
      options,
    );
  }

  /**
   * Add an existing Windows file to the user's Shell Recent Items. Success means the Shell
   * call returned; the Shell may leave a COM multithreaded apartment in the process.
   */
  async function addRecentDocument(
    path: string,
    options?: NativeInvokeOptions,
  ): Promise<null> {
    return api.addRecentDocument(
      {
        // Same spelling rule as openFile: a POSIX path reaches the macOS host, which reports UNSUPPORTED.
        path: normalizeOpenerFilePath(path),
      },
      options,
    );
  }

  /**
   * Clear the user's entire Windows Shell Recent Items via `SHAddToRecentDocs(NULL)`,
   * including entries added by other apps. Listing entries is not supported.
   */
  async function clearRecentDocuments(
    options?: NativeInvokeOptions,
  ): Promise<null> {
    return api.clearRecentDocuments({}, options);
  }

  /**
   * Read a Windows shortcut file (`.lnk`) without resolving or starting its target. Unset
   * text properties are empty strings and `iconIndex` is 0, as in Electron's
   * `shell.readShortcutLink`.
   */
  async function readShortcutLink(
    path: string,
    options?: NativeInvokeOptions,
  ): Promise<ShortcutLink> {
    return api.readShortcutLink(
      {
        path: isPosixPath(path) ? path : normalizeShortcutPath(path),
      },
      options,
    );
  }

  /**
   * Get the icon the Shell shows for an existing file, or for an extension such as `.txt` without a
   * file, after Electron's `app.getFileIcon`. `size` is `small` (16), `normal` (32, the default) or
   * `large` (48) pixels at 100% scale; the PNG is larger when the display is scaled, so read its
   * `width` and `height`. A file path reads the file's own icon (an executable's, for example) and
   * must name an existing file; an extension never touches the file system. Thumbnails are not
   * produced. Windows only.
   */
  async function getFileIcon(
    target:
      | {
          path: string;
        }
      | {
          extension: string;
        },
    size: FileIconSize = DEFAULT_FILE_ICON_SIZE,
    options?: NativeInvokeOptions,
  ): Promise<FileIcon> {
    if ("extension" in target) {
      return api.getFileIcon(
        {
          extension: normalizeFileIconExtension(target.extension),
          size,
        },
        options,
      );
    }
    return api.getFileIcon(
      {
        path: isPosixPath(target.path)
          ? target.path
          : normalizeFilePath(target.path),
        size,
      },
      options,
    );
  }

  /**
   * Write a Windows shortcut file (`.lnk`), after Electron's `shell.writeShortcutLink`.
   * `create` (default) writes a new shortcut or overwrites an existing one, `replace`
   * overwrites an existing `.lnk` file, and `update` changes only the named properties of an
   * existing one. `create` and `replace` need `details.target`. Paths are absolute and the
   * parent directory must exist.
   */
  async function writeShortcutLink(
    path: string,
    details: ShortcutDetails,
    operation: ShortcutOperation = "create",
    options?: NativeInvokeOptions,
  ): Promise<null> {
    const posix = isPosixPath(path);
    return api.writeShortcutLink(
      {
        path: posix ? path : normalizeShortcutPath(path),
        operation,
        details: posix ? details : normalizeShortcutDetails(details, operation),
      },
      options,
    );
  }

  /**
   * Replace this app's taskbar Jump List, after Electron's `app.setJumpList`. Tasks start this
   * app again with the given `args` (read them from the launch arguments); the program cannot
   * be chosen. `separator` items are allowed only in the `tasks` category. Resolves
   * `customCategoryAccessDenied` when the Shell refuses custom categories, for example when the
   * user turned off recent items; the rest of the list is still set. Windows only.
   */
  async function setJumpList(
    input: JumpListInput,
    options?: NativeInvokeOptions,
  ): Promise<JumpListResult> {
    return api.setJumpList(normalizeJumpList(input), options);
  }

  /**
   * Tasks the user removed from the Jump List since it was last set, so the next list can leave
   * them out; the Shell does not accept a removed entry in a new list. Only entries written with
   * this app's launch command are returned. Windows only.
   */
  async function getJumpListRemovedItems(
    options?: NativeInvokeOptions,
  ): Promise<RemovedJumpListTask[]> {
    return api.getJumpListRemovedItems({}, options);
  }

  /** Remove the Jump List this app set; the Shell then shows its default list again. Windows only. */
  async function deleteJumpList(options?: NativeInvokeOptions): Promise<null> {
    return api.deleteJumpList({}, options);
  }

  return {
    setJumpList,
    getJumpListRemovedItems,
    deleteJumpList,
    getFileIcon,
    readShortcutLink,
    writeShortcutLink,
    addRecentDocument,
    clearRecentDocuments,
    getUrlHandler,
    registerUrlScheme,
    unregisterUrlScheme,
    isUrlSchemeRegistered,
    trashFile,
    openUrl,
    openFile,
    revealFile,
    openFileWith,
    openUrlWith,
  };
}
