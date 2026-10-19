import { BunawayError } from "@bunaway/protocol";
import { resolveReadableFile } from "#opener/platforms/file-check";
import { normalizeMacosFilePath } from "#opener/platforms/macos-path";
import {
  createWorkspace,
  type MacosWorkspace,
} from "#opener/platforms/macos-workspace";
import { normalizeUrl } from "#opener/url";
/** Own one workspace, including disposal after use. */
export function createState(workspace: MacosWorkspace) {
  return {
    workspace,
    disposed: false,
  };
}

/** Prepare synchronous NSWorkspace dispatch on its owning host execution thread. */
export function initialize() {
  return createState(createWorkspace());
}

type State = ReturnType<typeof initialize>;

function active(state: State): void {
  if (state.disposed) {
    throw new BunawayError({
      code: "CANCELLED",
      message: "Opener has been disposed.",
    });
  }
}

export function openUrl(state: State, url: string): null {
  active(state);
  state.workspace.openUrl(normalizeUrl(url));
  return null;
}

export function openFile(state: State, path: string): null {
  active(state);
  // The resolved path is what NSWorkspace is asked to open, so a link's name cannot stand in for its target.
  state.workspace.openFile(resolveReadableFile(normalizeMacosFilePath(path)));
  return null;
}

export function revealFile(state: State, path: string): null {
  active(state);
  const selected = normalizeMacosFilePath(path);
  resolveReadableFile(selected);
  state.workspace.revealFile(selected);
  return null;
}

export function dispose(state: State): void {
  if (state.disposed) {
    return;
  }
  state.disposed = true;
  state.workspace.dispose();
}
