export const viewDirName = (id: string) =>
  `v${[
    ...id,
  ]
    .map((c) =>
      /[a-z0-9]/.test(c)
        ? c
        : `-${c.charCodeAt(0).toString(16).padStart(2, "0")}`,
    )
    .join("")}`;
