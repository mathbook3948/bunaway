import { z } from "zod";
/** Structured log input and completion contract. */
export const logOperations = {
  write: {
    input: z.strictObject({
      level: z.enum([
        "debug",
        "info",
        "warn",
        "error",
      ]),
      message: z.string().max(1024),
      details: z.json().exactOptional(),
    }),
    output: z.null(),
  },
} as const;
/** Input accepted by `log.write` and the level-specific helpers. */
export type LogInput = z.infer<typeof logOperations.write.input>;
