import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { ownedDirectory, type PackagingConfig, parsePackaging } from "@bunaway/packaging";
import { type Policy, parsePolicy } from "@bunaway/protocol";
import { developmentUrl } from "../../runtime-bun/src/development.ts";
import { validateFramework } from "./distribution.ts";
import { json, projectPath } from "./files.ts";

export interface DevServerConfig {
  command: string[];
  url: string;
  timeoutMs: number;
}

export function readDevSettings(value: unknown): DevServerConfig | undefined {
  if (value === undefined) return undefined;
  const dev = record(value);
  keys(dev, ["command", "url", "timeoutMs"]);
  if (
    !Array.isArray(dev.command) ||
    !dev.command.length ||
    dev.command.some((arg) => typeof arg !== "string" || !arg || arg.includes("\0"))
  ) {
    throw new Error("dev.command must be a nonempty array of executable and arguments.");
  }
  const timeoutMs = dev.timeoutMs ?? 30000;
  if (
    typeof timeoutMs !== "number" ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 100 ||
    timeoutMs > 300000
  ) {
    throw new Error("dev.timeoutMs must be an integer between 100 and 300000.");
  }
  return { command: dev.command as string[], url: developmentUrl(dev.url).href, timeoutMs };
}

export interface Project {
  root: string;
  frameworkRoot: string;
  appEntry: string;
  frontend: string;
  bundle?: PackagingConfig;
  dev?: DevServerConfig;
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

// Read the single project settings format used by generated apps.
export async function readProjectSettings(root: string): Promise<{
  directory: string;
  build: Record<string, unknown>;
  app: Record<string, unknown>;
  bundle?: PackagingConfig;
  dev?: DevServerConfig;
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
  keys(build, ["app", "frontend"]);
  const bundle =
    config.bundle === undefined ? undefined : parsePackaging(JSON.stringify(config.bundle));
  const dev = readDevSettings(config.dev);
  return {
    directory,
    build,
    app: record(config.app),
    ...(bundle ? { bundle } : {}),
    ...(dev ? { dev } : {}),
  };
}

export async function validateProject(
  directory: string,
  options: { development?: boolean } = {},
): Promise<Project> {
  const root = await realpath(resolve(directory));
  const settings = await readProjectSettings(root);
  const configDirectory = settings.directory;
  const config = settings.build;
  const server = options.development && settings.dev;
  const appEntry = await projectPath(root, string(config.app));
  const frontendName = string(config.frontend);
  if (isAbsolute(frontendName) || frontendName.split(/[\\/]/).includes("..")) {
    throw new Error("build.frontend must be a project-relative directory without '..'.");
  }
  const frontend = server ? resolve(root, frontendName) : await projectPath(root, frontendName);
  if (server) await ownedDirectory(root, frontend);
  if (!(await lstat(appEntry)).isFile() || (!server && !(await lstat(frontend)).isDirectory())) {
    throw new Error("app must be a file; frontend must be a directory.");
  }
  const frameworkRoot = await validateFramework(root, [appEntry, ...(server ? [] : [frontend])]);
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
  if (!server) {
    const homePath = await projectPath(frontend, decodeURIComponent(url.pathname).slice(1));
    if (!(await lstat(homePath)).isFile()) throw new Error("Home document is not a file.");
  }
  const policy = parsePolicy(await Bun.file(resolve(configDirectory, "policy.json")).text());
  if (policy.views.some((view) => view.origins.some((origin) => origin.startsWith("http:")))) {
    throw new Error(
      "HTTP origins are not allowed in policy.json; use dev.url for a development server.",
    );
  }
  const view = string(raw.view);
  if (policy.views.length !== 1 || policy.views[0]?.id !== view) {
    throw new Error("The vanilla MVP requires one configured policy view.");
  }
  if (!policy.views[0].origins.includes(url.origin))
    throw new Error("Home origin is not permitted.");
  return {
    root,
    frameworkRoot,
    appEntry,
    frontend,
    ...(settings.bundle ? { bundle: settings.bundle } : {}),
    ...(settings.dev ? { dev: settings.dev } : {}),
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
