import { lstat, readlink, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import {
  ownedDirectory,
  type PackagingConfig,
  parsePackaging,
} from "@bunaway/packaging";
import { OUTPUT_TARGETS, outputPaths } from "@bunaway/packaging/paths";
import { APP_INFO_MAX_LENGTH } from "@bunaway/plugin-api";
import {
  isRecord,
  isWindowsExecutableName,
  type JsonValue,
  NativeRegistry,
  type Policy,
  parsePolicy,
} from "@bunaway/protocol";
import {
  isAppInfoText,
  parsePluginSettings,
} from "@bunaway/runtime-bun/app-metadata";
import {
  developmentPolicy,
  developmentUrl,
} from "@bunaway/runtime-bun/development";
import {
  readWindowSpecs,
  type WindowSpec,
} from "@bunaway/runtime-bun/window-config";
import { parseBuildResources } from "./build-resources.ts";
import { validateFramework } from "./distribution.ts";
import { inside, json, projectPath } from "./files.ts";
import type { InstalledPlugin } from "./plugins.ts";

/** Wait for the development server when bunaway.json sets no dev.timeoutMs. */
const DEFAULT_DEV_TIMEOUT_MS = 30_000;

/** Frontend server command and URL used by the native app during development. */
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
    throw new Error(
      `bunaway.json: ${field} must be a nonempty array of executable and arguments.`,
    );
  }
  return value as string[];
}

/** Validate optional development server settings and apply the default timeout. */
export function readDevSettings(value: unknown): DevServerConfig | undefined {
  if (value === undefined) {
    return undefined;
  }
  const dev = record(value, "dev");
  keys(
    dev,
    [
      "command",
      "url",
      "timeoutMs",
    ],
    "dev",
  );
  const args = command(dev.command, "dev.command");
  const timeoutMs = dev.timeoutMs ?? DEFAULT_DEV_TIMEOUT_MS;
  if (
    typeof timeoutMs !== "number" ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 100 ||
    timeoutMs > 300000
  ) {
    throw new Error(
      "bunaway.json: dev.timeoutMs must be an integer between 100 and 300000.",
    );
  }
  return {
    command: args,
    url: developmentUrl(dev.url).href,
    timeoutMs,
  };
}

/** Resolved app settings and installed framework inputs consumed by CLI commands. */
export interface Project {
  root: string;
  frameworkRoot: string;
  appEntry: string;
  frontend: string;
  buildCommand?: string[];
  /** Project-relative files and directories copied into the app resource directory at build time. */
  resources?: string[];
  backendDependencies?: string[];
  frontendDependencies?: string[];
  nativePlugins?: readonly InstalledPlugin[];
  /** Per-plugin `bunaway.json` `plugins` clauses, passed to the host unchanged. */
  pluginSettings?: Record<string, JsonValue>;
  bundle?: PackagingConfig;
  dev?: DevServerConfig;
  app: {
    appId: string;
    title: string;
    executableName?: string;
    icon?: string;
    view?: string;
    home?: string;
    window?: WindowSpec["window"];
    startup?: boolean;
    visible?: boolean;
    showWhenReady?: WindowSpec["showWhenReady"];
  };
  policy: Policy;
}

/** Resolve development overrides once for generated host settings on either platform. */
export function runtimeSettings(
  project: Project,
  server?: DevServerConfig,
  devtools = false,
) {
  return {
    app: {
      ...project.app,
      ...(project.pluginSettings
        ? {
            pluginSettings: project.pluginSettings,
          }
        : {}),
      ...(server
        ? {
            home: server.url,
            development: {
              url: server.url,
            },
          }
        : {}),
      ...(devtools
        ? {
            developmentTools: true,
          }
        : {}),
    },
    policy: server
      ? developmentPolicy(project.policy, project.app.view ?? [], server.url)
      : project.policy,
  };
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`bunaway.json: ${path} must be an object.`);
  }
  return value;
}

function keys(
  value: Record<string, unknown>,
  allowed: string[],
  path: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) {
    throw new Error(
      `bunaway.json: unknown field ${unknown.map((key) => (path ? `${path}.${key}` : key)).join(", ")}. Allowed fields: ${allowed.join(", ")}.`,
    );
  }
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string" || !value) {
    throw new Error(`bunaway.json: ${path} must be a nonempty string.`);
  }
  return value;
}

