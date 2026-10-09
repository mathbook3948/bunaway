import type { NativeAdapter, NativeEnvironment } from "@bunaway/plugin";
import { BunawayError, NativeRegistry, validateValue } from "@bunaway/protocol";
import { openerPlugin } from "./index.ts";
import { createShell } from "./shell.ts";
import { normalizeUrl, urlInput } from "./url.ts";

/** Prepare the UI adapter that checks permission before asking Explorer to open a URL. */
export function createOperations(
  _environment: NativeEnvironment,
): NativeAdapter {
  const registry = new NativeRegistry([
    openerPlugin,
  ]);
  const shell = createShell();
  return {
    execute() {
      throw new BunawayError({
        code: "UNSUPPORTED",
        message: "Opener requires UI execution.",
      });
    },
    executeUI(name, input, _source, context) {
      const payload = validateValue(urlInput, input);
      const call = {
        operation: name,
        payload,
      };
      if (!registry.allowed(context.permissions, call, () => false)) {
        throw new BunawayError({
          code: "PERMISSION_DENIED",
          message: "Opener permission denied.",
        });
      }
      shell.open(normalizeUrl(payload.url));
      return null;
    },
    dispose: () => shell.dispose(),
  };
}
