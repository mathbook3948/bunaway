import type {
  CommandDefinition,
  CommandRegistry,
  EventRegistry,
} from "@bunaway/plugin-api";
import type { Schema } from "@bunaway/protocol";
import {
  type CommandContract,
  type CommandHandler,
  command,
} from "./command.ts";
import { checkName, claimName, type RegistrationKind } from "./registration.ts";

type SingleEntry<K extends string, T> = K extends unknown
  ? Record<never, never> extends Record<K, never>
    ? Record<never, never>
    : Readonly<Record<K, T>>
  : never;
// A runtime name selects one entry. Union names are alternatives, and widened
// strings or template patterns cannot guarantee any particular entry.
type RegisteredEntry<N extends string, K extends string, T> = string extends
  | N
  | K
  ? Record<never, never>
  : SingleEntry<`${N}.${K}`, T>;

/** A named group of commands and events ready to be included in an app. */
export type ModuleDefinition<
  C extends CommandRegistry = CommandRegistry,
  E extends EventRegistry = EventRegistry,
> = {
  /** Namespace prepended to this module's command and event names. */
  readonly name: string;
  /** Commands registered under this module's namespace. */
  readonly commands: C;
  /** Event schemas registered under this module's namespace. */
  readonly events: E;
};

/** Immutable, typed builder for registering one module's commands and events. */
export interface ModuleBuilder<
  N extends string,
  C extends CommandRegistry = Record<never, never>,
  E extends EventRegistry = Record<never, never>,
> extends ModuleDefinition<C, E> {
  /** Namespace prepended to this module's command and event names. */
  readonly name: N;
  /** Registers `<module>.<name>`; invalid or duplicate names throw `INVALID_ARGUMENT`. */
  command<
    const K extends string,
    const I extends Schema,
    const O extends Schema,
  >(
    name: K,
    contract: CommandContract<I, O>,
    handle: CommandHandler<I, O>,
  ): ModuleBuilder<N, C & RegisteredEntry<N, K, CommandDefinition<I, O>>, E>;
  /** Declares `<module>.<name>`; emitted payloads are checked against its schema. */
  event<const K extends string, const S extends Schema>(
    name: K,
    schema: S,
  ): ModuleBuilder<N, C, E & RegisteredEntry<N, K, S>>;
}

/** Adds a uniquely named entry to a frozen copy of the current registry. */
function add<
  R extends Readonly<Record<string, unknown>>,
  N extends string,
  K extends string,
  T,
>(
  entries: R,
  namespace: N,
  localName: K,
  value: T,
  kind: RegistrationKind,
  owner: string,
): R & RegisteredEntry<N, K, T> {
  const name = `${namespace}.${localName}`;
  const owners = new Map(
    Object.keys(entries).map((key) => [
      key,
      owner,
    ]),
  );
  claimName(owners, name, kind, owner);
  // The computed key matches the template literal used by ModuleBuilder's types.
  return Object.freeze({
    ...entries,
    [name]: value,
  }) as R & RegisteredEntry<N, K, T>;
}

/** Creates a frozen builder snapshot whose methods add one validated entry. */
function buildModule<
  N extends string,
  C extends CommandRegistry,
  E extends EventRegistry,
>(name: N, commands: C, events: E): ModuleBuilder<N, C, E> {
  const owner = `module "${name}"`;
  const builder: ModuleBuilder<N, C, E> = {
    name,
    commands,
    events,
    command(localName, contract, handle) {
      checkName(localName, "command", owner);
      return buildModule(
        name,
        add(
          commands,
          name,
          localName,
          command({
            ...contract,
            handle,
          }),
          "command",
          owner,
        ),
        events,
      );
    },
    event(localName, schema) {
      checkName(localName, "event", owner);
      return buildModule(
        name,
        commands,
        add(events, name, localName, schema, "event", owner),
      );
    },
  };
  return Object.freeze(builder);
}

/**
 * Starts an empty module builder. Each registration returns a new snapshot, so
 * earlier builders keep their original runtime entries and inferred types.
 */
export function defineModule<const N extends string>(
  name: N,
): ModuleBuilder<N> {
  checkName(name, "module", "app");
  return buildModule(name, Object.freeze({}), Object.freeze({}));
}
