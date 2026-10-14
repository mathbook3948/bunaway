import capabilities from "@bunaway/plugin-capabilities";
import log from "@bunaway/plugin-log";
import storage from "@bunaway/plugin-storage";
import windows from "@bunaway/plugin-windows";
import { NativeRegistry } from "@bunaway/protocol";

const nativePlugins = new NativeRegistry([
  storage._definition,
  log._definition,
  capabilities._definition,
  windows._definition,
]);
export const expectedCapabilityNames = [
  ...nativePlugins.operations.keys(),
];

/**
 * Match every operation and mark Windows window operations unsupported on macOS.
 */
export function matchesCapabilities(value: unknown, platform: string): boolean {
  if (
    !Array.isArray(value) ||
    ![
      "win32",
      "darwin",
    ].includes(platform)
  ) {
    return false;
  }
  const names = expectedCapabilityNames;
  if (value.length !== names.length) {
    return false;
  }
  const seen = new Set<string>();
  return value.every((capability) => {
    if (!capability || typeof capability !== "object") {
      return false;
    }
    const { name, support } = capability;
    if (!names.includes(name) || seen.has(name)) {
      return false;
    }
    seen.add(name);
    const expected =
      name.startsWith("windows.") && platform === "darwin"
        ? "unsupported"
        : "supported";
    return support === expected;
  });
}
