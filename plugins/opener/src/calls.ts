import type { NativeInvokeOptions, NativePluginAPI } from "@bunaway/plugin";
import type { UrlHandler } from "#opener/contract";
import type { windowsOperations } from "#opener/operations";
import { normalizeMacosFilePath } from "#opener/platforms/macos-path";
import {
  normalizeApplicationPath,
  normalizeFilePath,
} from "#opener/platforms/windows-path";
import { normalizeUrl } from "#opener/url";

/** Accept either path spelling; the host adapter enforces its own platform. */
function normalizeOpenerFilePath(input: unknown): string {
  return typeof input === "string" &&
    input.startsWith("/") &&
    !input.startsWith("//")
    ? normalizeMacosFilePath(input)
    : normalizeFilePath(input);
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

  return {
    addRecentDocument,
    clearRecentDocuments,
    getUrlHandler,
    trashFile,
    openUrl,
    openFile,
    revealFile,
    openFileWith,
    openUrlWith,
  };
}
