import {
  defineNativePlugin,
  type NativeInvokeOptions,
  s,
} from "@bunaway/plugin";
import manifest from "../package.json";
import { fileInput, normalizeFilePath } from "./path.ts";
import { matches } from "./scope.ts";
import { normalizeUrl, urlInput } from "./url.ts";

const plugin = defineNativePlugin({
  name: "opener",
  version: manifest.version,
  operations: {
    openUrl: {
      input: urlInput,
      output: s.null(),
      permission: "openUrl",
      osPermission: "not-required",
    },
    openFile: {
      input: fileInput,
      output: s.null(),
      permission: "openFile",
      osPermission: "not-required",
    },
    revealFile: {
      input: fileInput,
      output: s.null(),
      permission: "revealFile",
      osPermission: "not-required",
    },
  },
  scopes: {
    openFile: fileInput,
    revealFile: fileInput,
  },
  matches,
});

/** Plugin contract for scoped files and validated HTTP and HTTPS URLs. */
export const openerPlugin = plugin.definition;
export default openerPlugin;

/** Open an absolute HTTP or HTTPS URL. Success means Explorer accepted the request. */
export async function openUrl(
  url: string,
  options?: NativeInvokeOptions,
): Promise<null> {
  return plugin.api.openUrl(
    {
      url: normalizeUrl(url),
    },
    options,
  );
}

/** Open an existing absolute Windows file with its default app. Success is request acceptance. */
export async function openFile(
  path: string,
  options?: NativeInvokeOptions,
): Promise<null> {
  return plugin.api.openFile(
    {
      path: normalizeFilePath(path),
    },
    options,
  );
}

/** Select an existing absolute Windows file in Explorer. Success is request acceptance. */
export async function revealFile(
  path: string,
  options?: NativeInvokeOptions,
): Promise<null> {
  return plugin.api.revealFile(
    {
      path: normalizeFilePath(path),
    },
    options,
  );
}
