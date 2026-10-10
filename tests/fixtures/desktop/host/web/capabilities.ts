import { NativeRegistry } from "@bunaway/protocol";
import { capabilitiesPlugin } from "@bunaway/plugin-capabilities";
import { logPlugin } from "@bunaway/plugin-log";
import { storagePlugin } from "@bunaway/plugin-storage";
import { windowsPlugin } from "@bunaway/plugin-windows";

const nativePlugins = new NativeRegistry([
  storagePlugin,
  logPlugin,
  capabilitiesPlugin,
  windowsPlugin,
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
    const { name, support, permission } = capability;
    if (!names.includes(name) || seen.has(name)) {
      return false;
    }
    seen.add(name);
    const expected =
      name.startsWith("windows.") && platform === "darwin"
        ? "unsupported"
        : "supported";
    return support === expected && permission === "not-required";
  });
}
