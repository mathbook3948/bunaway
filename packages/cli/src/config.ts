import { parsePolicy, type Policy } from "@bunaway/protocol";
import { lstat, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { json, projectPath } from "./files.ts";

export interface Project {
  root: string;
  backend: string;
  frontend: string;
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

export async function validateProject(directory: string): Promise<Project> {
  const root = await realpath(resolve(directory));
  const config = record(await json(resolve(root, "bunaway.json")));
  keys(config, ["version", "backend", "frontend"]);
  if (config.version !== 1) throw new Error("Unsupported bunaway.json version.");
  const backend = await projectPath(root, string(config.backend));
  const frontend = await projectPath(root, string(config.frontend));
  if (!(await lstat(backend)).isFile() || !(await lstat(frontend)).isDirectory()) {
    throw new Error("backend must be a file; frontend must be a directory.");
  }
  const raw = record(await json(resolve(root, "app.json")));
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
  const policy = parsePolicy(await Bun.file(resolve(root, "policy.json")).text());
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
    frontend,
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