/** App titles become `ctx.app.name`, so they share the `AppInfo` string rule. */
function appTitle(value: unknown): string {
  const title = string(value, "app.title");
  if (!isAppInfoText(title)) {
    throw new Error(
      `bunaway.json: app.title must be at most ${APP_INFO_MAX_LENGTH} characters.`,
    );
  }
  return title;
}

async function frontendPath(root: string, name: string): Promise<string> {
  const reserved = [
    ".bunaway",
    ...OUTPUT_TARGETS.map((target) => outputPaths(root, target).output),
  ].map((path) => resolve(root, path).toLowerCase());
  const check = (path: string) => {
    if (!inside(root, path)) {
      throw new Error("Source path escapes the project.");
    }
    const normalized = path.toLowerCase();
    if (
      reserved.some(
        (output) => inside(normalized, output) || inside(output, normalized),
      )
    ) {
      throw new Error(
        "build.frontend must not overlap app outputs or build locks; use a separate web output such as web-dist.",
      );
    }
  };
  const path = resolve(root, name);
  check(path);
  // Resolve through the nearest existing ancestor so missing output cannot hide a reserved-path alias.
  let ancestor = path;
  const suffix: string[] = [];
  let links = 0;
  while (true) {
    try {
      const canonical = resolve(await realpath(ancestor), ...suffix);
      check(canonical);
      return canonical;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      const entry = await lstat(ancestor).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") {
            throw error;
          }
          return undefined;
        },
      );
      if (entry?.isSymbolicLink()) {
        if (++links > 40) {
          throw new Error("Cannot resolve build.frontend directory links.");
        }
        // Check dangling link targets because a later build can create their destination.
        ancestor = resolve(
          dirname(ancestor),
          await readlink(ancestor),
          ...suffix,
        );
        check(ancestor);
        suffix.length = 0;
        continue;
      }
      suffix.unshift(basename(ancestor));
      ancestor = dirname(ancestor);
    }
  }
}

/** Parse the versioned settings file and validate its top-level fields. */
export async function readProjectSettings(root: string): Promise<{
  directory: string;
  build: Record<string, unknown>;
  app: Record<string, unknown>;
  bundle?: PackagingConfig;
  dev?: DevServerConfig;
  buildCommand?: string[];
  resources?: string[];
  plugins?: unknown;
}> {
  const directory = await projectPath(root, "src-bunaway");
  const config = record(await json(resolve(directory, "bunaway.json")), "root");
  if (config.version !== 1) {
    throw new Error("Unsupported bunaway.json version (expected 1).");
  }
  keys(
    config,
    [
      "version",
      "build",
      "app",
      "bundle",
      "dev",
      "plugins",
    ],
    "",
  );
  const build = record(config.build, "build");
  if ("backend" in build || "windowsApp" in build) {
    throw new Error(
      "Use build.app with a default-exported AppDefinition; remove build.backend and build.windowsApp.",
    );
  }
  keys(
    build,
    [
      "app",
      "frontend",
      "command",
      "resources",
    ],
    "build",
  );
  const buildCommand =
    build.command === undefined
      ? undefined
      : command(build.command, "build.command");
  const resources = parseBuildResources(build.resources);
  const bundle =
    config.bundle === undefined
      ? undefined
      : parsePackaging(JSON.stringify(config.bundle));
  const dev = readDevSettings(config.dev);
  return {
    directory,
    build,
    app: record(config.app, "app"),
    ...(config.plugins !== undefined
      ? {
          plugins: config.plugins,
        }
      : {}),
    ...(bundle
      ? {
          bundle,
        }
      : {}),
    ...(dev
      ? {
          dev,
        }
      : {}),
    ...(buildCommand
      ? {
          buildCommand,
        }
      : {}),
    ...(resources
      ? {
          resources,
        }
      : {}),
  };
}

/** A project-relative path must not be absolute or climb out of the project. */
function isOutsideProject(name: string): boolean {
  return isAbsolute(name) || name.split(/[\\/]/).includes("..");
}

/** Check that the app entry is a file and, unless a dev server serves the UI, the frontend is a directory. */
async function assertAppFiles(
  appEntry: string,
  frontend: string,
  server: boolean,
): Promise<void> {
  if (
    !(await lstat(appEntry)).isFile() ||
    (!server && !(await lstat(frontend)).isDirectory())
  ) {
    throw new Error("app must be a file; frontend must be a directory.");
  }
}

