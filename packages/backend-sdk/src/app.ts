import type { AppDefinition, CommandRegistry, EventRegistry } from "@bunaway/core";
import type { ModuleDefinition } from "./module.ts";
import { claimName, type RegistrationKind } from "./registration.ts";

// Merge required tuple positions without treating alternative modules at one
// position as simultaneously registered. Dynamic tails may be empty.
type ModuleEntries<
  M extends readonly ModuleDefinition[],
  K extends "commands" | "events",
  Collected = Record<never, never>,
> = M extends readonly [
  infer First extends ModuleDefinition,
  ...infer Rest extends readonly ModuleDefinition[],
]
  ? ModuleEntries<Rest, K, Collected & First[K]>
  : Collected;

type AppOptions<
  M extends readonly ModuleDefinition[],
  C extends CommandRegistry,
  E extends EventRegistry,
> = Pick<AppDefinition, "state" | "plugins"> & {
  readonly modules: M;
  readonly commands?: C;
  readonly events?: E;
};

function collect<T>(
  entries: Readonly<Record<string, T>>,
  target: Map<string, T>,
  owners: Map<string, string>,
  kind: RegistrationKind,
  owner: string,
): void {
  for (const [name, definition] of Object.entries(entries)) {
    claimName(owners, name, kind, owner);
    target.set(name, definition);
  }
}

export function defineApp<
  const M extends readonly ModuleDefinition[],
  const C extends CommandRegistry = Record<never, never>,
  const E extends EventRegistry = Record<never, never>,
>(options: AppOptions<M, C, E>) {
  const commands = new Map<string, CommandRegistry[string]>();
  const events = new Map<string, EventRegistry[string]>();
  const commandOwners = new Map<string, string>();
  const eventOwners = new Map<string, string>();
  collect(options.commands ?? {}, commands, commandOwners, "command", "app.commands");
  collect(options.events ?? {}, events, eventOwners, "event", "app.events");
  options.modules.forEach((module, index) => {
    const owner = `module "${module.name}" (modules[${index}])`;
    collect(module.commands, commands, commandOwners, "command", owner);
    collect(module.events, events, eventOwners, "event", owner);
  });
  // Plugins stay in Core's lifecycle, but their names cannot collide with app modules.
  options.plugins?.forEach((plugin, index) => {
    const owner = `plugin "${plugin.name}" (plugins[${index}])`;
    for (const name of Object.keys(plugin.commands ?? {}))
      claimName(commandOwners, name, "command", owner);
    for (const name of Object.keys(plugin.events ?? {}))
      claimName(eventOwners, name, "event", owner);
  });
  return Object.freeze({
    // Prevent contextual AppDefinition types from widening absent direct registries.
    commands: Object.freeze(Object.fromEntries(commands)) as Readonly<
      NoInfer<C> & ModuleEntries<M, "commands">
    >,
    events: Object.freeze(Object.fromEntries(events)) as Readonly<
      NoInfer<E> & ModuleEntries<M, "events">
    >,
    ...(options.state === undefined ? {} : { state: options.state }),
    ...(options.plugins === undefined ? {} : { plugins: Object.freeze([...options.plugins]) }),
  });
}
