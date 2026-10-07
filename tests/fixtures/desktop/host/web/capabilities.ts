import { hostOperations, NativeRegistry } from "../../../../../packages/protocol/src/index.ts";
import { capabilitiesPlugin } from "../../../../../plugins/capabilities/src/index.ts";
import { logPlugin } from "../../../../../plugins/log/src/index.ts";
import { storagePlugin } from "../../../../../plugins/storage/src/index.ts";

const nativePlugins = new NativeRegistry([storagePlugin, logPlugin, capabilitiesPlugin]);
export const expectedCapabilityNames = [
  ...Object.keys(hostOperations),
  ...nativePlugins.operations.keys(),
];

export function matchesCapabilities(value: unknown, platform: string): boolean {
  if (!Array.isArray(value) || !["win32", "darwin"].includes(platform)) return false;
  const names = expectedCapabilityNames;
  if (value.length !== names.length) return false;
  const seen = new Set<string>();
  return value.every((capability) => {
    if (!capability || typeof capability !== "object") return false;
    const { name, support, permission } = capability;
    if (!names.includes(name) || seen.has(name)) return false;
    seen.add(name);
    const expected =
      name.startsWith("windows.") && platform === "darwin" ? "unsupported" : "supported";
    return support === expected && permission === "not-required";
  });
}
