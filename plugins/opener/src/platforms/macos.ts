import type { NativeAdapter, NativeEnvironment } from "@bunaway/plugin";
import { BunawayError } from "@bunaway/protocol";
import { validateOpenerInput } from "../contract.ts";
import { createFiles, type MacosFiles } from "../macos-file.ts";
import { normalizeMacosFilePath } from "../macos-path.ts";
import { createWorkspace, type MacosWorkspace } from "../macos-workspace.ts";
import { normalizeUrl } from "../url.ts";

/**
 * Own the isolated opener resources. The host must check live permissions and
 * cancellation immediately before execute; I/O adapters receive no grant token.
 * Accepted OS requests cannot be rolled back by cancellation or disposal.
 */
export function createAdapter(
  workspace: MacosWorkspace,
  files: MacosFiles,
): NativeAdapter {
  let disposed = false;
  return {
    execute(name, input) {
      if (disposed) {
        throw new BunawayError({
          code: "CANCELLED",
          message: "Opener has been disposed.",
        });
      }
      const payload = validateOpenerInput(name, input);
      if ("app" in payload) {
        throw new BunawayError({
          code: "UNSUPPORTED",
          message: "Selected .exe applications are only supported on Windows.",
        });
      }
      if ("url" in payload) {
        workspace.openUrl(normalizeUrl(payload.url));
      } else {
        const path = normalizeMacosFilePath(payload.path);
        files.withFile(path, () => {
          if (name === "opener.openFile") {
            workspace.openFile(path);
          } else {
            workspace.revealFile(path);
          }
        });
      }
      return null;
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      try {
        files.dispose();
      } finally {
        workspace.dispose();
      }
    },
  };
}

/** Prepare synchronous NSWorkspace dispatch on its owning host execution thread. */
export function createOperations(
  _environment: NativeEnvironment,
): NativeAdapter {
  const workspace = createWorkspace();
  try {
    return createAdapter(workspace, createFiles());
  } catch (error) {
    workspace.dispose();
    throw error;
  }
}