/** Windows builds (and any app that sets a name) need a valid, non-installer executable name. */
function assertExecutableName(
  raw: Record<string, unknown>,
  appId: string,
): void {
  if (
    raw.executableName === undefined &&
    !(process.platform === "win32" && process.arch === "x64")
  ) {
    return;
  }
  const name =
    raw.executableName === undefined
      ? `${appId}.exe`
      : string(raw.executableName, "app.executableName");
  if (!isWindowsExecutableName(name, 120) || /^unins\d+\.exe$/i.test(name)) {
    throw new Error(
      raw.executableName === undefined
        ? `Default Windows executable name ${name} is invalid; ` +
            "set app.executableName to a valid .exe name."
        : "app.executableName must be a Windows .exe file name without a path, reserved device name or uninsNNN.exe installer name.",
    );
  }
}

/** The icon must be a project-relative .ico file; the file itself is checked only when files are validated. */
async function assertIcon(
  raw: Record<string, unknown>,
  root: string,
  validateFiles: boolean,
): Promise<void> {
  if (raw.icon === undefined) {
    return;
  }
  const name = string(raw.icon, "app.icon");
  if (!name.toLowerCase().endsWith(".ico")) {
    throw new Error("app.icon must be an .ico file.");
  }
  if (isOutsideProject(name)) {
    throw new Error("app.icon must be project-relative without '..'.");
  }
  if (validateFiles && !(await lstat(await projectPath(root, name))).isFile()) {
    throw new Error("app.icon must be a regular file.");
  }
}

/** Read policy.json and reject HTTP origins and operations the installed plugins do not declare. */
async function readAppPolicy(
  configDirectory: string,
  plugins: readonly InstalledPlugin[],
): Promise<ReturnType<typeof parsePolicy>> {
  const policy = parsePolicy(
    await Bun.file(resolve(configDirectory, "policy.json")).text(),
  );
  if (
    policy.views.some((view) =>
      view.origins.some((origin) => origin.startsWith("http:")),
    )
  ) {
    throw new Error(
      "HTTP origins are not allowed in policy.json; use dev.url for a development server.",
    );
  }
  new NativeRegistry(plugins, {
    mode: "catalog",
  }).validatePolicy(policy);
  return policy;
}

/** Validate the app's single window declaration; `app.view` defaults to the policy's only view. */
function readAppWindow(
  raw: Record<string, unknown>,
  policy: ReturnType<typeof parsePolicy>,
): WindowSpec {
  if (policy.views.length !== 1) {
    throw new Error("The app requires exactly one configured policy view.");
  }
  const [window] = readWindowSpecs(
    [
      {
        view: raw.view ?? policy.views[0]?.id,
        home: raw.home,
        title: raw.title,
        window: raw.window,
        startup: raw.startup,
        visible: raw.visible,
        showWhenReady: raw.showWhenReady,
      },
    ],
    policy,
  );
  if (!window || window.view !== policy.views[0]?.id) {
    throw new Error("app.view must be the policy's only view.");
  }
  return window;
}

/** The window's home document must be a file inside the frontend directory. */
async function assertHomeDocument(
  spec: WindowSpec,
  frontend: string,
): Promise<void> {
  const homePath = await projectPath(
    frontend,
    decodeURIComponent(new URL(spec.home).pathname).slice(1),
  );
  if (!(await lstat(homePath)).isFile()) {
    throw new Error("Home document is not a file.");
  }
}

/** Validate the app section of the settings and return the policy and windows derived from it. */
async function readAppSection(
  raw: Record<string, unknown>,
  settingsDirectory: string,
  plugins: readonly InstalledPlugin[],
  root: string,
  validateFiles: boolean,
) {
  keys(
    raw,
    [
      "appId",
      "title",
      "view",
      "home",
      "window",
      "startup",
      "visible",
      "showWhenReady",
      "executableName",
      "icon",
    ],
    "app",
  );
  const appId = string(raw.appId, "app.appId");
  if (!/^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/.test(appId)) {
    throw new Error(
      "appId must match the native host's 1–64 character app ID grammar.",
    );
  }
  // Checked before window declarations, whose own title rules would otherwise report first.
  const title = appTitle(raw.title);
  assertExecutableName(raw, appId);
  await assertIcon(raw, root, validateFiles);
  const policy = await readAppPolicy(settingsDirectory, plugins);
  const window = readAppWindow(raw, policy);
  return {
    appId,
    title,
    policy,
    window,
  };
}

