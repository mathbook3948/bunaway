import type { CommandDefinition, CommandRegistry, EventRegistry } from "@bunaway/core";
import type { Schema } from "@bunaway/protocol";
import { command, type CommandContract, type CommandHandler } from "./command.ts";
import { checkName, claimName, type RegistrationKind } from "./registration.ts";

export type ModuleDefinition<
  C extends CommandRegistry = CommandRegistry,
  E extends EventRegistry = EventRegistry,
> = {
  readonly name: string;
  readonly commands: C;
  readonly events: E;
};

export interface ModuleBuilder<
  N extends string,
  C extends CommandRegistry = Record<never, never>,
  E extends EventRegistry = Record<never, never>,
> extends ModuleDefinition<C, E> {
  readonly name: N;
  command<const K extends string, const I extends Schema, const O extends Schema>(
    name: K,
    contract: CommandContract<I, O>,
    handle: CommandHandler<I, O>,
  ): ModuleBuilder<N, C & Readonly<Record<`${N}.${K}`, CommandDefinition<I, O>>>, E>;
  event<const K extends string, const S extends Schema>(
    name: K,
    schema: S,
  ): ModuleBuilder<N, C, E & Readonly<Record<`${N}.${K}`, S>>>;
}

function add<R extends Readonly<Record<string, unknown>>, K extends string, T>(
  entries: R,
  name: K,
  value: T,
  kind: RegistrationKind,
  owner: string,
): R & Readonly<Record<K, T>> {
  const owners = new Map(Object.keys(entries).map((key) => [key, owner]));
  claimName(owners, name, kind, owner);
  // The computed key matches the template literal used by ModuleBuilder's types.
  return Object.freeze({ ...entries, [name]: value }) as R & Readonly<Record<K, T>>;
}

function buildModule<N extends string, C extends CommandRegistry, E extends EventRegistry>(
  name: N,
  commands: C,
  events: E,
): ModuleBuilder<N, C, E> {
  const owner = `module "${name}"`;
  const builder: ModuleBuilder<N, C, E> = {
    name,
    commands,
    events,
    command(localName, contract, handle) {
      checkName(localName, "command", owner);
      return buildModule(
        name,
        add(commands, `${name}.${localName}`, command({ ...contract, handle }), "command", owner),
        events,
      );
    },
    event(localName, schema) {
      checkName(localName, "event", owner);
      return buildModule(
        name,
        commands,
        add(events, `${name}.${localName}`, schema, "event", owner),
      );
    },
  };
  return Object.freeze(builder);
}

// Each call returns a new snapshot so earlier builders retain their exact types.
export function defineModule<const N extends string>(name: N): ModuleBuilder<N> {
  checkName(name, "module", "app");
  return buildModule(name, Object.freeze({}), Object.freeze({}));
}
