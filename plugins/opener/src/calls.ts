import type { NativeInvokeOptions, NativePluginAPI } from "@bunaway/plugin";
import type { openerOperations } from "./contract.ts";
import { normalizeFilePath } from "./path.ts";
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
  return {
    openUrl,
    openFile,
    revealFile,
  };
}
