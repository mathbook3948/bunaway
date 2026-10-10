import type { NativeAdapter, NativeEnvironment } from "@bunaway/plugin";
import { BunawayError, NativeRegistry, validateValue } from "@bunaway/protocol";
import { openerPlugin } from "./index.ts";
import { fileInput, normalizeFilePath } from "./path.ts";
import { matches } from "./scope.ts";
import { createShell } from "./shell.ts";
import { normalizeUrl, urlInput } from "./url.ts";
import { createFiles } from "./windows-file.ts";

/** Prepare the UI adapter that authorizes each target before submitting OS requests. */
export function createOperations(
  _environment: NativeEnvironment,
): NativeAdapter {
  const registry = new NativeRegistry([
    openerPlugin,
  ]);
  const shell = createShell();
  const files = (() => {
    try {
      return createFiles();
    } catch (error) {
      shell.dispose();
      throw error;
    }
  })();
  return {
    execute() {
      throw new BunawayError({
        code: "UNSUPPORTED",
        message: "Opener requires UI execution.",
      });
    },
    executeUI(name, input, _source, context) {
      registry.operation(name);
      const payload =
        name === "opener.openUrl"
          ? validateValue(urlInput, input)
          : {
              path: normalizeFilePath(validateValue(fileInput, input).path),
            };
      const call = {
        operation: name,
        payload,
      };
      if (!registry.allowed(context.permissions, call, matches)) {
        throw new BunawayError({
          code: "PERMISSION_DENIED",
          message: "Opener permission denied.",
        });
      }
      if ("url" in payload) {
        shell.open(normalizeUrl(payload.url));
      } else {
        files.withFile(payload.path, () => {
          if (name === "opener.openFile") {
            shell.open(payload.path);
          } else {
            shell.reveal(payload.path);
          }
        });
      }
      return null;
    },
    dispose() {
      files.dispose();
      shell.dispose();
    },
  };
}
