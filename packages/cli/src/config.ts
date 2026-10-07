import { lstat, readlink, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import {
  BUILD_TARGETS,
  ownedDirectory,
  type PackagingConfig,
  parsePackaging,
} from "@bunaway/packaging";
import { type Policy, parsePolicy } from "@bunaway/protocol";
import { readWindowSpecs, type WindowSpec } from "../../runtime-bun/src/window-config.ts";
import { developmentUrl } from "../../runtime-bun/src/development.ts";
import { validateFramework } from "./distribution.ts";
import { inside, json, projectPath } from "./files.ts";

export interface DevServerConfig {
  command: string[];
  url: string;
  timeoutMs: number;
}

function command(value: unknown, field: string): string[] {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.some((arg) => typeof arg !== "string" || !arg || arg.includes("\0"))
  ) {
    throw new Error(`${field} must be a nonempty array of executable and arguments.`);
  }
  return value as string[];
}

export function readDevSettings(value: unknown): DevServerConfig | undefined {
  if (value === undefined) return undefined;
  const dev = record(value);
  keys(dev, ["command", "url", "timeoutMs"]);
  const args = command(dev.command, "dev.command");
  const timeoutMs = dev.timeoutMs ?? 30000;
  if (
    typeof timeoutMs !== "number" ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 100 ||
    timeoutMs > 300000
  ) {
    throw new Error("dev.timeoutMs must be an integer between 100 and 300000.");
  }
  return { command: args, url: developmentUrl(dev.url).href, timeoutMs };
}

export interface Project {
  root: string;
  frameworkRoot: string;
  appEntry: string;
  frontend: string;
  buildCommand?: string[];
  backendDependencies?: string[];
  bundle?: PackagingConfig;
  dev?: DevServerConfig;
  app: {
    appId: string;
    title: string;
    view: string;
    home: string;
    window: { width: number; height: number };
    windows?: WindowSpec[];
  };
  policy: Policy;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a configuration object.");
  }
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new Error("Unknown configuration field.");
  }
}

function string(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("Expected a nonempty string.");
  return value;
}

async function frontendPath(root: string, name: string): Promise<string> {
  const reserved = [
    ".bunaway",
    "dist/.bunaway-locks",
    ...BUILD_TARGETS.map((t) => `dist/${t}`),
  ].map((path) => resolve(root, path).toLowerCase());
  const check = (path: string) => {
    if (!inside(root, path)) throw new Error("Source path escapes the project.");
    const normalized = path.toLowerCase();
    if (reserved.some((output) => inside(normalized, output) || inside(output, normalized))) {
      throw new Error(
        "build.frontend must not overlap app outputs or build locks; use a separate web output such as web-dist.",
      );
    }
  };
  const path = resolve(root, name);
  check(path);
  // A first build may not have output yet. Resolve its nearest existing ancestor
  // to detect aliases of reserved directories without requiring generated files.
  let ancestor = path;
  const suffix: string[] = [];
  let links = 0;
  while (true) {
    try {
      const canonical = resolve(await realpath(ancestor), ...suffix);
      check(canonical);
      return canonical;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const entry = await lstat(ancestor).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return undefined;
      });
      if (entry?.isSymbolicLink()) {
        if (++links > 40) throw new Error("Cannot resolve build.frontend directory links.");
        // A dangling link can become live when the build creates dist or its
        // locks. Check its target before treating the output as missing.
        ancestor = resolve(dirname(ancestor), await readlink(ancestor), ...suffix);
        check(ancestor);
        suffix.length = 0;
        continue;
      }
      suffix.unshift(basename(ancestor));
      ancestor = dirname(ancestor);
    }
  }
}

// Read the single project settings format used by generated apps.
export async function readProjectSettings(root: string): Promise<{
  directory: string;
  build: Record<string, unknown>;
  app: Record<string, unknown>;
  bundle?: PackagingConfig;
  dev?: DevServerConfig;
  buildCommand?: string[];
}> {
  const directory = await projectPath(root, "src-bunaway");
  const config = record(await json(resolve(directory, "bunaway.json")));
  if (config.version !== 1) throw new Error("Unsupported bunaway.json version (expected 1).");
  keys(config, ["version", "build", "app", "bundle", "dev"]);
  const build = record(config.build);
  if ("backend" in build || "windowsApp" in build) {
    throw new Error(
      "Use build.app with a default-exported AppDefinition; remove build.backend and build.windowsApp.",
    );
  }
  keys(build, ["app", "frontend", "command"]);
  const buildCommand =
    build.command === undefined ? undefined : command(build.command, "build.command");
  const bundle =
    config.bundle === undefined ? undefined : parsePackaging(JSON.stringify(config.bundle));
  const dev = readDevSettings(config.dev);
  return {
    directory,
    build,
    app: record(config.app),
    ...(bundle ? { bundle } : {}),
    ...(dev ? { dev } : {}),
    ...(buildCommand ? { buildCommand } : {}),
  };
}

