import { BunawayError } from "@bunaway/protocol";
import { createFiles, type MacosFiles } from "../macos-file.ts";
import { normalizeMacosFilePath } from "../macos-path.ts";
import { createWorkspace, type MacosWorkspace } from "../macos-workspace.ts";
import { normalizeUrl } from "../url.ts";

/** Own one workspace and checked-file provider, including disposal after use. */
export function createState(workspace: MacosWorkspace, files: MacosFiles) {
  return {
    workspace,
    files,
    disposed: false,
  };
}

/** Prepare synchronous NSWorkspace dispatch on its owning host execution thread. */
export function initialize() {
  const workspace = createWorkspace();
  try {
    return createState(workspace, createFiles());
  } catch (error) {
    workspace.dispose();
    throw error;
  }
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
  const selected = normalizeMacosFilePath(path);
  state.files.withFile(selected, () => state.workspace.openFile(selected));
  return null;
}

export function revealFile(state: State, path: string): null {
  active(state);
  const selected = normalizeMacosFilePath(path);
  state.files.withFile(selected, () => state.workspace.revealFile(selected));
  return null;
}

export function dispose(state: State): void {
  if (state.disposed) {
    return;
  }
  state.disposed = true;
  try {
    state.files.dispose();
  } finally {
    state.workspace.dispose();
  }
}
