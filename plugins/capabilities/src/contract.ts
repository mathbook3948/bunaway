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
          .refine(
            (value) => Array.from(value).length <= 128,
            "Text exceeds the Unicode character limit.",
          ),
        support: z.enum([
          "supported",
          "experimental",
          "unsupported",
        ]),
        reason: z
          .string()
          .refine(
            (value) => Array.from(value).length <= 1024,
            "Text exceeds the Unicode character limit.",
          )
          .exactOptional(),
      }),
    ),
  },
} as const;
/** Result shape returned by `capabilities()`. */
export type Capabilities = z.infer<typeof capabilitiesOperations.get.output>;
