import { type Infer, s } from "@bunaway/plugin";

/** Registered operation support states, independent of permission grants. */
export const capabilitiesOperations = {
  get: {
    input: s.null(),
    output: s.array(
      s.object({
        name: s.string({
          pattern: "^[A-Za-z0-9_.:-]+$(?![\\s\\S])",
          maxLength: 128,
        }),
        support: s.enum([
          "supported",
          "experimental",
          "unsupported",
        ]),
        reason: s.optional(
          s.string({
            maxLength: 1024,
          }),
        ),
      }),
    ),
  },
} as const;

/** Result shape returned by `capabilities()`. */
export type Capabilities = Infer<typeof capabilitiesOperations.get.output>;