async function loadProject(
  directory: string,
  options: { development?: boolean; validateSources?: boolean; validateFiles?: boolean } = {},
): Promise<Project> {
  const root = await realpath(resolve(directory));
  const settings = await readProjectSettings(root);
  const configDirectory = settings.directory;
  const config = settings.build;
  const server = options.development && settings.dev;
  const validateFiles = options.validateFiles !== false;
  const appName = string(config.app);
  if (isAbsolute(appName) || appName.split(/[\\/]/).includes("..")) {
    throw new Error("build.app must be a project-relative file without '..'.");
  }
  const appEntry = validateFiles ? await projectPath(root, appName) : resolve(root, appName);
  const frontendName = string(config.frontend);
  if (isAbsolute(frontendName) || frontendName.split(/[\\/]/).includes("..")) {
    throw new Error("build.frontend must be a project-relative directory without '..'.");
  }
  const frontend = await frontendPath(root, frontendName);
  if (server && validateFiles) await ownedDirectory(root, frontend);
  if (
    validateFiles &&
    (!(await lstat(appEntry)).isFile() || (!server && !(await lstat(frontend)).isDirectory()))
  ) {
    throw new Error("app must be a file; frontend must be a directory.");
  }
  const { root: frameworkRoot, backendDependencies } = await validateFramework(
    root,
    options.validateSources === false ? [] : [appEntry, ...(server ? [] : [frontend])],
  );
  const raw = settings.app;
  keys(raw, ["appId", "title", "view", "home", "window", "windows"]);
  const appId = string(raw.appId);
  if (!/^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/.test(appId))
    throw new Error("appId must match the native host's 1–64 character app ID grammar.");
  const multiple = raw.windows !== undefined;
  if (multiple && ["view", "home", "window"].some((key) => key in raw))
    throw new Error("Use app.windows or app.view/home/window, without mixing the two formats.");
  const policy = parsePolicy(await Bun.file(resolve(configDirectory, "policy.json")).text());
  if (policy.views.some((view) => view.origins.some((origin) => origin.startsWith("http:"))))
    throw new Error(
      "HTTP origins are not allowed in policy.json; use dev.url for a development server.",
    );
  const windows = readWindowSpecs(
    multiple
      ? raw.windows
      : [{ view: raw.view, home: raw.home, title: raw.title, window: raw.window }],
    policy,
  );
  if (!multiple && (policy.views.length !== 1 || policy.views[0]?.id !== windows[0]?.view))
    throw new Error("Single-window settings require one configured policy view.");
  if (!server && validateFiles)
    for (const spec of windows) {
      const homePath = await projectPath(
        frontend,
        decodeURIComponent(new URL(spec.home).pathname).slice(1),
      );
      if (!(await lstat(homePath)).isFile()) throw new Error("Home document is not a file.");
    }
  const primary = windows.find((spec) => spec.startup !== false);
  if (!primary) throw new Error("At least one window must open at startup.");
  return {
    root,
    frameworkRoot,
    appEntry,
    frontend,
    backendDependencies,
    ...(settings.bundle ? { bundle: settings.bundle } : {}),
    ...(settings.dev ? { dev: settings.dev } : {}),
    ...(settings.buildCommand ? { buildCommand: settings.buildCommand } : {}),
    policy,
    app: {
      appId,
      title: string(raw.title),
      view: primary.view,
      home: primary.home,
      window: primary.window,
      ...(multiple ? { windows } : {}),
    },
  };
}

// Build preflight and packaging need settings, policy and installed dependencies,
// independently of the app sources and generated frontend output.
export function readProjectMetadata(directory: string): Promise<Project> {
  return loadProject(directory, { validateFiles: false, validateSources: false });
}

// Development must install its watcher before attempting source compilation.
export function readProjectConfiguration(directory: string): Promise<Project> {
  return loadProject(directory, { development: true, validateSources: false });
}

export function validateProject(
  directory: string,
  options: { development?: boolean } = {},
): Promise<Project> {
  return loadProject(directory, options);
}
