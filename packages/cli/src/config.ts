import { lstat, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { type Policy, parsePolicy } from "@bunaway/protocol";
import { type PackagingConfig, parsePackaging } from "@bunaway/packaging";
import { validateFramework } from "./distribution.ts";
import { json, projectConfigDirectory, projectPath } from "./files.ts";

export interface Project {
  root: string;
  backend: string;
  frontend: string;
  windowsApp?: string;
  bundle?: PackagingConfig;
  app: {
    appId: string;
    title: string;
    view: string;
    home: string;
    window: { width: number; height: number };
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

// Normalize authoring formats while keeping the native build contracts intact.
export async function readProjectSettings(root: string): Promise<{
  directory: string;
  build: Record<string, unknown>;
  app: Record<string, unknown>;
  bundle?: PackagingConfig;
}> {
  const directory = await projectConfigDirectory(root);
  const config = record(await json(resolve(directory, "bunaway.json")));
  if (config.version === 2) {
    keys(config, ["version", "build", "app", "bundle"]);
    for (const name of ["app.json", "packaging.json"]) {
      if (await Bun.file(resolve(directory, name)).exists()) {
        throw new Error(`bunaway.json v2 replaces ${name}; remove the separate file.`);
      }
    }
    const build = record(config.build);
    keys(build, ["backend", "frontend", "windowsApp"]);
    let bundle: PackagingConfig | undefined;
    if (config.bundle !== undefined) {
      const raw = record(config.bundle);
      if ("version" in raw)
        throw new Error("Use the top-level bunaway.json version, not bundle.version.");
      try {
        bundle = parsePackaging(JSON.stringify({ version: 1, ...raw }));
      } catch (error) {
        if (error instanceof Error)
          error.message = error.message.replaceAll("packaging.json", "bunaway.json.bundle");
        throw error;
      }
    }
    return { directory, build, app: record(config.app), ...(bundle ? { bundle } : {}) };
  }
  if (config.version !== 1) throw new Error("Unsupported bunaway.json version.");
  keys(config, ["version", "backend", "frontend", "windowsApp"]);
  const packagingPath = resolve(directory, "packaging.json");
  const bundle = (await Bun.file(packagingPath).exists())
    ? parsePackaging(await Bun.file(packagingPath).text())
    : undefined;
  return {
    directory,
    build: config,
    app: record(await json(resolve(directory, "app.json"))),
    ...(bundle ? { bundle } : {}),
  };
}

export async function validateProject(directory: string): Promise<Project> {
  const root = await realpath(resolve(directory));
  const settings = await readProjectSettings(root);
  const configDirectory = settings.directory;
  const config = settings.build;
  const backend = await projectPath(root, string(config.backend));
  const frontend = await projectPath(root, string(config.frontend));
  const windowsApp =
    config.windowsApp === undefined
      ? undefined
      : await projectPath(root, string(config.windowsApp));
  if (!(await lstat(backend)).isFile() || !(await lstat(frontend)).isDirectory()) {
    throw new Error("backend must be a file; frontend must be a directory.");
  }
  if (windowsApp && !(await lstat(windowsApp)).isFile())
    throw new Error("windowsApp must be a file.");
  await validateFramework(root, [backend, frontend, ...(windowsApp ? [windowsApp] : [])]);
  const raw = settings.app;
  keys(raw, ["appId", "title", "view", "home", "window"]);
  const appId = string(raw.appId);
  if (!/^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/.test(appId)) {
    throw new Error("appId must match the native host's 1–64 character app ID grammar.");
  }
  const window = record(raw.window);
  keys(window, ["width", "height"]);
  for (const size of [window.width, window.height]) {
    if (typeof size !== "number" || !Number.isInteger(size) || size < 200 || size > 4096) {
      throw new Error("Window dimensions must be integers between 200 and 4096.");
    }
  }
  const home = string(raw.home);
  const url = new URL(home);
  if (url.origin !== "https://app.bunaway.local" || url.username || url.password || url.hash) {
    throw new Error("The MVP home must use the host-owned https://app.bunaway.local origin.");
  }
  const homePath = await projectPath(frontend, decodeURIComponent(url.pathname).slice(1));
  if (!(await lstat(homePath)).isFile()) throw new Error("Home document is not a file.");
  const policy = parsePolicy(await Bun.file(resolve(configDirectory, "policy.json")).text());
  if (policy.views.some((view) => view.origins.some((origin) => origin.startsWith("http:")))) {
    throw new Error("HTTP origins are not allowed; dev also uses native local assets.");
  }
  const view = string(raw.view);
  if (policy.views.length !== 1 || policy.views[0]?.id !== view) {
    throw new Error("The vanilla MVP requires one configured policy view.");
  }
  if (!policy.views[0].origins.includes(url.origin))
    throw new Error("Home origin is not permitted.");
  return {
    root,
    backend,
    ...(windowsApp ? { windowsApp } : {}),
    frontend,
    ...(settings.bundle ? { bundle: settings.bundle } : {}),
    policy,
    app: {
      appId,
      title: string(raw.title),
      view,
      home,
      window: { width: window.width as number, height: window.height as number },
    },
  };
}
