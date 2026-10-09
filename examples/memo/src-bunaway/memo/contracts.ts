/**
 * Shared by the save command and saved event to enforce one text limit.
 */
export const savedSchema = {
  type: "string",
  maxLength: 10000,
} as const;

/** Accepts memo text and resolves with `null` after saving. */
export const saveContract = {
  input: savedSchema,
  output: {
    const: null,
  },
} as const;

/** Reads the saved memo with no input and returns its text. */
export const readContract = {
  input: {
    const: null,
  },
  output: {
    type: "string",
  },
} as const;
