import {
  defineNativePlugin,
  type NativeInvokeOptions,
  s,
} from "@bunaway/plugin";
import manifest from "../package.json";
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
  },
});

/** Plugin contract for opening validated HTTP and HTTPS URLs. */
export const openerPlugin = plugin.definition;
export default openerPlugin;

/** Open an absolute HTTP or HTTPS URL after validating and normalizing it. */
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
