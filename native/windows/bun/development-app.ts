import { isDeepStrictEqual } from "node:util";
import type { AppDefinition, CommandDefinition } from "@bunaway/core";

function contracts(app: AppDefinition) {
  return structuredClone({
    commands: Object.fromEntries(
      Object.entries(app.commands).map(([name, command]) => [
        name,
        {
          input: command.input,
          output: command.output,
        },
      ]),
    ),
    events: app.events,
    state: app.state,
  });
}

/** Keeps a stable app definition while development reloads replace commands. */
export class DevelopmentApp {
  readonly definition: AppDefinition;
  private current: AppDefinition;
  private readonly initialContracts: ReturnType<typeof contracts>;

  constructor(private readonly initial: AppDefinition) {
    this.current = initial;
    this.initialContracts = contracts(initial);
    this.definition = {
      ...initial,
      commands: Object.fromEntries(
        Object.entries(initial.commands).map(([name, command]) => [
          name,
          {
            input: command.input,
            output: command.output,
            run: (payload, context) => {
              // Capture before awaiting: existing calls finish with their original code.
              const current = this.current.commands[name];
              if (!current) {
                throw new Error(`Missing development command: ${name}`);
              }
              return current.run(payload, context);
            },
          } satisfies CommandDefinition,
        ]),
      ),
    };
  }

  /**
   * Installs new command bodies when contracts and lifecycle objects match.
   * Returns false when restart is needed.
   * In-flight calls keep their original body.
   */
  replace(next: AppDefinition): boolean {
    const plugins = this.initial.plugins ?? [];
    const nextPlugins = next.plugins ?? [];
    if (
      plugins.length !== nextPlugins.length ||
      plugins.some((plugin, index) => plugin !== nextPlugins[index]) ||
      !isDeepStrictEqual(this.initial.desktop, next.desktop) ||
      !isDeepStrictEqual(this.initialContracts, contracts(next))
    ) {
      return false;
    }
    for (const command of Object.values(next.commands)) {
      if (typeof command.run !== "function") {
        throw new Error("App commands must provide a run function.");
      }
    }
    this.current = next;
    return true;
  }
}