/**
 * Resolve project settings, policy and framework packages. Callers can defer source-import checks;
 * metadata-only reads also skip required app and frontend file checks.
 */
async function loadProject(
  directory: string,
  options: {
    development?: boolean;
    validateSources?: boolean;
    validateFiles?: boolean;
  } = {},
): Promise<Project> {
  const root = await realpath(resolve(directory));
  const settings = await readProjectSettings(root);
  const config = settings.build;
  const server = options.development && settings.dev;
  const validateFiles = options.validateFiles !== false;
  const appName = string(config.app, "build.app");
  if (isOutsideProject(appName)) {
    throw new Error("build.app must be a project-relative file without '..'.");
  }
  const appEntry = validateFiles
    ? await projectPath(root, appName)
    : resolve(root, appName);
  const frontendName = string(config.frontend, "build.frontend");
  if (isOutsideProject(frontendName)) {
    throw new Error(
      "build.frontend must be a project-relative directory without '..'.",
    );
  }
  const frontend = await frontendPath(root, frontendName);
  if (server && validateFiles) {
    await ownedDirectory(root, frontend);
  }
  if (validateFiles) {
    await assertAppFiles(appEntry, frontend, !!server);
  }
  const {
    root: frameworkRoot,
    backendDependencies,
    frontendDependencies,
    plugins,
  } = await validateFramework(
    root,
    options.validateSources === false
      ? []
      : [
          appEntry,
          ...(server
            ? []
            : [
                frontend,
              ]),
        ],
  );
  const raw = settings.app;
  const { appId, title, policy, window } = await readAppSection(
    raw,
    settings.directory,
    plugins,
    root,
    validateFiles,
  );
  if (!server && validateFiles) {
    await assertHomeDocument(window, frontend);
  }
  const pluginSettings =
    settings.plugins === undefined
      ? undefined
      : readPluginClauses(
          settings.plugins,
          new Set(plugins.map((plugin) => plugin.name)),
        );
  return {
    root,
    frameworkRoot,
    appEntry,
    frontend,
    backendDependencies,
    frontendDependencies,
    nativePlugins: plugins,
    ...(pluginSettings
      ? {
          pluginSettings,
        }
      : {}),
    ...(settings.bundle
      ? {
          bundle: settings.bundle,
        }
      : {}),
    ...(settings.dev
      ? {
          dev: settings.dev,
        }
      : {}),
    ...(settings.buildCommand
      ? {
          buildCommand: settings.buildCommand,
        }
      : {}),
    ...(settings.resources
      ? {
          resources: settings.resources,
        }
      : {}),
    policy,
    app: {
      appId,
      title,
      ...(raw.executableName !== undefined
        ? {
            executableName: raw.executableName as string,
          }
        : {}),
      ...(raw.icon !== undefined
        ? {
            icon: raw.icon as string,
          }
        : {}),
      view: window.view,
      home: window.home,
      window: window.window,
      ...(window.startup === undefined
        ? {}
        : {
            startup: window.startup,
          }),
      ...(window.visible === undefined
        ? {}
        : {
            visible: window.visible,
          }),
      ...(window.showWhenReady === undefined
        ? {}
        : {
            showWhenReady: window.showWhenReady,
          }),
    },
  };
}

/** Validate the `plugins` section; clause contents are checked by each plugin when its adapter is created. */
function readPluginClauses(
  value: unknown,
  installed: ReadonlySet<string>,
): Record<string, JsonValue> {
  try {
    return parsePluginSettings(value, installed);
  } catch (error) {
    throw new Error(`bunaway.json: ${(error as Error).message}`);
  }
}

/** Resolve settings and framework dependencies without requiring build outputs or app source files. */
export function readProjectMetadata(directory: string): Promise<Project> {
  return loadProject(directory, {
    validateFiles: false,
    validateSources: false,
  });
}

/** Resolve development settings before the watcher and defer app source validation until a build. */
export function readProjectConfiguration(directory: string): Promise<Project> {
  return loadProject(directory, {
    development: true,
    validateSources: false,
  });
}

/** Fully validate app settings, policy, framework dependencies and required project files. */
export function validateProject(
  directory: string,
  options: {
    development?: boolean;
  } = {},
): Promise<Project> {
  return loadProject(directory, options);
}
