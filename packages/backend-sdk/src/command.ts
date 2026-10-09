import type { CommandContext, CommandDefinition } from "@bunaway/plugin-api";
import { bindCommandHost } from "@bunaway/plugin-api/host";
import {
  BunawayError,
  type Infer,
  type JsonValue,
  type Schema,
  validateValue,
} from "@bunaway/protocol";

/** Schemas that validate a command's input and handler result at runtime. */
export type CommandContract<
  I extends Schema = Schema,
  O extends Schema = Schema,
> = {
  /** Validates the payload passed to the handler. */
  readonly input: I;
  /** Validates the handler's return value. */
  readonly output: O;
};

/** Receives validated input and must return a value accepted by the output schema. */
export type CommandHandler<I extends Schema, O extends Schema> = (
  input: Infer<I>,
  context: CommandContext,
) => Infer<O> | Promise<Infer<O>>;

/**
 * Builds a command that validates input before the handler and its result after
 * the handler. Invalid input becomes `INVALID_ARGUMENT`; an invalid result
 * becomes `INTERNAL`. Handler errors pass through this helper unchanged for Core to handle.
 */
export function command<const I extends Schema, const O extends Schema>(
  definition: CommandContract<I, O> & {
    handle: CommandHandler<I, O>;
  },
): CommandDefinition<I, O> {
  return bindCommandHost({
    input: definition.input,
    output: definition.output,
    async run(payload, context) {
      let input: Infer<I>;
      try {
        input = validateValue(definition.input, payload);
      } catch {
        throw new BunawayError({
          code: "INVALID_ARGUMENT",
          message: "Invalid command input.",
        });
      }
      const result = await definition.handle(input, context);
      try {
        return validateValue(definition.output, result) as JsonValue;
      } catch {
        throw new BunawayError({
          code: "INTERNAL",
          message: "Invalid command output.",
        });
      }
    },
  });
}
