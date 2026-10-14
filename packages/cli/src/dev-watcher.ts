import { watch } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import type { Project } from "./config.ts";
import { inside } from "./files.ts";

const SOURCE_DEBOUNCE_MS = 150;

/** Opens recursive project change notifications and owns their cleanup. */
export type WatchProject = (
  root: string,
  changed: (name: string | null) => void,
) => {
  close(): void;
};

const watchProject: WatchProject = (root, changed) =>
  watch(
    root,
    {
      recursive: true,
    },
    (_event, name) => changed(name),
  );

/** Owns source notifications and pending paths across reload and rebuild passes. */
export class DevWatcher {
  private watcher: ReturnType<WatchProject> | undefined;
  private closed = false;
  private readonly changes = new Set<string>();

  constructor(
    private readonly state: {
      project(): Project;
      recovering(): boolean;
    },
    private readonly signal: AbortSignal,
    private readonly change: (delayMs: number) => void,
    private readonly open: WatchProject = watchProject,
  ) {}

  get pendingChanges(): readonly string[] {
    return [
      ...this.changes,
    ];
  }

  /** Starts the watcher before the initial build so startup edits are retained. */
  start(): void {
    if (this.closed || this.watcher || this.signal.aborted) {
      return;
    }
    this.watcher = this.open(this.state.project().root, (name) => {
      if (
        this.closed ||
        this.signal.aborted ||
        !name ||
        !shouldRestartHost(this.state.project(), name, this.state.recovering())
      ) {
        return;
      }
      this.changes.add(name);
      // Invalidate synchronously before a pending reload can consume these paths.
      this.change(SOURCE_DEBOUNCE_MS);
    });
  }

  clear(): void {
    this.changes.clear();
  }

  close(): void {
    this.closed = true;
    this.watcher?.close();
    this.watcher = undefined;
  }
}

/** Classifies whether a changed project path can use a compatible app-code reload. */
export function isAppCodeChange(project: Project, name: string): boolean {
  const path = name.replaceAll("\\", "/");
  if (
    !project.dev &&
    (inside(project.frontend, resolve(project.root, path)) ||
      project.frontendDependencies?.includes(path))
  ) {
    return false;
  }
  if (
    [
      "package.json",
      "bun.lock",
      "tsconfig.json",
    ].includes(path)
  ) {
    return false;
  }
  if (
    !/\.[cm]?[jt]sx?$/.test(path) &&
    !project.backendDependencies?.includes(path)
  ) {
    return false;
  }
  const directory = relative(
    project.root,
    dirname(project.appEntry),
  ).replaceAll("\\", "/");
  return (
    project.backendDependencies?.includes(path) === true ||
    (directory ? path.startsWith(`${directory}/`) : !path.includes("/"))
  );
}

/** Classifies watcher changes that enter the host reload or rebuild cycle. */
export function shouldRestartHost(
  project: Project,
  name: string,
  recovering = false,
): boolean {
  const path = name.replaceAll("\\", "/");
  if (
    /^(node_modules|vendor|dist|\.bunaway|\.git|\.next|\.turbo)(\/|$)/.test(
      path,
    )
  ) {
    return false;
  }
  if (!project.dev || recovering) {
    return true;
  }
  // Frontend files and dev-server outputs belong to that server's watcher.
  const backendDirectories = [
    project.appEntry,
  ].map((entry) =>
    relative(project.root, dirname(entry)).replaceAll("\\", "/"),
  );
  const icon = project.app.icon
    ? relative(project.root, resolve(project.root, project.app.icon))
        .replaceAll("\\", "/")
        .toLowerCase()
    : undefined;
  return (
    (icon !== undefined &&
      (icon === path.toLowerCase() ||
        icon.startsWith(`${path.toLowerCase()}/`))) ||
    project.backendDependencies?.some(
      (dependency) => dependency === path || dependency.startsWith(`${path}/`),
    ) ||
    [
      "package.json",
      "bun.lock",
      "tsconfig.json",
    ].includes(path) ||
    path.startsWith("src-bunaway/") ||
    backendDirectories.some((directory) =>
      directory
        ? path === directory || path.startsWith(`${directory}/`)
        : !path.includes("/"),
    )
  );
}
