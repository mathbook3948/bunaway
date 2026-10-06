import type { CommandContext, CommandDefinition } from "@bunaway/core";
import {
  BunawayError,
  type Infer,
  type JsonValue,
  type Schema,
  validateValue,
} from "@bunaway/protocol";

export type CommandContract<I extends Schema = Schema, O extends Schema = Schema> = {
  readonly input: I;
  readonly output: O;
};

export type CommandHandler<I extends Schema, O extends Schema> = (
  input: Infer<I>,
  context: CommandContext,
) => Infer<O> | Promise<Infer<O>>;

// Typed handler inputs plus actual schema validation at both sides of the handler.
export function command<const I extends Schema, const O extends Schema>(
  definition: CommandContract<I, O> & { handle: CommandHandler<I, O> },
): CommandDefinition<I, O> {
  return {
    input: definition.input,
    output: definition.output,
    async run(payload, context) {
      let input: Infer<I>;
      try {
        input = validateValue(definition.input, payload);
      } catch {
        throw new BunawayError({ code: "INVALID_ARGUMENT", message: "Invalid command input." });
      }
      const result = await definition.handle(input, context);
      try {
        return validateValue(definition.output, result) as JsonValue;
      } catch {
        throw new BunawayError({ code: "INTERNAL", message: "Invalid command output." });
      }
    },
  };
}
