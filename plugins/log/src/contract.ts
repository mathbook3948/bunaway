import { type Infer, s } from "@bunaway/plugin";

/** Structured log input and completion contract. */
export const logOperations = {
  write: {
    input: s.object({
      level: s.enum([
        "debug",
        "info",
        "warn",
        "error",
      ]),
      message: s.string({
        maxLength: 1024,
      }),
      details: s.optional(s.json()),
    }),
    output: s.null(),
  },
} as const;

/** Input accepted by `log.write` and the level-specific helpers. */
export type LogInput = Infer<typeof logOperations.write.input>;
