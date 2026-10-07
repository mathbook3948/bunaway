export const savedSchema = { type: "string", maxLength: 10000 } as const;

export const saveContract = {
  input: savedSchema,
  output: { const: null },
} as const;

export const readContract = {
  input: { const: null },
  output: { type: "string" },
} as const;
