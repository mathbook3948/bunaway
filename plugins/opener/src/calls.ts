import type { NativeInvokeOptions, NativePluginAPI } from "@bunaway/plugin";
import { normalizeMacosFilePath } from "./macos-path.ts";
import type { windowsOperations } from "./operations.ts";
import { normalizeApplicationPath, normalizeFilePath } from "./path.ts";
import { normalizeUrl } from "./url.ts";

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
  return {
    trashFile,
    openUrl,
    openFile,
    revealFile,
    openFileWith,
    openUrlWith,
  };
}
