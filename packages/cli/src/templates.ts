export const templateNames = ["vanilla", "vite", "react", "vue", "svelte"] as const;
export type Template = (typeof templateNames)[number];

export function isTemplate(value: string): value is Template {
  return templateNames.some((template) => template === value);
}
