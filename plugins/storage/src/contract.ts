import { type Infer, s } from "@bunaway/plugin";

const pathFields = {
  // The application selects the path; native implementations validate OS path syntax.
  path: s.string({
    maxLength: 4096,
    pattern: "^[^\\u0000\\r\\n]+$(?![\\s\\S])",
  }),
};
const storageTimes = {
  createdAtMs: {
    anyOf: [
      s.integer(),
      s.null(),
    ],
  },
  modifiedAtMs: {
    anyOf: [
      s.integer(),
      s.null(),
    ],
  },
  accessedAtMs: {
    anyOf: [
      s.integer(),
      s.null(),
    ],
  },
} as const;
const storageMetadata = {
  anyOf: [
    s.object({
      kind: s.enum([
        "file",
      ]),
      sizeBytes: s.integer({
        minimum: 0,
        maximum: Number.MAX_SAFE_INTEGER,
      }),
      ...storageTimes,
    }),
    s.object({
      kind: s.enum([
        "directory",
      ]),
      sizeBytes: s.null(),
      ...storageTimes,
    }),
  ],
} as const;
/** Text and metadata contracts for paths selected by the application. */
export const storageOperations = {
  readText: {
    input: s.object(pathFields),
    output: s.string(),
  },
  writeText: {
    input: s.object({
      ...pathFields,
      text: s.string(),
    }),
    output: s.null(),
  },
  exists: {
    input: s.object(pathFields),
    output: s.boolean(),
  },
  stat: {
    input: s.object(pathFields),
    output: {
      anyOf: [
        storageMetadata,
        s.null(),
      ],
    },
  },
} as const;

/** Path accepted by read and metadata operations. */
export type StorageLocation = Infer<typeof storageOperations.readText.input>;

/** Path and text accepted by `storage.writeText`. */
export type StorageWrite = Infer<typeof storageOperations.writeText.input>;

/** File or directory metadata returned by `storage.stat`. */
export type StorageMetadata = NonNullable<
  Infer<typeof storageOperations.stat.output>
>;
