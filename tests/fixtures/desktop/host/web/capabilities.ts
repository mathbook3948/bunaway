import { hostOperations } from "../../../../../packages/protocol/src/index.ts";

export function matchesCapabilities(value: unknown, platform: string): boolean {
  if (!Array.isArray(value) || !["win32", "darwin"].includes(platform)) return false;
  const names = Object.keys(hostOperations);
  if (value.length !== names.length) return false;
  const seen = new Set<string>();
  return value.every((capability) => {
    if (!capability || typeof capability !== "object") return false;
    const { name, support, permission } = capability;
    if (!names.includes(name) || seen.has(name)) return false;
    seen.add(name);
    const expected = name.startsWith("windows.")
      ? platform === "win32"
        ? "experimental"
        : "unsupported"
      : "supported";
    return support === expected && permission === "not-required";
  });
}
