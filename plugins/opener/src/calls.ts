import type { NativeInvokeOptions, NativePluginAPI } from "@bunaway/plugin";
import type { openerOperations } from "./contract.ts";
import { normalizeApplicationPath, normalizeFilePath } from "./path.ts";
import { normalizeUrl } from "./url.ts";

/** Build public helpers around the plugin's typed operations. */
export function createOpener(api: NativePluginAPI<typeof openerOperations>) {
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
        path: normalizeFilePath(path),
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
        path: normalizeFilePath(path),
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
  return {
    openUrl,
    openFile,
    revealFile,
    openFileWith,
    openUrlWith,
  };
}
