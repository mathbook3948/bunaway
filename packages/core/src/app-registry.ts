import type {
  AppDefinition,
  CommandDefinition,
  PluginDefinition,
} from "@bunaway/plugin-api";
import {
  BunawayError,
  type JsonValue,
  NativeRegistry,
  type Policy,
  type Schema,
  type WireError,
} from "@bunaway/protocol";
import type { CoreServices } from "./index.ts";

type ViewPolicy = Policy["views"][number];

/** Validated app registrations and policy lookups ready for core startup. */
export type PreparedAppRegistry = {
  readonly plugins: readonly PluginDefinition[];
  readonly registry: NativeRegistry;
  readonly commands: ReadonlyMap<string, CommandDefinition>;
  readonly events: ReadonlyMap<string, Schema>;
  readonly views: ReadonlyMap<string, ViewPolicy>;
};

const NAME_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

function fail(code: WireError["code"], message: string): never {
  throw new BunawayError({
    code,
    message,
  });
}

function checkRegistrationName(
  name: string,
  kind: "command" | "event",
  owner: string,
): void {
  if (!NAME_PATTERN.test(name)) {
    fail("INVALID_ARGUMENT", `${owner} registered an invalid ${kind} name.`);
  }
  if (kind === "command" && name.startsWith("plugin.")) {
    fail(
      "INVALID_ARGUMENT",
      `${owner} cannot register the reserved plugin namespace command.`,
    );
  }
}

function registerAll<T>(
  target: Map<string, T>,
  entries: Readonly<Record<string, T>>,
  kind: "command" | "event",
  owner: string,
): void {
  for (const [name, definition] of Object.entries(entries)) {
    checkRegistrationName(name, kind, owner);
    if (target.has(name)) {
      fail("INVALID_ARGUMENT", `Duplicate ${kind} "${name}".`);
    }
    target.set(name, definition);
  }
}

/** Orders plugins by dependency and rejects unsupported or unauthorized entries. */
function orderPlugins(
  plugins: readonly PluginDefinition[],
  services: Pick<CoreServices, "platform" | "policy">,
): PluginDefinition[] {
  const byName = new Map<string, PluginDefinition>();
  for (const plugin of plugins) {
    if (byName.has(plugin.name)) {
      fail("INVALID_ARGUMENT", `Duplicate plugin "${plugin.name}".`);
    }
    byName.set(plugin.name, plugin);
  }
  const ordered: PluginDefinition[] = [];
  const marks = new Map<string, "open" | "done">();
  const visit = (plugin: PluginDefinition): void => {
    const mark = marks.get(plugin.name);
    if (mark === "done") {
      return;
    }
    if (mark === "open") {
      fail("INVALID_ARGUMENT", `Plugin dependency cycle at "${plugin.name}".`);
    }
    marks.set(plugin.name, "open");
    for (const dependency of plugin.dependencies ?? []) {
      const target = byName.get(dependency);
      if (!target) {
        fail(
          "INVALID_ARGUMENT",
          `Plugin "${plugin.name}" requires unknown plugin "${dependency}".`,
        );
      }
      visit(target);
    }
    marks.set(plugin.name, "done");
    ordered.push(plugin);
  };
  // Dependencies must be set up first; the open mark also detects cycles.
  for (const plugin of plugins) {
    visit(plugin);
  }
  for (const plugin of ordered) {
    if (plugin.platforms && !plugin.platforms.includes(services.platform)) {
      fail(
        "UNSUPPORTED",
        `Plugin "${plugin.name}" does not support ${services.platform}.`,
      );
    }
    if (
      plugin.requiredPermissions?.some(
        (permission) =>
          !services.policy.backend.permissions.some(
            (grant) =>
              (typeof grant === "string" ? grant : grant.identifier) ===
              permission,
          ),
      )
    ) {
      fail(
        "INVALID_ARGUMENT",
        `Plugin "${plugin.name}" requires host permissions outside the backend policy.`,
      );
    }
  }
  return ordered;
}

/**
 * Merges app and plugin registrations, then validates native operations and views.
 * Throws a protocol error for duplicate, invalid, unsupported, or disallowed entries.
 */
export function prepareAppRegistry(
  app: AppDefinition,
  services: Pick<CoreServices, "platform" | "policy">,
): PreparedAppRegistry {
  const plugins = orderPlugins(app.plugins ?? [], services);
  const commands = new Map<string, CommandDefinition>();
  const events = new Map<string, Schema>();
  registerAll(commands, app.commands, "command", "app");
  registerAll(events, app.events, "event", "app");
  for (const plugin of plugins) {
    registerAll(
      commands,
      plugin.commands ?? {},
      "command",
      `plugin "${plugin.name}"`,
    );
    registerAll(
      events,
      plugin.events ?? {},
      "event",
      `plugin "${plugin.name}"`,
    );
  }
  const registry = new NativeRegistry(plugins);
  registry.validatePolicy(services.policy);
  // Generated native commands use the same permission checks as declared commands.
  for (const operation of registry.operations.values()) {
    commands.set(`plugin.${operation.name}`, {
      input: operation.input,
      output: operation.output,
      async run(input, context) {
        return context.host.call(operation, input as JsonValue);
      },
    });
  }
  const views = new Map<string, ViewPolicy>();
  for (const view of services.policy.views) {
    if (views.has(view.id)) {
      fail("INVALID_ARGUMENT", `Duplicate policy view "${view.id}".`);
    }
    views.set(view.id, view);
  }
  return {
    plugins,
    registry,
    commands,
    events,
    views,
  };
}
