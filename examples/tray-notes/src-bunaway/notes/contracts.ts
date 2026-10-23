/** One text limit shared by the save and closing commands. */
export const noteSchema = {
  type: "string",
  maxLength: 10000,
} as const;

/** Accepts note text and resolves with `null` after saving. */
export const textContract = {
  input: noteSchema,
  output: {
    const: null,
  },
} as const;

/** Reads the saved note with no input and returns its text. */
export const readContract = {
  input: {
    const: null,
  },
  output: {
    type: "string",
  },
} as const;

/** Restores the saved window placement and reports whether a saved state existed. */
export const restoreContract = {
  input: {
    const: null,
  },
  output: {
    type: "boolean",
  },
} as const;
