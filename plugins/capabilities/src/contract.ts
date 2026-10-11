import { z } from "zod";
/** Registered operation support states, independent of permission grants. */
export const capabilitiesOperations = {
  get: {
    input: z.null(),
    output: z.array(
      z.strictObject({
        name: z
          .string()
          .regex(/^[A-Za-z0-9_.:-]+$(?![\s\S])/u)
          .max(128),
        support: z.enum([
          "supported",
          "experimental",
          "unsupported",
        ]),
        reason: z.string().max(1024).exactOptional(),
      }),
    ),
  },
} as const;
/** Result shape returned by `capabilities()`. */
export type Capabilities = z.infer<typeof capabilitiesOperations.get.output>;
